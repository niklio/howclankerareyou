// Analytics aggregation for the admin dashboard. Trend charts + headline stats
// are scoped to a time range (day/week/month/all); breakdowns stay all-time.
// Everything is derived from the product tables (sessions, answers, results,
// usage) plus the lightweight `events` table (pageviews, result-page opens,
// share taps). All bucketing is UTC.
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
const RANGES = new Set(['day', 'week', 'month', 'all']);

const dayExpr = (ms) => `strftime('%Y-%m-%d', ${ms}/1000, 'unixepoch')`;
const today = () => new Date().toISOString().slice(0, 10);

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
  const completed = await seriesQ(`SELECT ${bucket('created_at')} d, COUNT(*) n FROM results WHERE ${cond('created_at')} GROUP BY d`);
  const pageviews = await seriesQ(`SELECT ${bucket('ts')} d, COUNT(*) n FROM events WHERE type='pageview' AND ${cond('ts')} GROUP BY d`);
  const uniques = await seriesQ(`SELECT ${bucket('ts')} d, COUNT(DISTINCT visitor) n FROM events WHERE type='pageview' AND ${cond('ts')} GROUP BY d`);
  const resultViews = await seriesQ(`SELECT ${bucket('ts')} d, COUNT(*) n FROM events WHERE type='result_view' AND ${cond('ts')} GROUP BY d`);
  const shares = await seriesQ(`SELECT ${bucket('ts')} d, COUNT(*) n FROM events WHERE type='share' AND ${cond('ts')} GROUP BY d`);
  const calls = await seriesQ(`SELECT ${bucket('s.created_at')} d, SUM(steps) n FROM answers a JOIN sessions s ON a.session_id=s.id WHERE ${cond('s.created_at')} GROUP BY d`);

  const cbm = await q(`SELECT ${bucket('s.created_at')} d, model, SUM(steps) n FROM answers a JOIN sessions s ON a.session_id=s.id WHERE ${cond('s.created_at')} GROUP BY d, model`);
  const spendBy = {};
  for (const r of cbm) spendBy[r.d] = (spendBy[r.d] || 0) + r.n * (COST_PER_CALL[r.model] ?? DEFAULT_COST);
  const spendSeries = keys.map((k) => [k, Math.round((spendBy[k] || 0) * 1e6) / 1e6]);

  // --- headline (windowed sums) ---
  const totalStarted = sum(started);
  const totalCompleted = sum(completed);
  const totalShares = sum(shares);
  const totalResultViews = sum(resultViews);

  // --- breakdowns (all-time) ---
  const funnelRows = await q(`SELECT question_id, COUNT(DISTINCT session_id) n FROM answers GROUP BY question_id`);
  const funnelMap = Object.fromEntries(funnelRows.map((r) => [r.question_id, r.n]));
  const funnel = QUESTIONS.map((qq, i) => ({ step: i + 1, prompt: qq.prompt, sessions: funnelMap[qq.id] || 0 }));

  const qk = await q(`SELECT question_id, AVG(avg_kl) k FROM answers GROUP BY question_id`);
  const qkMap = Object.fromEntries(qk.map((r) => [r.question_id, r.k]));
  const questionClanker = QUESTIONS.filter((qq) => qkMap[qq.id] != null)
    .map((qq) => ({ prompt: qq.prompt, avgKl: Math.round(qkMap[qq.id] * 100) / 100 }))
    .sort((a, b) => a.avgKl - b.avgKl);

  const resultRows = await q(`SELECT overall, per_model FROM results`);
  const hist = Array.from({ length: 10 }, (_, i) => ({ bucket: `${i * 10}-${i * 10 + 10}`, count: 0 }));
  const modelCount = Object.fromEntries(MODELS.map((m) => [m.label, 0]));
  for (const r of resultRows) {
    hist[Math.min(9, Math.max(0, Math.floor(r.overall / 10)))].count++;
    try {
      const top = JSON.parse(r.per_model).sort((a, b) => b.score - a.score)[0];
      if (top && modelCount[top.label] != null) modelCount[top.label]++;
    } catch {}
  }
  const modelShare = Object.entries(modelCount).map(([label, count]) => ({ label, count }));
  const referrers = await q(
    `SELECT COALESCE(ref,'direct') ref, COUNT(*) n FROM events WHERE type='pageview' GROUP BY ref ORDER BY n DESC LIMIT 10`
  );

  // --- budget (operational: today's cap + month-to-date, range-independent) ---
  const monthStart = today().slice(0, 8) + '01';
  const mtdCallsRow = await q(`SELECT SUM(steps) n FROM answers a JOIN sessions s ON a.session_id=s.id WHERE ${dayExpr('s.created_at')} >= '${monthStart}'`);
  const mtdSpend = (await q(`SELECT model, SUM(steps) n FROM answers a JOIN sessions s ON a.session_id=s.id WHERE ${dayExpr('s.created_at')} >= '${monthStart}' GROUP BY model`)).reduce(
    (s, r) => s + r.n * (COST_PER_CALL[r.model] ?? DEFAULT_COST),
    0
  );
  const capRow = await q(`SELECT calls FROM usage WHERE day='${today()}'`);
  const cap = Number(env.DAILY_CALL_CAP || 0);

  return {
    updated: new Date().toISOString(),
    range,
    headline: {
      completedRuns: totalCompleted,
      completionRate: totalStarted ? Math.round((100 * totalCompleted) / totalStarted) : 0,
      shareRate: totalCompleted ? Math.round((100 * totalShares) / totalCompleted) : 0,
      kFactor: totalShares ? Math.round((100 * totalResultViews) / totalShares) / 100 : 0,
      spend: Math.round(sum(spendSeries) * 100) / 100,
    },
    plots: [
      { label: 'Diagnostics started', series: started },
      { label: 'Runs completed', series: completed },
      { label: 'Page views', series: pageviews },
      { label: 'Unique visitors', series: uniques },
      { label: 'Result-page opens', series: resultViews },
      { label: 'Share actions', series: shares },
      { label: 'Model API calls', series: calls },
      { label: 'Estimated spend ($)', series: spendSeries },
    ],
    funnel,
    scoreHistogram: hist,
    modelShare,
    questionClanker,
    referrers: referrers.map((r) => ({ ref: r.ref, count: r.n })),
    budget: {
      mtdCalls: mtdCallsRow[0]?.n || 0,
      mtdSpend: Math.round(mtdSpend * 100) / 100,
      dailyCap: cap,
      todayCalls: capRow[0]?.calls || 0,
      capPct: cap ? Math.round((100 * (capRow[0]?.calls || 0)) / cap) : 0,
    },
  };
}
