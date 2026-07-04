// Reddit source for the diagnose flow, via KeyAPI (api.keyapi.ai) — the only
// scraper we found with a per-user comments endpoint (audited 2026-07-04:
// ~1.3-1.7s, 1 credit/request, clean failure modes). Key lives in the
// KEYAPI_KEY secret. Comments are the material (richer voice than link
// posts); one call covers the common case.

const BASE = 'https://api.keyapi.ai/v1/reddit';

// Accept "u/name" or "/u/name" (case-insensitive prefix). Reddit usernames
// are 3-20 chars of [A-Za-z0-9_-]. Returns the bare name or null.
export function parseRedditor(input) {
  if (!input) return null;
  const m = String(input).trim().match(/^\/?u\/([A-Za-z0-9_-]{3,20})$/i);
  return m ? m[1] : null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(env, path, params, retries = 2) {
  const url = new URL(`${BASE}/${path}`);
  for (const [k, v] of Object.entries(params || {})) url.searchParams.set(k, v);
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${env.KEYAPI_KEY}` },
        signal: AbortSignal.timeout(20_000),
      });
      const data = await res.json().catch(() => null);
      if (res.ok && data && data.code === 0) return data;
      lastErr = new Error(data?.message || `keyapi ${res.status}`);
      // Auth/credit problems aren't transient — don't burn retries.
      if ([401, 402, 403].includes(res.status)) throw lastErr;
    } catch (err) {
      lastErr = err;
      if (/keyapi 40[123]/.test(String(err.message))) throw err;
    }
    if (attempt < retries) await sleep(500 * (attempt + 1));
  }
  throw lastErr || new Error('keyapi request failed');
}

// The `preview` field truncates long comments mid-word at ~300 chars with no
// ellipsis. Our 45-word cap usually discards the clipped tail, but long-worded
// comments can clip below 45 words — so when the raw text length smells like
// the cap, drop the (possibly partial) final word before capping.
const CLIP_SUSPECT_CHARS = 280;

// Strip urls and markdown furniture that isn't the author's voice: quote
// markers, link syntax (keep the label), emphasis asterisks. Entities decoded.
function clean(text) {
  return String(text || '')
    .replace(/^\s*&gt;.*$/gm, ' ') // quoted lines are someone else's words
    .replace(/^\s*>.*$/gm, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/[*_]{1,3}([^*_]+)[*_]{1,3}/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

const wordCount = (s) => (s ? s.split(/\s+/).filter(Boolean).length : 0);

// Fetch a redditor's most recent comments and clean them into scoreable
// samples. Returns { user, samples, counts } like the X source; user is null
// when the account doesn't exist (KeyAPI answers redditorInfoByName: null).
export async function redditSamples(env, name, opts = {}) {
  const { maxItems = 5, minWords = 11, maxWordsPerItem = 45 } = opts;
  const data = await api(env, 'fetch_user_comments', {
    username: name,
    sort: 'NEW',
    page_size: 40,
  });
  const redditor = data.data?.redditorInfoByName;
  if (!redditor) return { user: null, samples: [], counts: { fetched: 0, kept: 0, words: 0, pages: 1 } };

  const edges = redditor.comments?.edges || [];
  const samples = [];
  let words = 0;
  for (const e of edges) {
    const node = e?.node;
    if (!node) continue;
    const raw = node.content?.preview || '';
    let text = clean(raw);
    // Truncation guard: preview clips mid-word with no marker.
    if (raw.length >= CLIP_SUSPECT_CHARS) {
      text = text.split(/\s+/).slice(0, -1).join(' ');
    }
    const wc = wordCount(text);
    if (wc < minWords) continue;
    if (wc > maxWordsPerItem) text = text.split(/\s+/).slice(0, maxWordsPerItem).join(' ');
    const kept = wordCount(text);
    samples.push({
      id: node.id || `c${samples.length}`,
      text,
      words: kept,
      subreddit: node.postInfo?.subreddit?.prefixedName || null,
    });
    words += kept;
    if (samples.length >= maxItems) break;
  }

  const handle = redditor.comments?.edges?.[0]?.node?.authorInfo?.displayName || name;
  return {
    user: { handle, name: `u/${handle}`, platform: 'reddit' },
    samples,
    counts: { fetched: edges.length, kept: samples.length, words, pages: 1 },
  };
}
