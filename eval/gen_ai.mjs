// Generate the AI half of the eval set — LOCALLY (ollama), per the
// no-cloud-models-for-eval-content rule. The question the eval answers is
// "does the scorer separate typical LLM writing from fresh human writing",
// so models get a plain persona + a real, current thread title and write a
// comment in their default voice. (Adversarial "sound more human" prompting
// is a deliberately separate, harder condition — not this v1.)
//
// 100 pseudo-accounts × 5 comments = 500 samples, split across the local
// models. Each account = one (model, temperature, style) identity commenting
// on 5 different real threads, mirroring the human side's 5-per-author shape.
//
// Requires: ollama server on localhost:11434 (run under gpu-lock).
// Output: eval/data/ai.json

import { writeFileSync, mkdirSync } from 'fs';

const MODELS = [
  { id: 'gemma3:4b', accounts: 50 },
  { id: 'qwen2.5:7b', accounts: 50 },
];
const SAMPLES_PER_ACCOUNT = 5;
const MIN_WORDS = 11, MAX_WORDS = 80;
const OLLAMA = 'http://localhost:11434';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15';

const SUBS = [
  'AskReddit', 'CasualConversation', 'movies', 'nba', 'soccer', 'Cooking',
  'personalfinance', 'gaming', 'relationship_advice', 'books', 'cars',
  'Fitness', 'television', 'travel', 'AskUK', 'DIY',
];

// Light persona variation — the kind of instruction a casual user gives.
// Deliberately NOT "avoid AI tells / sound human" — that's the adversarial
// condition, out of scope here.
const STYLES = [
  'You are a regular reddit user replying in a thread.',
  'You are a friendly forum commenter.',
  'You comment on social threads in a casual voice.',
  'You are an internet user sharing your opinion in a comment section.',
];
const TEMPS = [0.7, 0.9, 1.1];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const wordCount = (s) => (s ? s.split(/\s+/).filter(Boolean).length : 0);

async function fetchTitles() {
  const titles = [];
  let last = 0;
  for (const sub of SUBS) {
    const wait = last + 1700 - Date.now();
    if (wait > 0) await sleep(wait);
    last = Date.now();
    try {
      const res = await fetch(`https://www.reddit.com/r/${sub}/.rss?limit=25`, {
        headers: { 'user-agent': UA }, signal: AbortSignal.timeout(20000),
      });
      if (!res.ok) continue;
      const xml = await res.text();
      for (const m of xml.matchAll(/<title>([^<]{15,140})<\/title>/g)) {
        const t = m[1].replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"');
        if (!/^\/?r\//.test(t)) titles.push({ venue: 'r/' + sub, title: t });
      }
    } catch {}
  }
  try {
    const res = await fetch('https://hn.algolia.com/api/v1/search_by_date?tags=story&hitsPerPage=100', { signal: AbortSignal.timeout(15000) });
    const data = await res.json();
    for (const h of data.hits || []) if (h.title && h.title.length >= 15) titles.push({ venue: 'HN', title: h.title });
  } catch {}
  return titles;
}

async function generate(model, temp, style, venue, title) {
  const prompt =
    `${style}\nThread on ${venue} titled: "${title}"\n` +
    `Write your comment replying to this thread. 20-60 words, plain text only, no quotes, no username, no markdown.`;
  const res = await fetch(`${OLLAMA}/api/generate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model, prompt, stream: false, options: { temperature: temp, num_predict: 120 } }),
    signal: AbortSignal.timeout(120000),
  });
  if (!res.ok) throw new Error(`ollama ${res.status}`);
  const data = await res.json();
  let text = (data.response || '').trim();
  text = text.replace(/^["'“]+|["'”]+$/g, '').replace(/\s+/g, ' ').trim();
  return text;
}

const titles = await fetchTitles();
console.log('fresh thread titles:', titles.length);
if (titles.length < 120) throw new Error('not enough titles');

// Shuffle titles deterministically enough (index hop) and deal 5 per account.
const shuffled = titles.sort(() => Math.random() - 0.5);
let cursor = 0;
const takeTitles = () => {
  const out = [];
  for (let i = 0; i < SAMPLES_PER_ACCOUNT; i++) out.push(shuffled[cursor++ % shuffled.length]);
  return out;
};

const flat = [];
let id = 0, acctN = 0;
for (const m of MODELS) {
  for (let a = 0; a < m.accounts; a++) {
    const style = STYLES[acctN % STYLES.length];
    const temp = TEMPS[acctN % TEMPS.length];
    const account = `ai/${m.id.replace(/[:.]/g, '-')}-${String(a).padStart(2, '0')}`;
    const picks = takeTitles();
    const samples = [];
    for (const pick of picks) {
      let text = null;
      for (let tries = 0; tries < 4 && !text; tries++) {
        try {
          const t = await generate(m.id, temp, style, pick.venue, pick.title);
          const n = wordCount(t);
          if (n >= MIN_WORDS && n <= MAX_WORDS && !/as an ai|language model/i.test(t)) text = t;
        } catch (e) { await sleep(1500); }
      }
      if (text) samples.push({ text, venue: pick.venue, title: pick.title });
    }
    for (const s of samples) {
      flat.push({
        id: 'a' + String(id++).padStart(4, '0'), label: 'ai', source: m.id,
        account, text: s.text, temp, venue: s.venue,
      });
    }
    acctN++;
    if (acctN % 10 === 0) console.log(`accounts done: ${acctN}, samples: ${flat.length}`);
  }
}

mkdirSync(new URL('./data/', import.meta.url), { recursive: true });
writeFileSync(new URL('./data/ai.json', import.meta.url), JSON.stringify(flat, null, 1));
console.log(`DONE: ${acctN} accounts, ${flat.length} samples`);
