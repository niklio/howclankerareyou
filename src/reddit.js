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

// Circuit breaker: after reddit's bot defense blocks us once, this isolate
// fails fast for a minute instead of adding heat to an already-hostile
// window (per-isolate is fine — every isolate learns within one request).
let blockedUntil = 0;

// Fetch a user's feed (comments|submitted) with the protection stack and a
// weatherproof fallback:
//   1. 10-min edge cache — retries and repeat lookups never re-hit reddit
//   2. global ceiling (REDDIT_RL) — caps total fetch volume AND Zyte spend
//   3. direct fetch first (free); reddit throttles Cloudflare's shared
//      egress IPs in windows ("weather"), so when the direct path is blocked
//      (breaker open, bot-defense 403, retries exhausted, 5xx) we fall back
//      to the Zyte API, which fetches through its own clean pool (~1s,
//      pennies per call, only ever pays during windows)
//   Set REDDIT_VIA_ZYTE=1 to force Zyte-primary (testing / flipping).
// 404 = no such user (null); plain 403 = suspended (null).
async function fetchFeed(env, name, kind = 'comments', retries = 2) {
  const url = `https://www.reddit.com/user/${name.toLowerCase()}/${kind}.rss`;

  const cached = await caches.default.match(url).catch(() => null);
  if (cached) return cached.text();

  if (env?.REDDIT_RL) {
    const { success } = await env.REDDIT_RL.limit({ key: 'reddit' });
    if (!success) throw fail('upstream', 'reddit fetch budget exhausted');
  }

  let res = null; // { status, body } with reddit's own status
  const zytePrimary = env?.ZYTE_KEY && env?.REDDIT_VIA_ZYTE === '1';
  if (!zytePrimary) res = await directGet(url, retries).catch(() => null);
  if (res && ![200, 403, 404].includes(res.status)) res = null; // 5xx etc → try the fallback
  if (!res && env?.ZYTE_KEY) res = await zyteGet(env, url).catch(() => null);
  if (!res) throw fail('upstream', 'reddit feed unavailable');

  if (res.status === 404 || res.status === 403) return null;
  if (res.status !== 200) throw fail('upstream', `reddit rss ${res.status}`);
  // Cache positives so retries/repeats are free for 10 minutes.
  try {
    await caches.default.put(
      url,
      new Response(res.body, { headers: { 'cache-control': 'public, s-maxage=600', 'content-type': 'application/atom+xml' } })
    );
  } catch {}
  return res.body;
}

// Direct fetch from Workers egress. Bot-defense 403s (HTML block pages) set
// the breaker and throw immediately — retrying them is pure heat; a plain
// 403 is account state (suspended) and passes through. 429s retry gently.
async function directGet(url, retries = 2) {
  if (Date.now() < blockedUntil) throw fail('upstream', 'reddit cooling down');
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { 'user-agent': UA },
        signal: AbortSignal.timeout(15_000),
      });
      if (res.status === 403) {
        const body = await res.text();
        if (/theme-beta|network security|blocked|<html/i.test(body.slice(0, 500))) {
          blockedUntil = Date.now() + 60_000;
          throw fail('blocked', 'reddit bot-defense window');
        }
        return { status: 403, body };
      }
      if (res.status !== 429) return { status: res.status, body: await res.text() };
      lastErr = new Error('reddit rss 429');
    } catch (err) {
      if (err.code === 'blocked') throw err;
      lastErr = err;
    }
    if (attempt < retries) await sleep(900 * 2 ** attempt + Math.random() * 300);
  }
  throw lastErr || fail('upstream', 'reddit feed unavailable');
}

// Fetch through the Zyte API's pool: upstream status + base64 body come back
// in JSON. UTF-8 decoded properly (comments are full of emoji).
async function zyteGet(env, url) {
  const res = await fetch('https://api.zyte.com/v1/extract', {
    method: 'POST',
    headers: {
      authorization: 'Basic ' + btoa(env.ZYTE_KEY + ':'),
      'content-type': 'application/json',
    },
    body: JSON.stringify({ url, httpResponseBody: true }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`zyte ${res.status}`);
  const data = await res.json();
  const bytes = data.httpResponseBody
    ? Uint8Array.from(atob(data.httpResponseBody), (c) => c.charCodeAt(0))
    : new Uint8Array();
  return { status: data.statusCode, body: new TextDecoder('utf-8').decode(bytes) };
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

// Empty-comments disambiguator: does the account have any public POSTS?
// (about.json is bot-blocked; submitted.rss isn't.) Comments-empty + posts-
// present usually means the profile hides comment history — a setting the
// account owner can flip (observed in the wild: they do, then retry).
// Runs through the same cache/limiter/breaker stack as the comments feed.
export async function probeSubmitted(env, name) {
  try {
    const xml = await fetchFeed(env, name, 'submitted', 0);
    if (xml == null) return null;
    return xml.split('<entry>').length - 1;
  } catch {
    return null; // unknown — caller falls back to the generic message
  }
}

// Fetch a redditor's most recent comments and clean them into scoreable
// samples. Same interface as the X source: { user, samples, counts }; user is
// null when the account doesn't exist (or is suspended — nothing to grade).
export async function redditSamples(env, name, opts = {}) {
  const { maxItems = 5, minWords = 11, maxWordsPerItem = 45 } = opts;
  const xml = await fetchFeed(env, name);
  if (xml == null) return { user: null, samples: [], counts: { fetched: 0, kept: 0, words: 0, pages: 1 } };

  const entries = xml.split('<entry>').slice(1);
  // Canonical username casing from the first entry's author.
  const author = (xml.match(/<name>\/u\/([A-Za-z0-9_-]+)<\/name>/) || [])[1] || name;

  const samples = [];
  const raw = []; // every cleaned comment, any length (fallback material)
  let words = 0;
  for (const entry of entries) {
    const id = (entry.match(/<id>([^<]+)<\/id>/) || [])[1] || `c${samples.length}`;
    const content = (entry.match(/<content type="html">([\s\S]*?)<\/content>/) || [])[1];
    if (!content) continue;
    let text = commentText(content);
    const wc = wordCount(text);
    if (wc >= 2) raw.push(text);
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
    raw,
    counts: { fetched: entries.length, kept: samples.length, words, pages: 1 },
  };
}
