// Sample the eval set from three public detection benchmarks on HF, via the
// datasets-server HTTP API (no bulk downloads, no auth):
//   RAID (liamdugan/raid)      — 11 generators × 8 domains; we take attack='none'
//   MAGE (yaful/MAGE)          — 27 LLMs × 7 tasks, test split
//   HC3  (Hello-SimpleAI/HC3)  — paired human/ChatGPT answers to the same questions
//
// ~500 human + ~500 AI per dataset. Texts are truncated to their LAST 120
// words (the scorer reads the last 8 words; everything before is conditioning
// context) and must clear production's ≥11-word qualifying bar.
//
// Output: eval/data/samples.json (gitignored — licenses allow redistribution
// but the repo doesn't need a corpus in it).

import { writeFileSync, mkdirSync } from 'fs';

const PER_CLASS = 500;
const MIN_WORDS = 11, TRUNC_WORDS = 120;
const BASE = 'https://datasets-server.huggingface.co';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const words = (s) => String(s).trim().split(/\s+/).filter(Boolean);

function prep(text) {
  const w = words(String(text).replace(/\s+/g, ' ').trim());
  if (w.length < MIN_WORDS) return null;
  return w.slice(-TRUNC_WORDS).join(' ');
}

let lastReq = 0;
async function api(path, params, retries = 5) {
  const wait = lastReq + 300 - Date.now();
  if (wait > 0) await sleep(wait);
  lastReq = Date.now();
  const url = `${BASE}/${path}?` + new URLSearchParams(params).toString();
  for (let a = 0; a <= retries; a++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
      const d = await res.json();
      if (d.error) throw new Error(d.error);
      return d;
    } catch (e) {
      if (a === retries) throw e;
      await sleep(3000 * (a + 1));
    }
  }
}

const out = [];
let idn = 0;
const push = (dataset, label, source, domain, text) => {
  out.push({ id: 'e' + String(idn++).padStart(4, '0'), dataset, label, source, domain, text });
};

// ---------- RAID ----------
// Balanced across generators via per-generator filters; human via its own.
const RAID_GENS = ['chatgpt', 'gpt4', 'gpt3', 'gpt2', 'mistral', 'mistral-chat', 'mpt', 'mpt-chat', 'llama-chat', 'cohere', 'cohere-chat'];
async function sampleRaid() {
  const ds = { dataset: 'liamdugan/raid', config: 'raid', split: 'train' };
  async function pull(where, want) {
    const first = await api('filter', { ...ds, where, length: 1 });
    const total = first.num_rows_total;
    const got = [];
    const seen = new Set();
    while (got.length < want && seen.size < Math.ceil(total / 100) + 1) {
      const off = Math.floor(Math.random() * Math.max(1, total - 100));
      const page = Math.floor(off / 100);
      if (seen.has(page)) continue;
      seen.add(page);
      const d = await api('filter', { ...ds, where, offset: page * 100, length: 100 });
      for (const r of d.rows) {
        const t = prep(r.row.generation);
        if (t) got.push({ t, domain: r.row.domain, model: r.row.model });
        if (got.length >= want) break;
      }
    }
    return got;
  }
  console.log('RAID human…');
  for (const s of await pull(`"model"='human' AND "attack"='none'`, PER_CLASS)) push('raid', 'human', 'human', s.domain, s.t);
  const per = Math.ceil(PER_CLASS / RAID_GENS.length);
  for (const gen of RAID_GENS) {
    console.log(`RAID ${gen}…`);
    try {
      for (const s of await pull(`"model"='${gen}' AND "attack"='none'`, per)) push('raid', 'ai', gen, s.domain, s.t);
    } catch (e) { console.log(`  skip ${gen}: ${e.message}`); }
  }
}

// ---------- MAGE ----------
async function sampleMage() {
  const ds = { dataset: 'yaful/MAGE', config: 'default', split: 'test' };
  const size = await api('size', { dataset: ds.dataset, config: ds.config });
  const total = size.size.splits.find((s) => s.split === 'test').num_rows;
  console.log('MAGE test rows:', total);
  const want = { human: PER_CLASS, ai: PER_CLASS };
  const got = { human: 0, ai: 0 };
  const seen = new Set();
  while ((got.human < want.human || got.ai < want.ai) && seen.size < total / 100) {
    const page = Math.floor(Math.random() * Math.floor(total / 100));
    if (seen.has(page)) continue;
    seen.add(page);
    const d = await api('rows', { ...ds, offset: page * 100, length: 100 });
    for (const r of d.rows) {
      const label = String(r.row.label) === '1' ? 'human' : 'ai';
      if (got[label] >= want[label]) continue;
      const t = prep(r.row.text);
      if (!t) continue;
      const src = String(r.row.src || '');
      const domain = src.split('_')[0];
      const source = label === 'human' ? 'human' : (src.match(/_(machine|continuation|topical|specified)_(.+)$/)?.[2] || src);
      push('mage', label, source, domain, t);
      got[label]++;
    }
    if (seen.size % 10 === 0) console.log(`  mage: human ${got.human}, ai ${got.ai}`);
  }
}

// ---------- HC3 ----------
async function sampleHC3() {
  const ds = { dataset: 'Hello-SimpleAI/HC3', config: 'all', split: 'train' };
  const size = await api('size', { dataset: ds.dataset, config: ds.config });
  const total = size.size.splits.find((s) => s.split === 'train').num_rows;
  console.log('HC3 rows:', total);
  let pairs = 0;
  const seen = new Set();
  while (pairs < PER_CLASS && seen.size < total / 100) {
    const page = Math.floor(Math.random() * Math.floor(total / 100));
    if (seen.has(page)) continue;
    seen.add(page);
    const d = await api('rows', { ...ds, offset: page * 100, length: 100 });
    for (const r of d.rows) {
      if (pairs >= PER_CLASS) break;
      const h = prep(r.row.human_answers?.[0]);
      const a = prep(r.row.chatgpt_answers?.[0]);
      if (!h || !a) continue;
      push('hc3', 'human', 'human', r.row.source, h);
      push('hc3', 'ai', 'chatgpt', r.row.source, a);
      pairs++;
    }
    if (seen.size % 10 === 0) console.log(`  hc3 pairs: ${pairs}`);
  }
}

await sampleRaid();
await sampleMage();
await sampleHC3();

mkdirSync(new URL('./data/', import.meta.url), { recursive: true });
writeFileSync(new URL('./data/samples.json', import.meta.url), JSON.stringify(out, null, 1));
const c = {};
for (const s of out) c[s.dataset + '/' + s.label] = (c[s.dataset + '/' + s.label] || 0) + 1;
console.log('DONE', c);
