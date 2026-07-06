// Turn raw eval scores into the published results JSON for /eval.
//
// Per-sample scoring uses the exact production math: per-model calibrated
// score from the sample's last-8-words surprisal, overall = nearest model.
// Per-dataset ROC-AUC is rank-based (Mann-Whitney; ties half). CIs are
// bootstraps over samples (HC3 pairs resample together, keyed by pair).
// A "simulated account" condition groups 5 random same-class samples and
// aggregates them exactly as production aggregates 5 posts — what the site
// would show for an account whose posts look like this set.
// No sample text is published.

import { readFileSync, writeFileSync } from 'fs';
import { TEXT_MODELS, clankerScoreText } from '../src/scoring.js';

const dataUrl = (f) => new URL('./data/' + f, import.meta.url);
const samples = JSON.parse(readFileSync(dataUrl('samples.json'), 'utf8'));
const scores = JSON.parse(readFileSync(dataUrl('scores.json'), 'utf8'));

function sampleRow(s) {
  const per = {};
  const modelScores = [];
  for (const m of TEXT_MODELS) {
    const r = scores[s.id]?.[m.id];
    if (!r) continue;
    per[m.id] = { avgKL: r.avgKL, steps: r.steps, score: clankerScoreText(r.avgKL, m.d0text) };
    modelScores.push(per[m.id].score);
  }
  if (!modelScores.length) return null;
  return { ...s, text: undefined, per, overall: Math.max(...modelScores) };
}
const rows = samples.map(sampleRow).filter(Boolean);

function auc(pos, neg) {
  const all = [...pos.map((v) => [v, 1]), ...neg.map((v) => [v, 0])].sort((a, b) => a[0] - b[0]);
  let rank = 1, i = 0, sumPosRanks = 0;
  while (i < all.length) {
    let j = i;
    while (j < all.length && all[j][0] === all[i][0]) j++;
    const avgRank = (rank + rank + (j - i) - 1) / 2;
    for (let k = i; k < j; k++) if (all[k][1]) sumPosRanks += avgRank;
    rank += j - i;
    i = j;
  }
  return (sumPosRanks - (pos.length * (pos.length + 1)) / 2) / (pos.length * neg.length);
}

function bootstrapCI(list, iters = 2000) {
  const stats = [];
  for (let it = 0; it < iters; it++) {
    const pos = [], neg = [];
    for (let k = 0; k < list.length; k++) {
      const r = list[Math.floor(Math.random() * list.length)];
      (r.label === 'ai' ? pos : neg).push(r.overall);
    }
    if (pos.length && neg.length) stats.push(auc(pos, neg));
  }
  stats.sort((a, b) => a - b);
  return [stats[Math.floor(0.025 * stats.length)], stats[Math.floor(0.975 * stats.length)]];
}

function rocPoints(pos, neg) {
  const pts = [];
  for (let t = 100.5; t >= -0.5; t -= 0.5)
    pts.push({ fpr: neg.filter((v) => v >= t).length / neg.length, tpr: pos.filter((v) => v >= t).length / pos.length });
  return pts;
}

const hist = (vals) => {
  const h = Array(10).fill(0);
  for (const v of vals) h[Math.min(9, Math.floor(v / 10))]++;
  return h;
};

// Simulated production accounts: 5 random same-class samples, token-weighted
// per-model aggregation, overall = nearest model — repeated into pseudo rows.
function simulateAccounts(list, nAccounts = 200) {
  const rowsOut = [];
  for (const label of ['ai', 'human']) {
    const pool = list.filter((r) => r.label === label);
    for (let a = 0; a < nAccounts; a++) {
      const picks = Array.from({ length: 5 }, () => pool[Math.floor(Math.random() * pool.length)]);
      const modelScores = [];
      for (const m of TEXT_MODELS) {
        let sumSurpr = 0, sumTok = 0;
        for (const p of picks) {
          const r = p.per[m.id];
          if (!r) continue;
          sumSurpr += r.avgKL * r.steps;
          sumTok += r.steps;
        }
        if (sumTok) modelScores.push(clankerScoreText(sumSurpr / sumTok, m.d0text));
      }
      if (modelScores.length) rowsOut.push({ label, overall: Math.max(...modelScores) });
    }
  }
  return rowsOut;
}

const datasets = {};
for (const ds of ['raid', 'mage', 'hc3']) {
  const list = rows.filter((r) => r.dataset === ds);
  const pos = list.filter((r) => r.label === 'ai').map((r) => r.overall);
  const neg = list.filter((r) => r.label === 'human').map((r) => r.overall);
  if (!pos.length || !neg.length) continue;
  const sim = simulateAccounts(list);
  const simPos = sim.filter((r) => r.label === 'ai').map((r) => r.overall);
  const simNeg = sim.filter((r) => r.label === 'human').map((r) => r.overall);

  const byGen = {};
  for (const src of [...new Set(list.filter((r) => r.label === 'ai').map((r) => r.source))]) {
    const own = list.filter((r) => r.source === src).map((r) => r.overall);
    byGen[src] = { n: own.length, auc: auc(own, neg) };
  }
  const byDomain = {};
  for (const dom of [...new Set(list.map((r) => r.domain))]) {
    const p = list.filter((r) => r.domain === dom && r.label === 'ai').map((r) => r.overall);
    const n = list.filter((r) => r.domain === dom && r.label === 'human').map((r) => r.overall);
    if (p.length >= 10 && n.length >= 10) byDomain[dom] = { nAi: p.length, nHuman: n.length, auc: auc(p, n) };
  }
  const perModelAuc = TEXT_MODELS.map((m) => {
    const p = list.filter((r) => r.label === 'ai' && r.per[m.id]).map((r) => r.per[m.id].score);
    const n = list.filter((r) => r.label === 'human' && r.per[m.id]).map((r) => r.per[m.id].score);
    return { model: m.label, auc: p.length && n.length ? auc(p, n) : null };
  });

  datasets[ds] = {
    n: list.length, ai: pos.length, human: neg.length,
    auc: auc(pos, neg), ci: bootstrapCI(list),
    aucSimAccount: auc(simPos, simNeg),
    roc: rocPoints(pos, neg),
    hist: { ai: hist(pos), human: hist(neg) },
    medians: { ai: pos.sort((a, b) => a - b)[Math.floor(pos.length / 2)], human: neg.sort((a, b) => a - b)[Math.floor(neg.length / 2)] },
    byGen, byDomain, perModelAuc,
  };
}

// pooled
const posAll = rows.filter((r) => r.label === 'ai').map((r) => r.overall);
const negAll = rows.filter((r) => r.label === 'human').map((r) => r.overall);

const results = {
  generated: new Date().toISOString(),
  counts: { samples: rows.length, ai: posAll.length, human: negAll.length,
    failed: samples.length - rows.length },
  pooled: { auc: auc(posAll, negAll), ci: bootstrapCI(rows) },
  datasets,
};

writeFileSync(new URL('../public/eval-data.json', import.meta.url), JSON.stringify(results, null, 1));
console.log('pooled AUC:', results.pooled.auc.toFixed(4));
for (const [ds, d] of Object.entries(datasets))
  console.log(`${ds}: AUC ${d.auc.toFixed(4)} CI [${d.ci.map((x) => x.toFixed(3))}] · sim-account ${d.aucSimAccount.toFixed(4)} · medians ai ${d.medians.ai} human ${d.medians.human}`);
