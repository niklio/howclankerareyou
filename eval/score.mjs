// Score every eval sample through the REAL production scorer: this imports
// scorePostEcho from src/scoring.js (not a reimplementation), so the eval
// measures exactly what howclankerareyou.com ships — same endpoint, same
// token→word rollup, same last-8-words window, same panel.
//
// ~1000 samples × 3 models ≈ 3000 echo calls ≈ $0.03 on the HF PRO credit.
// Resumable: results append to eval/data/scores.json keyed by sample id;
// re-running skips already-scored (sample, model) pairs.
//
// Usage: HF_TOKEN=... node score.mjs   (or it reads ~/disobedience-bench/secrets/hf.key)

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { homedir } from 'os';
import { scorePostEcho, TEXT_MODELS } from '../src/scoring.js';

const WINDOW = 8; // GRID_COLS — production scores each post's last 8 words
const CONCURRENCY = 4;
const dataUrl = (f) => new URL('./data/' + f, import.meta.url);

const env = {
  HF_TOKEN: process.env.HF_TOKEN || readFileSync(homedir() + '/disobedience-bench/secrets/hf.key', 'utf8').trim(),
  MOCK_INFERENCE: '0',
};

const samples = JSON.parse(readFileSync(dataUrl('samples.json'), 'utf8'));
const scores = existsSync(dataUrl('scores.json')) ? JSON.parse(readFileSync(dataUrl('scores.json'), 'utf8')) : {};

const jobs = [];
for (const s of samples)
  for (const m of TEXT_MODELS)
    if (scores[s.id]?.[m.id] === undefined) jobs.push({ s, m });
console.log(`samples: ${samples.length} · jobs to run: ${jobs.length} (of ${samples.length * TEXT_MODELS.length})`);

let done = 0, failed = 0;
const save = () => writeFileSync(dataUrl('scores.json'), JSON.stringify(scores));

async function worker(queue) {
  for (;;) {
    const job = queue.shift();
    if (!job) return;
    const { s, m } = job;
    const r = await scorePostEcho(env, m, s.text, WINDOW);
    (scores[s.id] ||= {})[m.id] = r ? { avgKL: r.avgKL, steps: r.steps } : null;
    if (!r) failed++;
    done++;
    if (done % 50 === 0) { save(); console.log(`  ${done}/${jobs.length} (${failed} failed)`); }
    await new Promise((r2) => setTimeout(r2, 120)); // gentle ramp, deepinfra 429s under walls
  }
}

const queue = [...jobs];
await Promise.all(Array.from({ length: CONCURRENCY }, () => worker(queue)));
save();

const nullCount = Object.values(scores).flatMap((o) => Object.values(o)).filter((v) => v === null).length;
console.log(`DONE: ${done} scored this run, ${failed} failed this run, ${nullCount} null total`);
