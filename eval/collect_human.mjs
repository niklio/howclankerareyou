// Collect brand-new human writing for the scorer eval.
//
// Two sources of demonstrably-fresh public text (created well after the
// scoring panel's training cutoffs, so it cannot be memorized):
//   1. reddit — subreddit comment RSS feeds discover active commenters, then
//      each author's user feed supplies their recent comments. Same public
//      RSS door and cleaning rules as src/reddit.js.
//   2. Hacker News — Algolia's public search API, newest comments grouped by
//      author.
// Authors are kept only with >= SAMPLES_PER_ACCOUNT qualifying comments so
// the analysis can also aggregate 5-sample pseudo-accounts, mirroring how
// production scores 5 posts per handle.
//
// Runs from the mini (residential IP), single-threaded, ~1.7s pacing.
// Output: eval/data/human.json (gitignored — public repo, we publish scores
// and permalinks, not a re-hosted corpus).

import { writeFileSync, mkdirSync } from 'fs';

const CUTOFF = Date.parse('2026-06-01T00:00:00Z'); // panel models trained well before this
const SAMPLES_PER_ACCOUNT = 5;
const REDDIT_ACCOUNTS_TARGET = 60;
const HN_ACCOUNTS_TARGET = 40;
const MIN_WORDS = 11; // production qualifying threshold (MIN_POST_WORDS)
const MAX_WORDS = 80;
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15';

const SUBS = [
  'AskReddit', 'CasualConversation', 'movies', 'nba', 'soccer', 'Cooking',
  'personalfinance', 'gaming', 'relationship_advice', 'books', 'cars',
  'Fitness', 'television', 'travel', 'AskUK', 'DIY',
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const wordCount = (s) => (s ? s.split(/\s+/).filter(Boolean).length : 0);

const unescapeXml = (s) =>
  String(s)
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, '&');

// Same rules as src/reddit.js commentText: drop quoted blocks, tags, urls.
function cleanHtml(escapedHtml) {
  let h = unescapeXml(escapedHtml);
  h = h.replace(/<blockquote>[\s\S]*?<\/blockquote>/g, ' ');
  h = h.replace(/<[^>]+>/g, ' ');
  h = unescapeXml(h);
  return h.replace(/https?:\/\/\S+/g, ' ').replace(/\s+/g, ' ').trim();
}

// Neutral quality filters only — nothing correlated with the scorer.
const STOPWORDS = ['the', 'and', 'that', 'have', 'for', 'not', 'with', 'you', 'this', 'but', 'was', 'are', 'they', 'what', 'just', 'like'];
function looksEnglish(text) {
  const letters = text.replace(/[^A-Za-z]/g, '').length;
  if (!letters || letters / text.replace(/\s/g, '').length < 0.6) return false;
  const lower = ' ' + text.toLowerCase() + ' ';
  return STOPWORDS.filter((w) => lower.includes(' ' + w + ' ')).length >= 2;
}
function qualifies(text) {
  const n = wordCount(text);
  return n >= MIN_WORDS && n <= MAX_WORDS && looksEnglish(text);
}
const botName = (a) => !a || /bot$|^auto|moderator|\[deleted\]/i.test(a);

let lastFetch = 0;
async function polite(url, minGapMs = 1700) {
  const wait = lastFetch + minGapMs - Date.now();
  if (wait > 0) await sleep(wait);
  lastFetch = Date.now();
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(url, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(20000) });
    if (res.status === 429) { await sleep(20000 * (attempt + 1)); continue; }
    if (!res.ok) return null;
    return res.text();
  }
  return null;
}

function parseAtomEntries(xml) {
  const out = [];
  for (const entry of xml.split('<entry>').slice(1)) {
    const author = entry.match(/<name>\/?u\/([^<]+)<\/name>/)?.[1] || entry.match(/<name>([^<]+)<\/name>/)?.[1];
    const published = entry.match(/<published>([^<]+)<\/published>/)?.[1] || entry.match(/<updated>([^<]+)<\/updated>/)?.[1];
    const content = entry.match(/<content[^>]*>([\s\S]*?)<\/content>/)?.[1] || '';
    const link = entry.match(/<link href="([^"]+)"/)?.[1] || '';
    out.push({ author, published, content, link });
  }
  return out;
}

async function collectReddit() {
  // Phase 1: discover active commenters from subreddit comment feeds.
  const candidates = [];
  const seen = new Set();
  for (const sub of SUBS) {
    const xml = await polite(`https://www.reddit.com/r/${sub}/comments.rss?limit=50`);
    if (!xml) { console.log(`  r/${sub}: fetch failed`); continue; }
    let n = 0;
    for (const e of parseAtomEntries(xml)) {
      if (botName(e.author) || seen.has(e.author)) continue;
      seen.add(e.author);
      candidates.push(e.author);
      n++;
    }
    console.log(`  r/${sub}: +${n} authors (total ${candidates.length})`);
  }

  // Phase 2: pull each author's own feed until enough full accounts.
  const accounts = [];
  for (const author of candidates) {
    if (accounts.length >= REDDIT_ACCOUNTS_TARGET) break;
    const xml = await polite(`https://www.reddit.com/user/${author}/comments.rss?limit=25`);
    if (!xml) continue;
    const samples = [];
    for (const e of parseAtomEntries(xml)) {
      const ts = Date.parse(e.published || '');
      if (!ts || ts < CUTOFF) continue;
      const text = cleanHtml(e.content);
      if (!qualifies(text)) continue;
      samples.push({ text, createdAt: new Date(ts).toISOString(), permalink: e.link });
      if (samples.length >= SAMPLES_PER_ACCOUNT) break;
    }
    if (samples.length >= SAMPLES_PER_ACCOUNT) {
      accounts.push({ source: 'reddit', account: 'u/' + author, samples });
      if (accounts.length % 10 === 0) console.log(`  reddit accounts: ${accounts.length}/${REDDIT_ACCOUNTS_TARGET}`);
    }
  }
  return accounts;
}

async function collectHN() {
  // Phase 1: newest comments → author frequency.
  const byAuthor = {};
  for (let page = 0; page < 6; page++) {
    const res = await fetch(`https://hn.algolia.com/api/v1/search_by_date?tags=comment&hitsPerPage=200&page=${page}`, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) break;
    const data = await res.json();
    for (const h of data.hits || []) {
      if (botName(h.author)) continue;
      (byAuthor[h.author] ||= 0);
      byAuthor[h.author]++;
    }
    await sleep(400);
  }
  const active = Object.entries(byAuthor).sort((a, b) => b[1] - a[1]).map(([a]) => a);

  // Phase 2: per-author recent comments.
  const accounts = [];
  for (const author of active) {
    if (accounts.length >= HN_ACCOUNTS_TARGET) break;
    const res = await fetch(
      `https://hn.algolia.com/api/v1/search_by_date?tags=comment,author_${encodeURIComponent(author)}&hitsPerPage=30&numericFilters=created_at_i>${Math.floor(CUTOFF / 1000)}`,
      { signal: AbortSignal.timeout(15000) }
    );
    await sleep(400);
    if (!res.ok) continue;
    const data = await res.json();
    const samples = [];
    for (const h of data.hits || []) {
      const text = cleanHtml(h.comment_text || '');
      if (!qualifies(text)) continue;
      samples.push({
        text,
        createdAt: new Date(h.created_at_i * 1000).toISOString(),
        permalink: `https://news.ycombinator.com/item?id=${h.objectID}`,
      });
      if (samples.length >= SAMPLES_PER_ACCOUNT) break;
    }
    if (samples.length >= SAMPLES_PER_ACCOUNT) {
      accounts.push({ source: 'hn', account: 'hn/' + author, samples });
      if (accounts.length % 10 === 0) console.log(`  hn accounts: ${accounts.length}/${HN_ACCOUNTS_TARGET}`);
    }
  }
  return accounts;
}

console.log('collecting reddit…');
const reddit = await collectReddit();
console.log('collecting hn…');
const hn = await collectHN();

const accounts = [...reddit, ...hn];
let id = 0;
const flat = [];
for (const a of accounts)
  for (const s of a.samples)
    flat.push({ id: 'h' + String(id++).padStart(4, '0'), label: 'human', source: a.source, account: a.account, ...s });

mkdirSync(new URL('./data/', import.meta.url), { recursive: true });
writeFileSync(new URL('./data/human.json', import.meta.url), JSON.stringify(flat, null, 1));
console.log(`DONE: ${accounts.length} accounts, ${flat.length} samples (reddit ${reddit.length * SAMPLES_PER_ACCOUNT}, hn ${hn.length * SAMPLES_PER_ACCOUNT})`);
console.log('earliest sample:', flat.reduce((m, s) => (s.createdAt < m ? s.createdAt : m), '9999'));
