// Source module for the "diagnose an X account" feature. Resolves a handle or
// X link to a user, pulls their recent original posts, and cleans them into
// scoreable text. Everything goes through twitterapi.io (a third-party X
// scraper) via api(), which retries transient failures. The key lives in the
// TWITTERAPI_KEY secret.

const BASE = 'https://api.twitterapi.io';

// Reserved X paths that look like handles but aren't accounts.
const RESERVED = new Set([
  'home', 'explore', 'search', 'notifications', 'messages', 'settings',
  'i', 'compose', 'hashtag', 'intent', 'share', 'login', 'signup',
]);

// Accept "@handle", "handle", or an x.com / twitter.com profile or status URL.
// X handles are 1–15 chars of [A-Za-z0-9_]. Returns the bare handle (original
// case preserved for display; the API is case-insensitive) or null if the input
// isn't a plausible handle.
export function parseHandle(input) {
  if (!input) return null;
  const s = String(input).trim();

  const urlMatch = s.match(
    /^(?:https?:\/\/)?(?:www\.|mobile\.)?(?:x\.com|twitter\.com)\/(?:#!\/)?@?([A-Za-z0-9_]{1,15})(?:[/?#]|$)/i
  );
  if (urlMatch) {
    const h = urlMatch[1];
    return RESERVED.has(h.toLowerCase()) ? null : h;
  }

  const bare = s.replace(/^@/, '');
  if (/^[A-Za-z0-9_]{1,15}$/.test(bare) && !RESERVED.has(bare.toLowerCase())) return bare;
  return null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// twitterapi.io enforces a strict per-key QPS limit and returns HTTP 429
// ({error, message}) when calls arrive faster than ~1 every 2s. It also
// occasionally returns an empty body transiently. We back off generously
// (longer on a 429) and retry before giving up. Throws on exhaustion.
async function api(env, path, params, retries = 4) {
  const url = new URL(BASE + path);
  for (const [k, v] of Object.entries(params || {})) {
    if (v != null && v !== '') url.searchParams.set(k, v);
  }
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    let throttled = false;
    try {
      const res = await fetch(url, {
        headers: { 'X-API-Key': env.TWITTERAPI_KEY },
        signal: AbortSignal.timeout(20_000),
      });
      throttled = res.status === 429;
      const data = await res.json().catch(() => null);
      // Success shape: { status:'success', code, msg, data, has_next_page,
      // next_cursor }. Throttle/error shape: { error, message }.
      if (!throttled && data && (data.status === 'success' || data.data)) return data;
      lastErr = new Error(data?.message || data?.msg || `twitterapi ${res.status}`);
      // 402 = out of credits, 401/403 = bad key. Retrying can't fix these;
      // bail so the user gets a fast error instead of a 10s retry dance.
      if ([401, 402, 403].includes(res.status)) throw lastErr;
    } catch (err) {
      lastErr = err;
      if (/credits|unauthorized/i.test(String(err.message))) throw err;
    }
    if (attempt < retries) await sleep(throttled ? 1800 + 700 * attempt : 500 * (attempt + 1));
  }
  throw lastErr || new Error('twitterapi request failed');
}

function fail(code, message) {
  const e = new Error(message || code);
  e.code = code;
  return e;
}

// Resolve a handle to a normalized user object. Throws { code:'notfound' } if
// the account doesn't exist, { code:'upstream' } if twitterapi.io is flaking —
// the two must not be conflated (a throttled scraper isn't a missing account).
export async function getUser(env, handle) {
  let data;
  try {
    data = await api(env, '/twitter/user/info', { userName: handle });
  } catch (err) {
    throw fail('upstream', 'post source unavailable');
  }
  // A real miss comes back as a success-shaped payload with no user in it.
  const u = data.data || data;
  if (!u || !u.userName) throw fail('notfound', 'account not found');
  return {
    id: u.id,
    handle: u.userName,
    name: u.name || u.userName,
    protected: !!u.protected,
    followers: u.followers ?? 0,
    statuses: u.statusesCount ?? 0,
    avatar: u.profilePicture || null,
  };
}

// Strip links (t.co noise, not prose), decode the few HTML entities the API
// leaves in, collapse whitespace. Mentions and hashtags are kept verbatim —
// stripping @mentions deleted grammatical subjects ("Only @X can bring…" →
// "Only can bring…") and inflated surprisal on exactly the corporate accounts
// that cite products most; a handle in context is part of how someone writes.
function clean(text) {
  return String(text || '')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

const wordCount = (s) => (s ? s.split(/\s+/).filter(Boolean).length : 0);

// Pull recent original posts and clean them into scoreable samples. Excludes
// retweets and non-English posts; `excludeReplies` also drops the account's
// own replies (top-of-timeline standalone posts only). Paginates up to
// `maxPages`, stopping once we have enough words or tweets. Returns:
//   { samples: [{ id, text, words }], counts: { fetched, kept, words } }
export async function getSamples(env, handle, opts = {}) {
  const {
    maxPages = 3,
    targetWords = 110,
    maxTweets = 14,
    minWordsPerTweet = 4,
    maxWordsPerTweet = 45, // cap a single long post's walk (bounds cost)
    excludeReplies = false,
  } = opts;

  const samples = [];
  let fetched = 0;
  let words = 0;
  let cursor = '';

  for (let page = 0; page < maxPages; page++) {
    if (page > 0) await sleep(1500); // stay under twitterapi.io's per-key QPS
    const data = await api(env, '/twitter/user/last_tweets', { userName: handle, cursor });
    const tweets = data.data?.tweets || data.tweets || [];
    fetched += tweets.length;

    for (const t of tweets) {
      const raw = t.text || '';
      if (raw.startsWith('RT @')) continue; // retweet — not their writing
      if (excludeReplies && t.isReply) continue;
      if (t.lang && t.lang !== 'en') continue; // English only (scorer is English)
      let text = clean(raw);
      const wc = wordCount(text);
      if (wc < minWordsPerTweet) continue; // too short to score fairly
      if (wc > maxWordsPerTweet) {
        text = text.split(/\s+/).slice(0, maxWordsPerTweet).join(' ');
      }
      const kept = wordCount(text);
      samples.push({ id: t.id, text, words: kept });
      words += kept;
      if (samples.length >= maxTweets || words >= targetWords) break;
    }

    if (samples.length >= maxTweets || words >= targetWords) break;
    if (!data.has_next_page || !data.next_cursor) break;
    cursor = data.next_cursor;
  }

  return { samples, counts: { fetched, kept: samples.length, words } };
}
