// Analytics aggregation for the admin dashboard. Everything is derived from the
// product tables (sessions, answers, results, usage) plus the lightweight
// `events` table (pageviews, result-page opens, share taps).
import { QUESTIONS } from './questions.js';
import { MODELS } from './scoring.js';

// Estimated cost per model API call: measured avg input tokens × provider
// input rate + 1 output token × output rate (USD). Provider rates pulled from
// the HF router; see README. Used for the spend/budget graphs.
const COST_PER_CALL = {
  'meta-llama/Llama-3.1-8B-Instruct:nscale': 82 * 0.06e-6 + 0.06e-6,
  'deepseek-ai/DeepSeek-V3-0324:novita': 48 * 0.27e-6 + 1.12e-6,
  'Qwen/Qwen3-235B-A22B-Instruct-2507:nscale': 60 * 0.2e-6 + 0.6e-6,
};
const DEFAULT_COST = 1.1e-5;

const day = (msExpr) => `strftime('%Y-%m-%d', ${msExpr}/1000, 'unixepoch')`;
const today = () => new Date().toISOString().slice(0, 10);

function daysBetween(start, end) {
  const out = [];
  const d = new Date(start + 'T00:00:00Z');
  const e = new Date(end + 'T00:00:00Z');
  while (d <= e) {
    out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

const fill = (rows, days, key = 'n') => {
  const m = Object.fromEntries(rows.map((r) => [r.d, r[key]]));
  return days.map((d) => [d, m[d] || 0]);
};

export async function gatherAnalytics(env) {
  const q = async (sql) => (await env.DB.prepare(sql).all()).results || [];

  const started = await q(`SELECT ${day('created_at')} d, COUNT(*) n FROM sessions GROUP BY d`);
  const completed = await q(`SELECT ${day('created_at')} d, COUNT(*) n FROM results GROUP BY d`);
  const pageviews = await q(`SELECT day d, COUNT(*) n FROM events WHERE type='pageview' GROUP BY d`);
  const uniques = await q(`SELECT day d, COUNT(DISTINCT visitor) n FROM events WHERE type='pageview' GROUP BY d`);
  const resultViews = await q(`SELECT day d, COUNT(*) n FROM events WHERE type='result_view' GROUP BY d`);
  const shares = await q(`SELECT day d, COUNT(*) n FROM events WHERE type='share' GROUP BY d`);
  const calls = await q(`SELECT ${day('created_at')} d, SUM(steps) n FROM answers a JOIN sessions s ON a.session_id=s.id GROUP BY d`);
  const callsByModelDay = await q(`SELECT ${day('created_at')} d, model, SUM(steps) n FROM answers a JOIN sessions s ON a.session_id=s.id GROUP BY d, model`);

  // Date window: earliest activity → today (UTC), zero-filled.
  const allDays = [started, completed, pageviews].flat().map((r) => r.d).filter(Boolean);
  const start = allDays.length ? allDays.sort()[0] : today();
  const days = daysBetween(start, today());

  // Spend per day = Σ per-model calls × cost/call.
  const spendByDay = {};
  for (const r of callsByModelDay) {
    spendByDay[r.d] = (spendByDay[r.d] || 0) + r.n * (COST_PER_CALL[r.model] ?? DEFAULT_COST);
  }
  const spendSeries = days.map((d) => [d, Math.round((spendByDay[d] || 0) * 1e6) / 1e6]);

  // Funnel: how many sessions reach each question (in prompt order).
  const funnelRows = await q(`SELECT question_id, COUNT(DISTINCT session_id) n FROM answers GROUP BY question_id`);
  const funnelMap = Object.fromEntries(funnelRows.map((r) => [r.question_id, r.n]));
  const funnel = QUESTIONS.map((qq, i) => ({ step: i + 1, prompt: qq.prompt, sessions: funnelMap[qq.id] || 0 }));

  // Per-question clanker-ness (mean surprisal; lower = more clanker).
  const qk = await q(`SELECT question_id, AVG(avg_kl) k, COUNT(*) n FROM answers GROUP BY question_id`);
  const qkMap = Object.fromEntries(qk.map((r) => [r.question_id, r.k]));
  const questionClanker = QUESTIONS.filter((qq) => qkMap[qq.id] != null)
    .map((qq) => ({ prompt: qq.prompt, avgKl: Math.round(qkMap[qq.id] * 100) / 100 }))
    .sort((a, b) => a.avgKl - b.avgKl);

  // Score distribution + "inner clanker" model share, from finished results.
  const resultRows = await q(`SELECT overall, per_model FROM results`);
  const hist = Array.from({ length: 10 }, (_, i) => ({ bucket: `${i * 10}-${i * 10 + 10}`, count: 0 }));
  const modelCount = Object.fromEntries(MODELS.map((m) => [m.label, 0]));
  for (const r of resultRows) {
    const b = Math.min(9, Math.max(0, Math.floor(r.overall / 10)));
    hist[b].count++;
    try {
      const pm = JSON.parse(r.per_model);
      const top = pm.sort((a, b) => b.score - a.score)[0];
      if (top && modelCount[top.label] != null) modelCount[top.label]++;
    } catch {}
  }
  const modelShare = Object.entries(modelCount).map(([label, count]) => ({ label, count }));

  // Referrers (pageviews with a known source).
  const referrers = await q(
    `SELECT COALESCE(ref,'direct') ref, COUNT(*) n FROM events WHERE type='pageview' GROUP BY ref ORDER BY n DESC LIMIT 10`
  );

  // Budget: month-to-date model calls + spend, vs the daily cap.
  const monthStart = today().slice(0, 8) + '01';
  const mtdCallsRow = await q(
    `SELECT SUM(steps) n FROM answers a JOIN sessions s ON a.session_id=s.id WHERE ${day('created_at')} >= '${monthStart}'`
  );
  const mtdSpend = Object.entries(
    (await q(
      `SELECT model, SUM(steps) n FROM answers a JOIN sessions s ON a.session_id=s.id WHERE ${day('created_at')} >= '${monthStart}' GROUP BY model`
    )).reduce((acc, r) => ((acc[r.model] = r.n), acc), {})
  ).reduce((s, [m, n]) => s + n * (COST_PER_CALL[m] ?? DEFAULT_COST), 0);
  const capRow = await q(`SELECT calls FROM usage WHERE day='${today()}'`);
  const cap = Number(env.DAILY_CALL_CAP || 0);

  const totalStarted = started.reduce((s, r) => s + r.n, 0);
  const totalCompleted = completed.reduce((s, r) => s + r.n, 0);
  const totalShares = shares.reduce((s, r) => s + r.n, 0);
  const totalResultViews = resultViews.reduce((s, r) => s + r.n, 0);

  return {
    updated: new Date().toISOString(),
    headline: {
      completedRuns: totalCompleted,
      completionRate: totalStarted ? Math.round((100 * totalCompleted) / totalStarted) : 0,
      shareRate: totalCompleted ? Math.round((100 * totalShares) / totalCompleted) : 0,
      kFactor: totalShares ? Math.round((100 * totalResultViews) / totalShares) / 100 : 0,
      mtdSpend: Math.round(mtdSpend * 100) / 100,
    },
    plots: [
      { label: 'Diagnostics started', series: fill(started, days) },
      { label: 'Runs completed', series: fill(completed, days) },
      { label: 'Page views', series: fill(pageviews, days) },
      { label: 'Unique visitors', series: fill(uniques, days) },
      { label: 'Result-page opens (shares landing)', series: fill(resultViews, days) },
      { label: 'Share actions', series: fill(shares, days) },
      { label: 'Model API calls', series: fill(calls, days) },
      { label: 'Estimated spend ($/day)', series: spendSeries },
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
