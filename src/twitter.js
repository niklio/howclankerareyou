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

// Accept "@handle" or "handle" only — no URLs. X handles are 1–15 chars of
// [A-Za-z0-9_]. Returns the bare handle (original case preserved for display;
// the API is case-insensitive) or null if the input isn't a plausible handle.
export function parseHandle(input) {
  if (!input) return null;
  const bare = String(input).trim().replace(/^@/, '');
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
      // Success shapes vary by endpoint: user/last_tweets wrap payloads as
      // { status:'success', data, … } while advanced_search returns a bare
      // { tweets, has_next_page, next_cursor }. Throttle/error: { error, message }.
      if (!throttled && data && (data.status === 'success' || data.data || data.tweets)) return data;
      lastErr = new Error(data?.message || data?.msg || `twitterapi ${res.status}`);
      // Definitive answers aren't transient — don't burn retries on them:
      // status:'error' = the API resolved the request (e.g. "user not found");
      // 402 = out of credits, 401/403 = bad key.
      if (data?.status === 'error' || [401, 402, 403].includes(res.status)) throw lastErr;
    } catch (err) {
      lastErr = err;
      if (/not found|credits|unauthorized/i.test(String(err.message))) throw err;
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

// One-page probe WITHOUT the language filter: does this account have any
// original posts at all? Used only on the thin path to tell "no readable
// posts" (handle-miss / dormant / squatter) from "posts exist but none in
// English" — the two need different analytics (and eventually messaging).
export async function probeOriginals(env, handle) {
  const data = await api(env, '/twitter/tweet/advanced_search', {
    queryType: 'Latest',
    query: `from:${handle} -filter:retweets -filter:replies`,
  });
  return (data.tweets || data.data?.tweets || []).length;
}

// Resolve a handle to a normalized user object. Throws { code:'notfound' } if
// the account doesn't exist, { code:'upstream' } if twitterapi.io is flaking —
// the two must not be conflated (a throttled scraper isn't a missing account).
export async function getUser(env, handle) {
  let data;
  try {
    data = await api(env, '/twitter/user/info', { userName: handle });
  } catch (err) {
    // The API answers "user not found" as status:'error' (api() rethrows it
    // without retrying); anything else is the scraper flaking.
    if (/not found/i.test(String(err.message))) throw fail('notfound', 'account not found');
    throw fail('upstream', 'post source unavailable');
  }
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

// One-call sampling via advanced search: `from:handle -filter:retweets
// -filter:replies lang:en` returns only the account's original English posts,
// newest first, with author metadata on each tweet — no user/info call and no
// timeline pagination in the common case (~1.4s). Paginates the search only
// when the first page doesn't yield enough qualifying posts (sparse posters
// like heavy retweeters). Returns:
//   { user, samples: [{ id, text, words }], counts: { fetched, kept, words, pages } }
// user is null when the search returned no tweets at all — the caller falls
// back to getUser to distinguish protected / nonexistent / empty accounts.
export async function searchSamples(env, handle, opts = {}) {
  const { maxTweets = 5, minWords = 11, maxWordsPerTweet = 45, maxPages = 4 } = opts;
  const query = `from:${handle} -filter:retweets -filter:replies lang:en`;

  const samples = [];
  let user = null;
  let fetched = 0;
  let words = 0;
  let pages = 0;
  let cursor = '';

  for (let page = 0; page < maxPages; page++) {
    if (page > 0) await sleep(1200); // stay under twitterapi.io's per-key QPS
    const data = await api(env, '/twitter/tweet/advanced_search', {
      queryType: 'Latest',
      query,
      cursor,
    });
    pages++;
    const tweets = data.tweets || data.data?.tweets || [];
    fetched += tweets.length;
    if (!user && tweets.length) {
      const a = tweets[0].author || {};
      user = {
        id: a.id,
        handle: a.userName || handle,
        name: a.name || a.userName || handle,
        followers: a.followers ?? 0,
      };
    }

    for (const t of tweets) {
      const raw = t.text || '';
      if (raw.startsWith('RT @')) continue; // belt & braces; the query filters
      if (t.isReply) continue;
      let text = clean(raw);
      const wc = wordCount(text);
      if (wc < minWords) continue; // too short to fill a grid row
      if (wc > maxWordsPerTweet) {
        text = text.split(/\s+/).slice(0, maxWordsPerTweet).join(' ');
      }
      const kept = wordCount(text);
      samples.push({ id: t.id, text, words: kept });
      words += kept;
      if (samples.length >= maxTweets) break;
    }

    if (samples.length >= maxTweets) break;
    if (!data.has_next_page || !data.next_cursor) break;
    cursor = data.next_cursor;
  }

  return { user, samples, counts: { fetched, kept: samples.length, words, pages } };
}
