// Reddit source for the diagnose flow — via Reddit's own public RSS feeds
// (user comment feeds are intentionally public for feed readers; we identify
// ourselves honestly in the UA). Zero vendors, zero keys: ~350ms from Workers
// egress, full comment text, 25 newest comments per fetch. Shared Workers IPs
// occasionally see per-IP 429s, absorbed by retry+backoff and the 1-week
// result cache. (A KeyAPI-based version of this module lived here briefly —
// see git history — but their cheapest tier didn't fit a free toy.)

const UA = 'howclankerareyou/1.0 rss reader (https://howclankerareyou.com)';

// Accept "u/name" or "/u/name" (case-insensitive prefix). Reddit usernames
// are 3-20 chars of [A-Za-z0-9_-]. Returns the bare name or null.
export function parseRedditor(input) {
  if (!input) return null;
  const m = String(input).trim().match(/^\/?u\/([A-Za-z0-9_-]{3,20})$/i);
  return m ? m[1] : null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fail(code, message) {
  const e = new Error(message || code);
  e.code = code;
  return e;
}

// Fetch a user's comment feed. 404 = no such user (definitive, no retry);
// 403 = suspended/withheld (treated as not found — nothing to grade either
// way); 429 = per-IP throttle, retried with backoff.
async function fetchFeed(name, retries = 3) {
  const url = `https://www.reddit.com/user/${name}/comments.rss`;
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { 'user-agent': UA },
        signal: AbortSignal.timeout(15_000),
      });
      if (res.status === 404 || res.status === 403) return null;
      if (res.ok) return await res.text();
      lastErr = new Error(`reddit rss ${res.status}`);
    } catch (err) {
      lastErr = err;
    }
    if (attempt < retries) await sleep(700 * 2 ** attempt + Math.random() * 300);
  }
  throw lastErr || fail('upstream', 'reddit feed unavailable');
}

const unescapeXml = (s) =>
  String(s)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, '&');

// Atom entry HTML → the author's plain words: unescape the feed's escaped
// HTML, drop quoted blocks (someone else's words), strip tags/urls/markdown
// leftovers, collapse whitespace.
function commentText(escapedHtml) {
  let h = unescapeXml(escapedHtml);
  h = h.replace(/<blockquote>[\s\S]*?<\/blockquote>/g, ' ');
  h = h.replace(/<[^>]+>/g, ' ');
  h = unescapeXml(h); // entities inside the comment body itself
  return h
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const wordCount = (s) => (s ? s.split(/\s+/).filter(Boolean).length : 0);

// Fetch a redditor's most recent comments and clean them into scoreable
// samples. Same interface as the X source: { user, samples, counts }; user is
// null when the account doesn't exist (or is suspended — nothing to grade).
export async function redditSamples(env, name, opts = {}) {
  const { maxItems = 5, minWords = 11, maxWordsPerItem = 45 } = opts;
  const xml = await fetchFeed(name);
  if (xml == null) return { user: null, samples: [], counts: { fetched: 0, kept: 0, words: 0, pages: 1 } };

  const entries = xml.split('<entry>').slice(1);
  // Canonical username casing from the first entry's author.
  const author = (xml.match(/<name>\/u\/([A-Za-z0-9_-]+)<\/name>/) || [])[1] || name;

  const samples = [];
  let words = 0;
  for (const entry of entries) {
    const id = (entry.match(/<id>([^<]+)<\/id>/) || [])[1] || `c${samples.length}`;
    const content = (entry.match(/<content type="html">([\s\S]*?)<\/content>/) || [])[1];
    if (!content) continue;
    let text = commentText(content);
    const wc = wordCount(text);
    if (wc < minWords) continue;
    if (wc > maxWordsPerItem) text = text.split(/\s+/).slice(0, maxWordsPerItem).join(' ');
    const kept = wordCount(text);
    samples.push({ id, text, words: kept });
    words += kept;
    if (samples.length >= maxItems) break;
  }

  return {
    user: { handle: author, name: `u/${author}`, platform: 'reddit' },
    samples,
    counts: { fetched: entries.length, kept: samples.length, words, pages: 1 },
  };
}
