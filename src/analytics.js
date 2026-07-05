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
  const resultViews = await seriesQ(`SELECT ${bucket('ts')} d, COUNT(*) n FROM events WHERE type='result_view' AND ${cond('ts')} GROUP BY d`);
  const rateLimited = await seriesQ(`SELECT ${bucket('ts')} d, COUNT(*) n FROM events WHERE type='ratelimited' AND ${cond('ts')} GROUP BY d`);
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

  // --- windowed sums ---
  const totalStarted = sum(started);
  const totalCompleted = sum(completed);
  const totalShares = sum(shares);
  const totalDiagAttempts = sum(diagAttempts);
  const totalDiagSuccess = sum(diagSuccess);
  const plays = keys.map((k, i) => [k, diagSuccess[i][1] + completed[i][1]]);
  const totalPlays = totalDiagSuccess + totalCompleted;
  // Visits = homepage loads + share-page opens; play flavors split off dRows.
  const visits = keys.map((k, i) => [k, pageviews[i][1] + resultViews[i][1]]);
  const xPlays = fillK(aggCount(dRows, (r) => r.outcome === 'success' && r.plat !== 'reddit'));
  const redditPlays = fillK(aggCount(dRows, (r) => r.outcome === 'success' && r.plat === 'reddit'));

  // --- uniques + first-touch attribution (one windowed event pull) ---------
  // DISTINCT doesn't sum across buckets (one visitor active in 6 hourly
  // buckets would count 6× in the day view but ~1× in the week view), so
  // per-bucket sets chart the shape and window-wide sets give the totals.
  // First-touch attribution: a visitor whose earliest visit event in the
  // window is a result_view arrived via a share link; everyone else — incl.
  // players with no visit event at all — counts as homepage.
  // json_extract throws on non-JSON meta (result_view stores a bare key),
  // so only reach into meta on diagnose rows.
  const evRows = await q(
    `SELECT ts, type, visitor,
            CASE WHEN type='diagnose' THEN ${dOut('outcome')} END o
     FROM events
     WHERE type IN ('pageview','result_view','diagnose','selftest') AND ${cond('ts')}`
  );
  const bkey =
    range === 'day'
      ? (ms) => new Date(ms).toISOString().slice(0, 13).replace('T', ' ')
      : (ms) => new Date(ms).toISOString().slice(0, 10);
  const isPlayEv = (e) => e.type === 'selftest' || (e.type === 'diagnose' && e.o === 'success');
  const uvB = {}, upB = {}, uvAll = new Set(), first = {};
  for (const e of evRows) {
    if (!e.visitor) continue;
    if (e.type === 'pageview' || e.type === 'result_view') {
      (uvB[bkey(e.ts)] ||= new Set()).add(e.visitor);
      uvAll.add(e.visitor);
      if (!first[e.visitor] || e.ts < first[e.visitor].ts) first[e.visitor] = { ts: e.ts, type: e.type };
    } else if (isPlayEv(e)) {
      (upB[bkey(e.ts)] ||= new Set()).add(e.visitor);
    }
  }
  const uniqueVisits = keys.map((k) => [k, uvB[k]?.size || 0]);
  const totalUniqueVisits = uvAll.size;
  const pfsB = {}, pfhB = {};
  const shareVisitors = new Set(), homeVisitors = new Set(), sharePlayers = new Set(), homePlayers = new Set();
  for (const v of Object.keys(first)) (first[v].type === 'result_view' ? shareVisitors : homeVisitors).add(v);
  for (const e of evRows) {
    if (!isPlayEv(e) || !e.visitor) continue;
    if (first[e.visitor]?.type === 'result_view') {
      pfsB[bkey(e.ts)] = (pfsB[bkey(e.ts)] || 0) + 1;
      sharePlayers.add(e.visitor);
    } else {
      pfhB[bkey(e.ts)] = (pfhB[bkey(e.ts)] || 0) + 1;
      homePlayers.add(e.visitor);
      homeVisitors.add(e.visitor);
    }
  }
  const playsFromShare = keys.map((k) => [k, pfsB[k] || 0]);
  const playsFromHome = keys.map((k) => [k, pfhB[k] || 0]);
  // play-through = % of that source's distinct visitors who went on to play.
  const ptShare = shareVisitors.size ? Math.round((100 * sharePlayers.size) / shareVisitors.size) : 0;
  const ptHome = homeVisitors.size ? Math.round((100 * homePlayers.size) / homeVisitors.size) : 0;

  // Unique players (DAU on the day view): distinct visitors who produced a
  // result — diagnose successes + self-test finishes, both visitor-hashed
  // events. Self-test events only exist from the first `selftest` row onward;
  // self plays before that boundary (results rows) are added NON-unique
  // rather than vanishing. The boundary is self-maintaining: every finish
  // after the logging deploy writes both a results row and an event.
  const selfLogStart = (await q(`SELECT MIN(ts) m FROM events WHERE type='selftest'`))[0]?.m;
  const playerRow = await q(
    `SELECT COUNT(DISTINCT visitor) n FROM events
     WHERE ((type='diagnose' AND ${dOut('outcome')}='success') OR type='selftest') AND ${cond('ts')}`
  );
  const preLogSelf = await seriesQ(
    `SELECT ${bucket('created_at')} d, COUNT(*) n FROM results WHERE ${SELF_COND}
     AND created_at < ${selfLogStart ?? Number.MAX_SAFE_INTEGER} AND ${cond('created_at')} GROUP BY d`
  );
  const totalPlayers = (playerRow[0]?.n || 0) + sum(preLogSelf);
  const uniquePlays = keys.map((k, i) => [k, (upB[k]?.size || 0) + preLogSelf[i][1]]);

  // Top share links: which /r/ pages actually pull visitors in (windowed).
  const topShareLinks = (
    await q(
      `SELECT meta k, COUNT(*) n FROM events
       WHERE type='result_view' AND meta IS NOT NULL AND ${cond('ts')}
       GROUP BY k ORDER BY n DESC LIMIT 10`
    )
  ).map((r) => ({ link: '/r/' + r.k, opens: r.n }));

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
    `SELECT COALESCE(ref,'direct') ref, COUNT(*) n FROM events WHERE type='pageview' AND ${cond('ts')} GROUP BY ref ORDER BY n DESC LIMIT 10`
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
    // Top bar: audience size and how hard the players play. Ratios are per
    // unique player (DAU on the day view) — immune to lurker inflation.
    topbar: {
      uniqueVisits: totalUniqueVisits,
      dau: totalPlayers,
      plays: totalPlays,
      shares: totalShares,
      playsPerDau: totalPlayers ? Math.round((100 * totalPlays) / totalPlayers) / 100 : 0,
      sharesPerDau: totalPlayers ? Math.round((100 * totalShares) / totalPlayers) / 100 : 0,
    },
    acquisition: {
      plots: [
        { label: 'Unique visits', series: uniqueVisits, total: totalUniqueVisits },
        { label: 'Visits', series: visits },
        { label: 'Homepage visits', series: pageviews },
        { label: 'Share page visits', series: resultViews },
      ],
      referrers: referrers.map((r) => ({ ref: r.ref, count: r.n })),
      topShareLinks,
    },
    engagement: {
      plots: [
        { label: 'Unique plays', series: uniquePlays, total: totalPlayers },
        { label: 'Total plays', series: plays },
        { label: 'Twitter plays', series: xPlays },
        { label: 'Reddit plays', series: redditPlays },
        { label: 'Self plays', series: completed },
        { label: 'Plays from share page', series: playsFromShare, note: ptShare + '% play-through' },
        { label: 'Plays from homepage', series: playsFromHome, note: ptHome + '% play-through' },
      ],
    },
    health: {
      diagnoseSuccessRate: totalDiagAttempts
        ? Math.round((100 * totalDiagSuccess) / totalDiagAttempts)
        : 100,
      selfCompletionRate: totalStarted ? Math.round((100 * totalCompleted) / totalStarted) : 0,
      spend: Math.round(sum(spendSeries) * 100) / 100,
      plots: [
        { label: 'Diagnose latency p50 (ms)', series: latP50 },
        { label: 'Diagnose latency p90 (ms)', series: latP90 },
        { label: 'Upstream failures', series: diagUpstream },
        { label: 'Diagnoses (attempts)', series: diagAttempts },
        { label: 'Rate-limited requests', series: rateLimited },
        { label: 'Estimated spend ($)', series: spendSeries },
      ],
      outcomes: outcomeRows.map((r) => ({ outcome: r.o || 'unknown', count: r.n })),
      budget: {
        mtdCalls: mtdCallsRow[0]?.n || 0,
        mtdSpend: Math.round(mtdSpend * 100) / 100,
        dailyCap: cap,
        todayCalls: capRow[0]?.calls || 0,
        capPct: cap ? Math.round((100 * (capRow[0]?.calls || 0)) / cap) : 0,
        twitterPagesToday: twRow[0]?.n || 0,
      },
    },
    details: {
      recentEntries,
      topHandles,
      scoreHistogram: hist,
      modelShare,
      questionClanker,
      funnel,
    },
  };
}
