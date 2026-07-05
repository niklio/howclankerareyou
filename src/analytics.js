// Analytics aggregation for the admin dashboard. Trend charts + headline stats
// are scoped to a time range (day/week/month/all); breakdowns stay all-time.
// Everything is derived from the product tables (sessions, answers, results,
// usage) plus the lightweight `events` table (pageviews, result-page opens,
// share taps, and one `diagnose` event per account-diagnosis attempt with
// outcome/timings/cost in its meta JSON). All bucketing is UTC. All queries
// are additive over the original schema — old rows are never migrated.
import { QUESTIONS } from './questions.js';
import { MODELS } from './scoring.js';

// Estimated cost per model API call: measured avg input tokens × provider
// input rate + 1 output token × output rate (USD). Rates from the HF router.
const COST_PER_CALL = {
  'meta-llama/Llama-3.1-8B-Instruct:nscale': 82 * 0.06e-6 + 0.06e-6,
  'deepseek-ai/DeepSeek-V3-0324:novita': 48 * 0.27e-6 + 1.12e-6,
  'Qwen/Qwen3-235B-A22B-Instruct-2507:nscale': 60 * 0.2e-6 + 0.6e-6,
};
const DEFAULT_COST = 1.1e-5;
// A fresh diagnosis = 15 echo calls (3 on the thin fallback), ~60 prompt
// tokens each at Qwen-235B-class rates, + `pages` twitterapi search calls for
// X (reddit's RSS is free). Cached hits cost 0.
const ECHO_CALL_COST = 60 * 0.13e-6;
const TWITTERAPI_PAGE_COST = 20 * 0.15e-3; // $0.15/1k tweets, 20 tweets/page
const RANGES = new Set(['day', 'week', 'month', 'all']);
// results-table population filters (old self-test rows predate subject_type).
const SELF_COND = `(subject_type IS NULL OR subject_type = 'self')`;
const ACCT_COND = `subject_type = 'account'`;

const dayExpr = (ms) => `strftime('%Y-%m-%d', ${ms}/1000, 'unixepoch')`;
const today = () => new Date().toISOString().slice(0, 10);

// json_extract returns 0/1 for JSON booleans (and null for missing).
const truthy = (v) => v === 1 || v === '1' || v === true;
// Roll pre-fetched rows (bucketed as r.d) into {d, n} pairs for fillK.
function aggCount(rows, pred) {
  const m = {};
  for (const r of rows) if (pred(r)) m[r.d] = (m[r.d] || 0) + 1;
  return Object.entries(m).map(([d, n]) => ({ d, n }));
}

// Bucket keys + the SQL bucket expression and window condition for a range.
// day → 24 hourly buckets over the last 24h; else → daily buckets.
function buildBuckets(range, earliestMs) {
  const now = Date.now();
  if (range === 'day') {
    const startMs = now - 24 * 3600 * 1000;
    const keys = [];
    for (let i = 23; i >= 0; i--) keys.push(new Date(now - i * 3600 * 1000).toISOString().slice(0, 13).replace('T', ' '));
    return { keys, bucket: (m) => `strftime('%Y-%m-%d %H', ${m}/1000, 'unixepoch')`, cond: (m) => `${m} >= ${startMs}` };
  }
  const startMs =
    range === 'week' ? now - 6 * 86400 * 1000 : range === 'month' ? now - 29 * 86400 * 1000 : earliestMs;
  const keys = [];
  const start = new Date(new Date(startMs).toISOString().slice(0, 10) + 'T00:00:00Z');
  const end = new Date(today() + 'T00:00:00Z');
  for (const d = start; d <= end; d.setUTCDate(d.getUTCDate() + 1)) keys.push(d.toISOString().slice(0, 10));
  return { keys, bucket: dayExpr, cond: range === 'all' ? () => '1' : (m) => `${m} >= ${startMs}` };
}

export async function gatherAnalytics(env, range = 'week') {
  if (!RANGES.has(range)) range = 'week';
  const q = async (sql) => (await env.DB.prepare(sql).all()).results || [];

  let earliestMs = Date.now();
  if (range === 'all') {
    const e = await q(
      `SELECT MIN(m) m FROM (SELECT MIN(created_at) m FROM sessions UNION SELECT MIN(ts) m FROM events)`
    );
    earliestMs = e[0]?.m || Date.now();
  }
  const { keys, bucket, cond } = buildBuckets(range, earliestMs);
  const fillK = (rows) => {
    const m = Object.fromEntries(rows.map((r) => [r.d, r.n]));
    return keys.map((k) => [k, m[k] || 0]);
  };
  const seriesQ = async (sql) => fillK(await q(sql));
  const sum = (s) => s.reduce((a, p) => a + p[1], 0);

  // --- windowed trend series ---
  const started = await seriesQ(`SELECT ${bucket('created_at')} d, COUNT(*) n FROM sessions WHERE ${cond('created_at')} GROUP BY d`);
  const completed = await seriesQ(`SELECT ${bucket('created_at')} d, COUNT(*) n FROM results WHERE ${SELF_COND} AND ${cond('created_at')} GROUP BY d`);
  const pageviews = await seriesQ(`SELECT ${bucket('ts')} d, COUNT(*) n FROM events WHERE type='pageview' AND ${cond('ts')} GROUP BY d`);
  const uniques = await seriesQ(`SELECT ${bucket('ts')} d, COUNT(DISTINCT visitor) n FROM events WHERE type='pageview' AND ${cond('ts')} GROUP BY d`);
  const resultViews = await seriesQ(`SELECT ${bucket('ts')} d, COUNT(*) n FROM events WHERE type='result_view' AND ${cond('ts')} GROUP BY d`);
  const shares = await seriesQ(`SELECT ${bucket('ts')} d, COUNT(*) n FROM events WHERE type='share' AND ${cond('ts')} GROUP BY d`);
  const calls = await seriesQ(`SELECT ${bucket('s.created_at')} d, SUM(steps) n FROM answers a JOIN sessions s ON a.session_id=s.id WHERE ${cond('s.created_at')} GROUP BY d`);

  const cbm = await q(`SELECT ${bucket('s.created_at')} d, model, SUM(steps) n FROM answers a JOIN sessions s ON a.session_id=s.id WHERE ${cond('s.created_at')} GROUP BY d, model`);
  const spendBy = {};
  for (const r of cbm) spendBy[r.d] = (spendBy[r.d] || 0) + r.n * (COST_PER_CALL[r.model] ?? DEFAULT_COST);

  // --- diagnose flow (from `diagnose` events; meta is JSON) ---
  const dOut = (p) => `json_extract(meta,'$.${p}')`;
  const dRows = await q(
    `SELECT ${bucket('ts')} d, ${dOut('outcome')} outcome, ${dOut('cached')} cached,
            ${dOut('msTotal')} ms, ${dOut('pages')} pages,
            ${dOut('platform')} plat, ${dOut('cause')} cause
     FROM events WHERE type='diagnose' AND ${cond('ts')}`
  );
  const diagAttempts = fillK(aggCount(dRows, () => true));
  const diagSuccess = fillK(aggCount(dRows, (r) => r.outcome === 'success'));
  const diagCachedN = dRows.filter((r) => r.outcome === 'success' && truthy(r.cached)).length;
  const diagFreshN = dRows.filter((r) => r.outcome === 'success' && !truthy(r.cached)).length;
  const diagUpstream = fillK(aggCount(dRows, (r) => r.outcome === 'upstream'));
  // Latency percentiles per bucket (fresh successes only — cache hits are
  // trivially fast and would flatter the chart).
  const latP50 = [], latP90 = [];
  {
    const byBucket = {};
    for (const r of dRows)
      if (r.outcome === 'success' && !truthy(r.cached) && r.ms != null)
        (byBucket[r.d] ||= []).push(Number(r.ms));
    for (const k of keys) {
      const v = (byBucket[k] || []).sort((a, b) => a - b);
      latP50.push([k, v.length ? Math.round(v[Math.floor(0.5 * (v.length - 1))]) : 0]);
      latP90.push([k, v.length ? Math.round(v[Math.floor(0.9 * (v.length - 1))]) : 0]);
    }
  }
  // Diagnose spend: fresh diagnoses × echo cost + twitterapi pages. Added to
  // the same per-bucket spend map as the self-test calls.
  for (const r of dRows) {
    if (truthy(r.cached)) continue;
    let c = 0;
    if (r.outcome === 'success') c += (r.cause === 'fallback' ? 3 : 15) * ECHO_CALL_COST;
    if (r.plat !== 'reddit') c += (Number(r.pages) || 0) * TWITTERAPI_PAGE_COST;
    if (c) spendBy[r.d] = (spendBy[r.d] || 0) + c;
  }
  const spendSeries = keys.map((k) => [k, Math.round((spendBy[k] || 0) * 1e6) / 1e6]);

  // --- the loop (windowed sums) ---
  // One viral loop, two flavors of "play": diagnosing an account and taking
  // the self-test both produce a shareable result. visitors → plays → shares
  // → share opens → replays (result-page CTA clicks back into a new play).
  const totalStarted = sum(started);
  const totalCompleted = sum(completed);
  const totalShares = sum(shares);
  const totalResultViews = sum(resultViews);
  const totalDiagAttempts = sum(diagAttempts);
  const totalDiagSuccess = sum(diagSuccess);
  // DISTINCT doesn't sum across buckets (one visitor active in 6 hourly
  // buckets would count 6× in the day view but ~1× in the week view — the
  // classic "day > week" artifact). The true total is one DISTINCT over the
  // whole window; the per-bucket series stays for the chart shape only.
  const uqRow = await q(
    `SELECT COUNT(DISTINCT visitor) n FROM events WHERE type='pageview' AND ${cond('ts')}`
  );
  const totalUniques = uqRow[0]?.n || 0;
  // Unique players (the DAU metric on the day view): distinct visitors who
  // produced a result — diagnose successes + self-test finishes, both
  // visitor-hashed events. Self-test events only exist from the first
  // `selftest` row onward; self plays before that boundary (results rows)
  // are added NON-unique rather than vanishing. The boundary is
  // self-maintaining: every finish after the logging deploy writes both a
  // results row and an event, so nothing is double-counted.
  const selfLogStart = (await q(`SELECT MIN(ts) m FROM events WHERE type='selftest'`))[0]?.m;
  const playerRow = await q(
    `SELECT COUNT(DISTINCT visitor) n FROM events
     WHERE ((type='diagnose' AND ${dOut('outcome')}='success') OR type='selftest') AND ${cond('ts')}`
  );
  const preLogSelfRow = await q(
    `SELECT COUNT(*) n FROM results WHERE ${SELF_COND}
     AND created_at < ${selfLogStart ?? Number.MAX_SAFE_INTEGER} AND ${cond('created_at')}`
  );
  const totalPlayers = (playerRow[0]?.n || 0) + (preLogSelfRow[0]?.n || 0);
  const plays = keys.map((k, i) => [k, diagSuccess[i][1] + completed[i][1]]);
  const totalPlays = totalDiagSuccess + totalCompleted;
  const replayRows = await q(
    `SELECT COUNT(*) n FROM events WHERE type='cta' AND ${cond('ts')}`
  );
  const totalReplays = replayRows[0]?.n || 0;
  const playRate = totalUniques ? totalPlays / totalUniques : 0;
  const shareRate = totalPlays ? totalShares / totalPlays : 0;
  const opensPerShare = totalShares ? totalResultViews / totalShares : 0;
  // Estimated viral coefficient: new plays a play generates via sharing.
  // K = P(share) × opens per share × P(opened → plays). >1 = self-sustaining.
  const kViral = shareRate * opensPerShare * playRate;

  // --- breakdowns (all-time) ---
  const funnelRows = await q(`SELECT question_id, COUNT(DISTINCT session_id) n FROM answers GROUP BY question_id`);
  const funnelMap = Object.fromEntries(funnelRows.map((r) => [r.question_id, r.n]));
  const funnel = QUESTIONS.map((qq, i) => ({ step: i + 1, prompt: qq.prompt, sessions: funnelMap[qq.id] || 0 }));

  const qk = await q(`SELECT question_id, AVG(avg_kl) k FROM answers GROUP BY question_id`);
  const qkMap = Object.fromEntries(qk.map((r) => [r.question_id, r.k]));
  const questionClanker = QUESTIONS.filter((qq) => qkMap[qq.id] != null)
    .map((qq) => ({ prompt: qq.prompt, avgKl: Math.round(qkMap[qq.id] * 100) / 100 }))
    .sort((a, b) => a.avgKl - b.avgKl);

  // One score distribution across all results — a play is a play in the loop
  // view. (Populations are calibrated separately but land on the same 0-100
  // scale; the play-mix card carries the flavor split.)
  const resultRows = await q(`SELECT overall, per_model, subject_type, subject_platform FROM results`);
  const hist = Array.from({ length: 10 }, (_, i) => ({ bucket: `${i * 10}-${i * 10 + 10}`, count: 0 }));
  const modelCount = Object.fromEntries(MODELS.map((m) => [m.label, 0]));
  let allTimeAccountsX = 0, allTimeAccountsReddit = 0, allTimeSelf = 0;
  for (const r of resultRows) {
    hist[Math.min(9, Math.max(0, Math.floor(r.overall / 10)))].count++;
    if (r.subject_type === 'account') {
      if (r.subject_platform === 'reddit') allTimeAccountsReddit++;
      else allTimeAccountsX++;
      continue; // inner-clanker is a self-test stat
    }
    allTimeSelf++;
    try {
      const top = JSON.parse(r.per_model).sort((a, b) => b.score - a.score)[0];
      if (top && modelCount[top.label] != null) modelCount[top.label]++;
    } catch {}
  }
  const modelShare = Object.entries(modelCount).map(([label, count]) => ({ label, count }));
  const referrers = await q(
    `SELECT COALESCE(ref,'direct') ref, COUNT(*) n FROM events WHERE type='pageview' GROUP BY ref ORDER BY n DESC LIMIT 10`
  );

  // Diagnose outcome mix (all-time) + most-diagnosed handles. Lookup counts
  // come from events (includes cache hits); each handle's score is its latest
  // stored result (may be gone if opted out — shown without a score then).
  // thin splits by its stored sub-cause (no-posts = handle miss/dormant,
  // not-english, too-short, placeholder); rows predating the cause field —
  // or whose backfill probe failed — show as 'thin · unclassified'.
  const outcomeRows = await q(
    `SELECT (CASE
       WHEN ${dOut('outcome')}='thin' THEN 'thin · ' || COALESCE(${dOut('cause')}, 'unclassified')
       WHEN ${dOut('outcome')}='success' AND ${dOut('cause')}='fallback' THEN 'success · thin-fallback'
       ELSE ${dOut('outcome')} END) o, COUNT(*) n
     FROM events WHERE type='diagnose' GROUP BY o ORDER BY n DESC`
  );
  const topHandleRows = await q(
    `SELECT ${dOut('handle')} h, COUNT(*) n FROM events
     WHERE type='diagnose' AND ${dOut('outcome')}='success' AND ${dOut('handle')} IS NOT NULL
     GROUP BY h ORDER BY n DESC LIMIT 10`
  );
  const scoreByHandle = {};
  for (const r of await q(
    `SELECT (CASE WHEN COALESCE(subject_platform,'x')='reddit'
       THEN 'u/' || lower(subject_handle) ELSE lower(subject_handle) END) h, overall
     FROM results WHERE ${ACCT_COND} ORDER BY created_at ASC`
  ))
    scoreByHandle[r.h] = r.overall; // ASC → last write wins = latest score
  const topHandles = topHandleRows.map((r) => ({
    handle: r.h,
    lookups: r.n,
    score: scoreByHandle[r.h] ?? null,
  }));

  // Live feed: the most recent names ENTERED — every lookup (fresh, cached,
  // failed), newest first. Event handles are already u/-prefixed for reddit;
  // scores join from the latest stored result where a grade exists.
  const recentEntries = (
    await q(
      `SELECT ${dOut('handle')} h, ${dOut('outcome')} o, ${dOut('cached')} c, ts t
       FROM events WHERE type='diagnose' AND ${dOut('handle')} IS NOT NULL
       ORDER BY ts DESC LIMIT 15`
    )
  ).map((r) => ({
    handle: r.h,
    outcome: r.o,
    cached: truthy(r.c),
    overall: r.o === 'success' ? scoreByHandle[r.h] ?? null : null,
    at: r.t,
  }));

  // Viral-loop CTA clicks (all-time).
  const ctaRows = await q(`SELECT meta, COUNT(*) n FROM events WHERE type='cta' GROUP BY meta`);
  const cta = Object.fromEntries(ctaRows.map((r) => [r.meta, r.n]));


  // --- budget (operational: today's cap + month-to-date, range-independent) ---
  const monthStart = today().slice(0, 8) + '01';
  const mtdCallsRow = await q(`SELECT SUM(steps) n FROM answers a JOIN sessions s ON a.session_id=s.id WHERE ${dayExpr('s.created_at')} >= '${monthStart}'`);
  const mtdSpend = (await q(`SELECT model, SUM(steps) n FROM answers a JOIN sessions s ON a.session_id=s.id WHERE ${dayExpr('s.created_at')} >= '${monthStart}' GROUP BY model`)).reduce(
    (s, r) => s + r.n * (COST_PER_CALL[r.model] ?? DEFAULT_COST),
    0
  );
  const capRow = await q(`SELECT calls FROM usage WHERE day='${today()}'`);
  const cap = Number(env.DAILY_CALL_CAP || 0);
  // twitterapi credit-burn proxy: search pages fetched today (no balance API).
  const twStart = new Date(today() + 'T00:00:00Z').getTime();
  const twRow = await q(
    `SELECT SUM(${dOut('pages')}) n FROM events WHERE type='diagnose' AND ts >= ${twStart}`
  );

  return {
    updated: new Date().toISOString(),
    range,
    headline: {
      kViral: Math.round(kViral * 100) / 100,
      plays: totalPlays,
      playsAccount: totalDiagSuccess,
      playsSelf: totalCompleted,
      playRate: Math.round(100 * playRate),
      shareRate: Math.round(100 * shareRate),
      opensPerShare: Math.round(100 * opensPerShare) / 100,
      spend: Math.round(sum(spendSeries) * 100) / 100,
    },
    // The loop, as a funnel (windowed).
    loop: [
      { stage: 'unique visitors', n: totalUniques },
      { stage: 'unique players', n: totalPlayers },
      { stage: 'plays (result created)', n: totalPlays },
      { stage: 'shares', n: totalShares },
      { stage: 'share-link opens', n: totalResultViews },
      { stage: 'replays (CTA back in)', n: totalReplays },
    ],
    plots: [
      { label: 'Plays', series: plays },
      { label: 'Unique visitors', series: uniques, total: totalUniques },
      { label: 'Share actions', series: shares },
      { label: 'Share-link opens', series: resultViews },
    ],
    healthPlots: [
      { label: 'Diagnose latency p50 (ms)', series: latP50 },
      { label: 'Diagnose latency p90 (ms)', series: latP90 },
      { label: 'Upstream failures', series: diagUpstream },
      { label: 'Diagnoses (attempts)', series: diagAttempts },
      { label: 'Page views', series: pageviews },
      { label: 'Estimated spend ($)', series: spendSeries },
    ],
    playMix: [
      { label: 'diagnose an X account', count: allTimeAccountsX },
      { label: 'diagnose a redditor', count: allTimeAccountsReddit },
      { label: 'self-test', count: allTimeSelf },
    ],
    diagnoseSuccessRate: totalDiagAttempts
      ? Math.round((100 * totalDiagSuccess) / totalDiagAttempts)
      : 100,
    selfCompletionRate: totalStarted ? Math.round((100 * totalCompleted) / totalStarted) : 0,
    funnel,
    scoreHistogram: hist,
    outcomes: outcomeRows.map((r) => ({ outcome: r.o || 'unknown', count: r.n })),
    recentEntries,
    topHandles,
    cta,
    modelShare,
    questionClanker,
    referrers: referrers.map((r) => ({ ref: r.ref, count: r.n })),
    budget: {
      mtdCalls: mtdCallsRow[0]?.n || 0,
      mtdSpend: Math.round(mtdSpend * 100) / 100,
      dailyCap: cap,
      todayCalls: capRow[0]?.calls || 0,
      capPct: cap ? Math.round((100 * (capRow[0]?.calls || 0)) / cap) : 0,
      twitterPagesToday: twRow[0]?.n || 0,
    },
  };
}
