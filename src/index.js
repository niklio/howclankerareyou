import { QUESTIONS, pickQuestions } from './questions.js';
import {
  MODELS,
  TEXT_MODELS,
  scoreModel,
  scorePostEcho,
  clankerScore,
  clankerScoreText,
  isMock,
  heatLevel,
  heatLevelText,
} from './scoring.js';
import { parseHandle, getUser, searchSamples, probeOriginals } from './twitter.js';
import { parseRedditor, redditSamples, probeSubmitted } from './reddit.js';
import { ogImage } from './og.js';
import * as auth from './auth.js';
import { gatherAnalytics } from './analytics.js';
import { DASHBOARD_HTML } from './dashboard.js';

const ANALYTICS_HOST = 'analytics.howclankerareyou.com';
const ANALYTICS_URL = 'https://analytics.howclankerareyou.com/';
const CANONICAL = 'https://howclankerareyou.com';
const COOKIE_DOMAIN = '.howclankerareyou.com';
const SESSION_COOKIE = 'hcay_session';

// --- diagnose tuning --------------------------------------------------------
// Sample = the 5 most recent standalone posts (no retweets, no replies) with
// ≥ MIN_POST_WORDS words. Each post is scored on its LAST GRID_COLS words —
// everything before the window is warmup context (≥3 words), the old cold-
// start drop for free — so a several-paragraph post costs the same compute as
// an 11-word one, every post fills a full row, and the share grid is always
// SAMPLE_TWEETS × GRID_COLS (5×8), emoji-shareable like the self-test.
// The 11-word minimum (vs 18 before) keeps terse posters like @pmarca
// gradeable without padding the grid.
const SAMPLE_TWEETS = 5;
const GRID_COLS = 8;
const MIN_POST_WORDS = GRID_COLS + 3; // full window + ≥3 words of warmup
const MIN_SAMPLE_TWEETS = 5;
// Thin-account fallback: when fewer than MIN_SAMPLE_TWEETS items qualify,
// concatenate EVERYTHING pulled (newest first), warm up on the first
// F_WARMUP words, score up to the next F_ROWS × F_COLS, and reshape the grid
// into 10-wide rows. Reject only when nothing exists past the warmup.
const F_WARMUP = 10;
const F_COLS = 10;
const F_ROWS = 5;
// Repeat lookups of the same handle reuse the stored result for a week —
// popular accounts would otherwise re-burn scraper credits + inference on
// every curious visitor. A week is fine: 5 recent posts don't move fast.
const DIAGNOSE_CACHE_MS = 7 * 86400 * 1000;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    // Route on the Host header, not url.hostname — wrangler dev rewrites the
    // URL to localhost, but the header carries the real host in both envs.
    const host = (request.headers.get('host') || url.hostname).split(':')[0];

    // OAuth endpoints work on any host but pin themselves to the canonical apex.
    if (url.pathname.startsWith('/auth/')) return authRoutes(request, env, url, host);

    // Admin analytics subdomain: email-gated API + dashboard shell.
    if (host === ANALYTICS_HOST) return analyticsHost(request, env, url);

    if (url.pathname.startsWith('/api/')) {
      try {
        return await api(request, env, url, ctx);
      } catch (err) {
        return json({ error: err.message }, 500);
      }
    }
    // The assets server mislabels .xml as text/html; fix it so crawlers parse
    // the sitemap as XML.
    if (url.pathname === '/sitemap.xml') {
      const res = await env.ASSETS.fetch(request);
      const headers = new Headers(res.headers);
      headers.set('content-type', 'application/xml; charset=utf-8');
      return new Response(res.body, { status: res.status, headers });
    }
    // Dynamic OG card for a result: /og/<key>.png. Edge-cached per URL (the
    // rewriter appends ?v=<score>, so a re-diagnosis mints a fresh URL).
    // Unknown keys fall back to the static og.png.
    const og = request.method === 'GET' && url.pathname.match(/^\/og\/((?:u\/)?[A-Za-z0-9_-]{1,64})\.png$/);
    if (og) {
      const cached = await caches.default.match(request);
      if (cached) return cached;
      const row = await resultByKey(env, og[1]);
      if (!row) return env.ASSETS.fetch(new Request(CANONICAL + '/og.png'));
      const img = await ogImage(row);
      const out = new Response(await img.arrayBuffer(), {
        headers: { 'content-type': 'image/png', 'cache-control': 'public, max-age=86400' },
      });
      if (ctx && ctx.waitUntil) ctx.waitUntil(caches.default.put(request, out.clone()));
      return out;
    }

    // Fire-and-forget traffic instrumentation.
    if (request.method === 'GET' && url.pathname === '/') logEvent(env, ctx, request, 'pageview');
    else if (['GET', 'HEAD'].includes(request.method) && /^\/r\/(?:u\/)?[A-Za-z0-9_-]{1,64}$/.test(url.pathname)) {
      // /r/<uuid> (self-tests, legacy links) or /r/<handle> (account share
      // links). meta = the key, so analytics can join views to results.
      const key = url.pathname.slice(3);
      if (request.method === 'GET') logEvent(env, ctx, request, 'result_view', { meta: key });
      // Result pages can name a real person (diagnosed X accounts), so keep
      // them out of search indexes. The SPA shell is shared, so we noindex all
      // /r/ pages via header; the homepage stays indexable.
      const res = await env.ASSETS.fetch(request);
      const headers = new Headers(res.headers);
      headers.set('x-robots-tag', 'noindex');
      let out = new Response(res.body, { status: res.status, headers });
      // Belt-and-suspenders noindex: the header above already covers Google/
      // Bing, but inject a visible <meta name="robots"> into the shell too so
      // the directive is in the page source for crawlers/tools that read the
      // tag but not the header. Independent of the row lookup below.
      if (request.method === 'GET' && res.ok) {
        out = new HTMLRewriter()
          .on('head', {
            element: (e) => e.append('<meta name="robots" content="noindex, follow">', { html: true }),
          })
          .transform(out);
      }
      // Link previews: crawlers don't run JS, so bake the verdict into the
      // OG/Twitter meta of the served shell ("@handle is 27.5% clanker").
      if (request.method === 'GET' && res.ok) {
        try {
          const row = await resultByKey(env, key);
          if (row) {
            const acct = row.subject_type === 'account';
            const reddit = row.subject_platform === 'reddit';
            const whom = reddit ? `u/${row.subject_handle}` : `@${row.subject_handle}`;
            const title = acct
              ? `${whom} is ${row.overall}% clanker`
              : `certified ${row.overall}% clanker`;
            const desc = acct
              ? `graded from ${whom}'s public ${reddit ? 'comments on reddit' : 'posts on X'} — word by word, by the models. how clanker are you?`
              : `a surprisal Turing test, taken by a human (allegedly). how clanker are you?`;
            const set = (attr) => ({ element: (e) => e.setAttribute('content', attr) });
            out = new HTMLRewriter()
              .on('title', { element: (e) => e.setInnerContent(`${title} — how clanker are you?`) })
              .on('meta[property="og:title"]', set(title))
              .on('meta[name="twitter:title"]', set(title))
              .on('meta[property="og:description"]', set(desc))
              .on('meta[name="twitter:description"]', set(desc))
              .on('meta[name="description"]', set(desc))
              .on('meta[property="og:url"]', set(`${CANONICAL}/r/${key}`))
              .on('meta[property="og:image"]', set(`${CANONICAL}/og/${key}.png?v=${row.overall}`))
              .on('meta[name="twitter:image"]', set(`${CANONICAL}/og/${key}.png?v=${row.overall}`))
              .on('meta[property="og:image:alt"]', set(title))
              .transform(out);
          }
        } catch {} // preview sweetening must never break the page
      }
      return out;
    }
    return env.ASSETS.fetch(request);
  },
};

// --- admin auth (Google OAuth, pinned to the canonical apex) ---------------

async function authRoutes(request, env, url, host) {
  const next = url.searchParams.get('next') || ANALYTICS_URL;

  if (url.pathname === '/auth/google') {
    // Pin to the canonical apex so redirect_uri matches Google's registration.
    if (host !== 'howclankerareyou.com') {
      const u = new URL(CANONICAL + '/auth/google');
      if (safeNext(next)) u.searchParams.set('next', next);
      return Response.redirect(u.toString(), 302);
    }
    const state = crypto.randomUUID();
    const headers = new Headers({
      location: auth.googleAuthUrl(env, CANONICAL + '/auth/google/callback', state),
    });
    headers.append('set-cookie', auth.cookieHeader('oauth_state', state, { maxAge: 600 }));
    if (safeNext(next))
      headers.append('set-cookie', auth.cookieHeader('oauth_next', encodeURIComponent(next), { maxAge: 600 }));
    return new Response(null, { status: 302, headers });
  }

  if (url.pathname === '/auth/google/callback') {
    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');
    if (!code || !state || state !== auth.getCookie(request, 'oauth_state'))
      return new Response('auth failed (bad state)', { status: 400 });
    let email;
    try {
      ({ email } = await auth.exchangeCode(env, code, CANONICAL + '/auth/google/callback'));
    } catch {
      return new Response('auth failed', { status: 400 });
    }
    const sid = await auth.createSession(env, email);
    const dest = decodeURIComponent(auth.getCookie(request, 'oauth_next') || '');
    const headers = new Headers({ location: safeNext(dest) ? dest : ANALYTICS_URL });
    headers.append(
      'set-cookie',
      auth.cookieHeader(SESSION_COOKIE, sid, { maxAge: 30 * 86400, domain: COOKIE_DOMAIN })
    );
    headers.append('set-cookie', auth.cookieHeader('oauth_state', '', { maxAge: 0 }));
    headers.append('set-cookie', auth.cookieHeader('oauth_next', '', { maxAge: 0 }));
    return new Response(null, { status: 302, headers });
  }

  if (url.pathname === '/auth/logout') {
    await auth.destroySessionsFrom(env, request, SESSION_COOKIE);
    const headers = new Headers({ location: safeNext(next) ? next : CANONICAL });
    // Clear both the domain-scoped and any host-only cookie.
    headers.append('set-cookie', auth.cookieHeader(SESSION_COOKIE, '', { maxAge: 0, domain: COOKIE_DOMAIN }));
    headers.append('set-cookie', auth.cookieHeader(SESSION_COOKIE, '', { maxAge: 0 }));
    return new Response(null, { status: 302, headers });
  }
  return new Response('not found', { status: 404 });
}

async function analyticsHost(request, env, url) {
  if (url.pathname.startsWith('/api/')) {
    const email = await auth.sessionEmailFrom(env, request, SESSION_COOKIE);
    const admin = auth.isAdmin(env, email);
    if (url.pathname === '/api/me') return json({ email: email || null, admin });
    if (!admin) return json({ error: 'forbidden' }, 403);
    if (url.pathname === '/api/analytics')
      return json(await gatherAnalytics(env, url.searchParams.get('range') || 'week'));
    return json({ error: 'not found' }, 404);
  }
  if (url.pathname === '/favicon.svg') return env.ASSETS.fetch(new Request(CANONICAL + '/favicon.svg'));
  return new Response(DASHBOARD_HTML, {
    headers: { 'content-type': 'text/html; charset=utf-8', 'x-robots-tag': 'noindex' },
  });
}

function safeNext(n) {
  try {
    const u = new URL(n);
    return u.protocol === 'https:' && (u.hostname === 'howclankerareyou.com' || u.hostname.endsWith(COOKIE_DOMAIN));
  } catch {
    return false;
  }
}

// --- event logging (fire-and-forget) ---------------------------------------

function logEvent(env, ctx, request, type, extra = {}) {
  const p = (async () => {
    try {
      await env.DB.prepare(
        'INSERT INTO events (id, ts, day, type, ref, visitor, session_id, meta) VALUES (?,?,?,?,?,?,?,?)'
      )
        .bind(
          crypto.randomUUID(),
          Date.now(),
          new Date().toISOString().slice(0, 10),
          type,
          type === 'pageview' ? refHost(request) : null,
          visitorHash(request),
          extra.session || null,
          extra.meta || null
        )
        .run();
    } catch {}
  })();
  if (ctx && ctx.waitUntil) ctx.waitUntil(p);
}

function refHost(request) {
  const r = request.headers.get('referer');
  if (!r) return null;
  try {
    const h = new URL(r).hostname;
    return h === 'howclankerareyou.com' || h.endsWith(COOKIE_DOMAIN) ? null : h;
  } catch {
    return null;
  }
}

// Non-reversible bucket for unique-visitor counts (no raw IP stored).
function visitorHash(request) {
  const s =
    (request.headers.get('cf-connecting-ip') || '') +
    '|' +
    (request.headers.get('user-agent') || '').slice(0, 40) +
    '|hcay';
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
}

async function api(request, env, url, ctx) {
  const { pathname } = url;

  if (request.method === 'GET' && pathname === '/api/status') {
    return json({ mock: isMock(env) });
  }

  // TEMPORARY (staging only, BENCH-gated like /api/_bench): unauthenticated
  // analytics JSON so the v2 aggregation can be verified without the prod
  // OAuth host. Prod never sets BENCH → 404.
  if (env.BENCH === '1' && request.method === 'GET' && pathname === '/api/_analytics') {
    return json(await gatherAnalytics(env, url.searchParams.get('range') || 'week'));
  }

  // TEMPORARY (staging only): does Reddit serve RSS to Workers egress IPs?
  if (env.BENCH === '1' && request.method === 'GET' && pathname === '/api/_rss') {
    const name = url.searchParams.get('u') || 'spez';
    if (!/^[A-Za-z0-9_-]{3,20}$/.test(name)) return json({ error: 'bad' }, 400);
    const t0 = Date.now();
    const res = await fetch(`https://www.reddit.com/user/${name}/comments.rss`, {
      headers: { 'user-agent': 'howclankerareyou/1.0 rss reader (https://howclankerareyou.com)' },
    });
    const bodyText = await res.text();
    return json({
      status: res.status,
      ms: Date.now() - t0,
      bytes: bodyText.length,
      entries: (bodyText.match(/<entry>/g) || []).length,
    });
  }


  // TEMPORARY latency bench (staging only: BENCH var unset in prod → 404).
  // Fires n parallel single-token logprob calls at the HF router to measure
  // whether the Workers simultaneous-connection cap serializes a wide fan-out.
  if (env.BENCH === '1' && request.method === 'GET' && pathname === '/api/_bench') {
    const n = Math.min(64, Number(url.searchParams.get('n') || 24));
    const model = MODELS[0];
    const t0 = Date.now();
    const times = await Promise.all(
      Array.from({ length: n }, async (_, i) => {
        const s = Date.now();
        await fetch('https://router.huggingface.co/v1/chat/completions', {
          method: 'POST',
          headers: { authorization: `Bearer ${env.HF_TOKEN}`, 'content-type': 'application/json' },
          body: JSON.stringify({
            model: model.id,
            messages: [
              { role: 'user', content: 'Write a single short, natural social media post.' },
              { role: 'assistant', content: 'the breakfast burrito at the airport ' + 'gate '.repeat(i % 6) },
            ],
            max_tokens: 1,
            logprobs: true,
            top_logprobs: 20,
          }),
          signal: AbortSignal.timeout(30_000),
        }).then((r) => r.text());
        return Date.now() - s;
      })
    );
    return json({
      n,
      wallMs: Date.now() - t0,
      perCallAvgMs: Math.round(times.reduce((a, b) => a + b, 0) / n),
      perCallMaxMs: Math.max(...times),
    });
  }

  // Client-side event beacon (share taps + result-page CTA clicks). Only these
  // are client-loggable; pageview/result_view are server-side to prevent
  // inflation. cta meta is allowlisted so the events table stays clean.
  if (request.method === 'POST' && pathname === '/api/event') {
    const body = await request.json().catch(() => ({}));
    if (body.type === 'share') logEvent(env, ctx, request, 'share', { session: body.session });
    else if (body.type === 'cta' && ['diag_again', 'self_instead', 'take_test'].includes(body.meta))
      logEvent(env, ctx, request, 'cta', { session: body.session, meta: body.meta });
    return json({ ok: true });
  }

  if (request.method === 'POST' && pathname === '/api/session') {
    const sessBody = await request.json().catch(() => ({}));
    if (env.SESSION_RL) {
      const ip = request.headers.get('cf-connecting-ip') || 'anon';
      const { success } = await env.SESSION_RL.limit({ key: ip });
      if (!success) {
        logEvent(env, ctx, request, 'ratelimited', { meta: 'session' });
        return json({ error: 'slow down — too many sessions' }, 429);
      }
    }
    const id = crypto.randomUUID();
    await env.DB.prepare('INSERT INTO sessions (id, created_at) VALUES (?, ?)')
      .bind(id, Date.now())
      .run();
    return json({
      session: id,
      // First play = the original five, in order (the canonical experience);
      // repeat plays (client remembers completing a run) draw random from
      // the bank so retakes stay fresh.
      questions: sessBody.returning ? pickQuestions() : QUESTIONS.slice(0, 5),
      models: MODELS.map(({ id, label, maker }) => ({ id, label, maker })),
      mock: isMock(env),
    });
  }

  if (request.method === 'POST' && pathname === '/api/score') {
    if (env.SCORE_RL) {
      const ip = request.headers.get('cf-connecting-ip') || 'anon';
      const { success } = await env.SCORE_RL.limit({ key: ip });
      if (!success) {
        logEvent(env, ctx, request, 'ratelimited', { meta: 'score' });
        return json({ error: 'rate limited, slow down' }, 429);
      }
    }
    const body = await request.json();
    const question = QUESTIONS.find((q) => q.id === body.questionId);
    const model = MODELS.find((m) => m.id === body.model);
    if (!question || !model) return json({ error: 'unknown question or model' }, 400);
    const session = await env.DB.prepare('SELECT id FROM sessions WHERE id = ?')
      .bind(String(body.session ?? ''))
      .first();
    if (!session) return json({ error: 'unknown session' }, 400);

    // Global daily backstop against distributed abuse. Fail-open: a counter
    // hiccup must never take scoring down.
    if (await overDailyCap(env)) {
      return json({ error: 'the robots are resting — daily limit reached, try again tomorrow' }, 429);
    }

    const completion = String(body.completion ?? '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 80);
    if (completion.length < 2) return json({ error: 'completion too short' }, 400);

    const result = await scoreModel(env, model, question.prompt, completion);
    if (!result) return json({ model: model.id, ok: false });

    await env.DB.prepare(
      'INSERT OR REPLACE INTO answers (session_id, question_id, model, avg_kl, steps, completion, per_word) VALUES (?, ?, ?, ?, ?, ?, ?)'
    )
      .bind(
        session.id,
        question.id,
        model.id,
        result.avgKL,
        result.steps,
        completion,
        JSON.stringify(result.perWord ?? [])
      )
      .run();
    return json({ model: model.id, ok: true, ...result });
  }

  if (request.method === 'POST' && pathname === '/api/finish') {
    const body = await request.json();
    const sessionId = String(body.session ?? '');
    const rows = (
      await env.DB.prepare(
        'SELECT question_id, model, avg_kl, completion, per_word FROM answers WHERE session_id = ?'
      )
        .bind(sessionId)
        .all()
    ).results;
    const questionCount = new Set(rows.map((r) => r.question_id)).size;
    if (questionCount < 3) return json({ error: 'not enough scored questions' }, 400);

    const perModel = MODELS.map((m) => {
      const mine = rows.filter((r) => r.model === m.id);
      if (!mine.length) return null;
      const avgKL = mine.reduce((s, r) => s + r.avg_kl, 0) / mine.length;
      return {
        model: m.id,
        label: m.label,
        maker: m.maker,
        avgKL: Math.round(avgKL * 1000) / 1000,
        score: clankerScore(avgKL, m.d0),
        questions: mine.length,
      };
    }).filter(Boolean);
    // Surprisal to the ensemble is a min over members (nearest model), so the overall
    // score is the nearest model's — your inner clanker sets your number.
    const overall = Math.max(...perModel.map((m) => m.score));
    const grid = buildGrid(rows);

    await env.DB.prepare(
      'INSERT OR REPLACE INTO results (id, created_at, overall, per_model, grid) VALUES (?, ?, ?, ?, ?)'
    )
      .bind(sessionId, Date.now(), overall, JSON.stringify(perModel), JSON.stringify(grid))
      .run();
    return json({
      id: sessionId,
      overall,
      perModel,
      grid,
      percentile: await percentile(env, overall, 'self'),
    });
  }

  // Diagnose an account (X handle or reddit u/name): resolve → pull recent
  // posts/comments → score each against every model → aggregate into the same
  // result shape the share page already renders. Costs many upstream calls,
  // so it's rate-limited and counts toward the daily cap.
  if (request.method === 'POST' && pathname === '/api/diagnose') {
    const tStart = Date.now();
    const body = await request.json().catch(() => ({}));
    // "u/name" → reddit; "@handle" / bare → X. displayKey is what analytics
    // and the blocklist see (u/ prefix keeps the namespaces apart).
    const redditor = parseRedditor(body.input);
    const platform = redditor ? 'reddit' : 'x';
    const handle = redditor || parseHandle(body.input);
    const displayKey = (h) => (platform === 'reddit' ? `u/${h}` : h);

    // Every exit logs exactly one `diagnose` event: outcome + timings (+ cache
    // flag and upstream-call count for cost tracking). The analytics dashboard
    // is built on these.
    const diag = (res, outcome, extra = {}) => {
      logEvent(env, ctx, request, 'diagnose', {
        meta: JSON.stringify({
          handle: extra.handle ? displayKey(String(extra.handle).toLowerCase()) : null,
          outcome,
          cause: extra.cause ?? null, // thin sub-cause (see thinCause)
          platform,
          cached: !!extra.cached,
          msTotal: Date.now() - tStart,
          msFetch: extra.msFetch ?? null,
          msScore: extra.msScore ?? null,
          pages: extra.pages ?? 0,
        }),
      });
      return res;
    };

    if (env.DIAGNOSE_RL) {
      const ip = request.headers.get('cf-connecting-ip') || 'anon';
      const { success } = await env.DIAGNOSE_RL.limit({ key: ip });
      if (!success) {
        return diag(json({ error: 'slow down — one diagnosis at a time', code: 'ratelimited' }, 429), 'ratelimited');
      }
    }

    if (!handle) {
      return diag(json({ error: "that doesn't look like an X @handle or a reddit u/name", code: 'badinput' }, 400), 'badinput');
    }

    if (await isBlocked(env, displayKey(handle))) {
      return diag(json({ error: 'this account asked to be removed from the tool', code: 'blocked' }, 403), 'blocked', { handle });
    }

    // Cache: serve a recent diagnosis of the same account instead of re-running
    // the scrape + 15 model walks. Checked before the daily-cap bump — a cache
    // hit costs nothing upstream. Percentile is recomputed (it drifts as more
    // accounts get graded).
    const cached = await env.DB.prepare(
      `SELECT * FROM results WHERE subject_type = 'account' AND lower(subject_handle) = ?
       AND COALESCE(subject_platform, 'x') = ?
       AND created_at > ? ORDER BY created_at DESC LIMIT 1`
    )
      .bind(handle.toLowerCase(), platform, Date.now() - DIAGNOSE_CACHE_MS)
      .first();
    if (cached) {
      const grid = cached.grid ? JSON.parse(cached.grid) : null;
      return diag(
        json({
          id: cached.id,
          overall: cached.overall,
          perModel: JSON.parse(cached.per_model),
          grid,
          sources: cached.sources ? JSON.parse(cached.sources) : [],
          percentile: await percentile(env, cached.overall, 'account'),
          cached: true,
          subject: {
            type: 'account',
            platform: cached.subject_platform || 'x',
            handle: cached.subject_handle,
            name: cached.subject_name,
            kept: grid ? grid.length : null,
          },
        }),
        'success',
        { handle: cached.subject_handle, cached: true }
      );
    }

    if (await overDailyCap(env)) {
      return diag(json({ error: 'the robots are resting — daily limit reached, try again tomorrow', code: 'cap' }, 429), 'cap', { handle });
    }

    const t0 = Date.now();
    // One source call returns the account's recent material + author identity
    // together (X: advanced search over original posts; reddit: newest
    // comments). getUser runs only on X's empty-result sad path to distinguish
    // protected / nonexistent / just-quiet accounts.
    const who = (h) => (platform === 'reddit' ? `u/${h}` : `@${h}`);
    let user, samples, counts, raw;
    try {
      ({ user, samples, counts, raw } =
        platform === 'reddit'
          ? await redditSamples(env, handle, { maxItems: SAMPLE_TWEETS, minWords: MIN_POST_WORDS })
          : await searchSamples(env, handle, { maxTweets: SAMPLE_TWEETS, minWords: MIN_POST_WORDS }));
    } catch (err) {
      return diag(json({ error: 'the post source is having a moment — try again in a sec', code: 'upstream' }, 502), 'upstream', { handle });
    }
    if (!user) {
      if (platform === 'reddit') {
        // KeyAPI answers a definitive null for unknown redditors.
        return diag(json({ error: `can't find u/${handle} on reddit`, code: 'notfound' }, 404), 'notfound', { handle });
      }
      try {
        const u = await getUser(env, handle);
        if (u.protected)
          return diag(json({ error: `@${u.handle}'s posts are protected`, code: 'protected', handle: u.handle }, 422), 'protected', { handle: u.handle });
        const cause = await thinCause(env, u.handle, counts, platform);
        return diag(
          json({ error: `not enough public posts to grade @${u.handle} fairly`, code: 'thin', handle: u.handle, kept: 0 }, 422),
          'thin',
          { handle: u.handle, pages: counts.pages, cause }
        );
      } catch (err) {
        if (err.code === 'notfound')
          return diag(json({ error: `can't find @${handle} on X`, code: 'notfound' }, 404), 'notfound', { handle });
        return diag(json({ error: 'the post source is having a moment — try again in a sec', code: 'upstream' }, 502), 'upstream', { handle });
      }
    }
    if (samples.length < MIN_SAMPLE_TWEETS) {
      // Not enough full items for the 5×8 grid — fall back to grading the
      // concatenation of everything pulled. Only accounts with nothing past
      // the warmup get rejected.
      const allWords = (raw || []).join(' ').split(/\s+/).filter(Boolean);
      if (allWords.length <= F_WARMUP + 1) {
        // Reddit with a completely empty comments feed: disambiguate hidden
        // history from genuine silence via the (public) posts feed.
        if (platform === 'reddit' && counts.fetched === 0) {
          const posts = await probeSubmitted(user.handle).catch(() => null);
          if (posts > 0) {
            return diag(
              json({ error: `u/${user.handle} has posts but no publicly visible comments — reddit profiles can hide comment history. if that's you: reddit settings → profile → show your comments, then retry`, code: 'hidden', handle: user.handle }, 422),
              'thin',
              { handle: user.handle, pages: counts.pages, cause: 'hidden-comments' }
            );
          }
          if (posts === 0) {
            return diag(
              json({ error: `u/${user.handle} has no public activity at all — private, brand new, or a champion lurker`, code: 'quiet', handle: user.handle }, 422),
              'thin',
              { handle: user.handle, pages: counts.pages, cause: 'no-activity' }
            );
          }
        }
        const cause = await thinCause(env, user.handle, counts, platform);
        return diag(
          json({ error: `not enough public ${platform === 'reddit' ? 'comments' : 'posts'} to grade ${who(user.handle)} fairly`, code: 'thin', handle: user.handle, kept: samples.length }, 422),
          'thin',
          { handle: user.handle, pages: counts.pages, cause }
        );
      }
      const windowN = Math.min(F_ROWS * F_COLS, allWords.length - F_WARMUP);
      const text = allWords.slice(0, F_WARMUP + windowN).join(' ');
      const tFetchF = Date.now() - t0;
      const scoredF = await Promise.all(
        TEXT_MODELS.map(async (m, i) => {
          if (i) await new Promise((r) => setTimeout(r, i * 150));
          return { m, r: await scorePostEcho(env, m, text, windowN) };
        })
      );
      const tScoreF = Date.now() - t0 - tFetchF;
      ctx?.waitUntil?.(addUsage(env, TEXT_MODELS.length - 1));

      const okF = scoredF.filter((x) => x.r);
      if (!okF.length) {
        return diag(json({ error: 'scoring failed — try again in a sec', code: 'upstream' }, 502), 'upstream', {
          handle: user.handle, msFetch: tFetchF, msScore: tScoreF, pages: counts.pages,
        });
      }
      const perModel = okF.map(({ m, r }) => ({
        model: m.id,
        label: m.label,
        maker: m.maker,
        avgKL: Math.round(r.avgKL * 1000) / 1000,
        score: clankerScoreText(r.avgKL, m.d0text),
        posts: raw.length,
      }));
      const overall = Math.max(...perModel.map((m) => m.score));

      // Grid: 10-wide rows over the scored words, per-cell mean across models
      // (all models scored the same window of the same text → word-aligned).
      const steps = okF.map((x) => x.r.perStep);
      const scoredWords = allWords.slice(F_WARMUP, F_WARMUP + windowN);
      const grid = [];
      for (let start = 0; start < windowN; start += F_COLS) {
        const cells = [];
        const rowVals = [];
        for (let j = 0; j < F_COLS; j++) {
          const pos = start + j;
          if (pos >= windowN) { cells.push(null); continue; }
          const vals = steps.map((ps) => ps[pos]).filter(Boolean).map((s) => -s.logprob);
          if (vals.length) rowVals.push(...vals);
          cells.push(vals.length ? heatLevelText(vals.reduce((a, b) => a + b, 0) / vals.length) : null);
        }
        grid.push({
          prompt: who(user.handle),
          answer: scoredWords.slice(start, Math.min(start + F_COLS, windowN)).join(' '),
          cells,
          kl: rowVals.length ? Math.round((rowVals.reduce((a, b) => a + b, 0) / rowVals.length) * 100) / 100 : null,
        });
      }
      const sources = raw.slice(0, 10).map((t, i) => ({ id: `f${i}`, text: t }));

      const id = crypto.randomUUID();
      ctx?.waitUntil?.(
        env.DB.prepare(
          `INSERT INTO results (id, created_at, overall, per_model, grid, subject_type, subject_handle, subject_name, sources, subject_platform)
           VALUES (?, ?, ?, ?, ?, 'account', ?, ?, ?, ?)`
        )
          .bind(id, Date.now(), overall, JSON.stringify(perModel), JSON.stringify(grid), user.handle, user.name || who(user.handle), JSON.stringify(sources), platform)
          .run()
      );

      const out = {
        id,
        overall,
        perModel,
        grid,
        sources,
        percentile: await percentile(env, overall, 'account'),
        subject: {
          type: 'account',
          platform,
          handle: user.handle,
          name: user.name,
          thin: true,
          fetched: counts.fetched,
          kept: raw.length,
          words: allWords.length,
        },
      };
      if (env.BENCH === '1') out.debug = { tFetch: tFetchF, tScore: tScoreF, tTotal: Date.now() - t0 };
      // outcome success; cause marks the fallback so analytics can count it.
      return diag(json(out), 'success', {
        handle: user.handle, cause: 'fallback', msFetch: tFetchF, msScore: tScoreF, pages: counts.pages,
      });
    }

    const tFetch = Date.now() - t0;

    // Score every (post × model) pair: one echo call each, near-parallel —
    // 15 calls total, no chains, well inside the Worker's connection budget.
    // Starts are staggered ~200ms per post-wave so a loaded provider sees a
    // ramp, not a 15-call wall (deepinfra 429s in waves under burst load).
    const jobs = [];
    for (const t of samples) for (const m of TEXT_MODELS) jobs.push({ t, m });
    const scored = await Promise.all(
      jobs.map(async ({ t, m }, i) => {
        const wave = Math.floor(i / TEXT_MODELS.length);
        if (wave) await new Promise((r) => setTimeout(r, wave * 200));
        return { t, m, r: await scorePostEcho(env, m, t.text, GRID_COLS) };
      })
    );
    const tScore = Date.now() - t0 - tFetch;

    // Reconcile the usage counter with the real number of scoring calls made
    // (overDailyCap already charged 1 above).
    ctx?.waitUntil?.(addUsage(env, jobs.length - 1));

    // Aggregate per model: mean word surprisal over each post's scored window.
    const byId = {}; // tweetId -> modelId -> result
    for (const { t, m, r } of scored) {
      if (!r) continue;
      (byId[t.id] ||= {})[m.id] = r;
    }
    const perModel = TEXT_MODELS.map((m) => {
      let sumSurpr = 0, sumTok = 0, posts = 0;
      for (const t of samples) {
        const r = byId[t.id]?.[m.id];
        const kept = (r?.perStep || []).filter(Boolean);
        if (!kept.length) continue;
        sumSurpr += -kept.reduce((s, p) => s + p.logprob, 0);
        sumTok += kept.length;
        posts++;
      }
      if (!posts || !sumTok) return null;
      const avgKL = sumSurpr / sumTok;
      return {
        model: m.id,
        label: m.label,
        maker: m.maker,
        avgKL: Math.round(avgKL * 1000) / 1000,
        score: clankerScoreText(avgKL, m.d0text),
        posts,
      };
    }).filter(Boolean);

    if (!perModel.length) {
      return diag(json({ error: 'scoring failed — try again in a sec', code: 'upstream' }, 502), 'upstream', {
        handle: user.handle,
        msFetch: tFetch,
        msScore: tScore,
        pages: counts.pages,
      });
    }

    // Nearest (least-surprised) model sets the number, same as the self-test.
    const overall = Math.max(...perModel.map((m) => m.score));
    const grid = buildDiagnoseGrid(samples, byId, who(user.handle));
    const sources = samples.map((t) => ({ id: t.id, text: t.text }));

    // Persist off the critical path — the row lands in ~50ms, long before a
    // share link could plausibly be opened.
    const id = crypto.randomUUID();
    ctx?.waitUntil?.(
      env.DB.prepare(
        `INSERT INTO results (id, created_at, overall, per_model, grid, subject_type, subject_handle, subject_name, sources, subject_platform)
         VALUES (?, ?, ?, ?, ?, 'account', ?, ?, ?, ?)`
      )
        .bind(
          id,
          Date.now(),
          overall,
          JSON.stringify(perModel),
          JSON.stringify(grid),
          user.handle,
          user.name,
          JSON.stringify(sources),
          platform
        )
        .run()
    );

    const out = {
      id,
      overall,
      perModel,
      grid,
      sources,
      percentile: await percentile(env, overall, 'account'),
      subject: {
        type: 'account',
        platform,
        handle: user.handle,
        name: user.name,
        followers: user.followers,
        fetched: counts.fetched,
        kept: counts.kept,
        words: counts.words,
      },
    };
    if (env.BENCH === '1') out.debug = { tFetch, tScore, tTotal: Date.now() - t0 };
    return diag(json(out), 'success', {
      handle: user.handle,
      msFetch: tFetch,
      msScore: tScore,
      pages: counts.pages,
    });
  }

  // Opt-out: remove an account from the tool. Blocks future diagnoses and
  // deletes stored results for that handle. Intentionally open (no auth) so the
  // subject themselves can trigger it from a result page.
  if (request.method === 'POST' && pathname === '/api/remove') {
    const body = await request.json().catch(() => ({}));
    const redditor = parseRedditor(body.handle);
    const handle = redditor || parseHandle(body.handle);
    if (!handle) return json({ error: 'bad handle', code: 'badinput' }, 400);
    const platform = redditor ? 'reddit' : 'x';
    const lc = handle.toLowerCase();
    const blockKey = redditor ? `u/${lc}` : lc; // u/ prefix keeps namespaces apart
    try {
      await env.DB.prepare('INSERT OR IGNORE INTO blocklist (handle, created_at) VALUES (?, ?)')
        .bind(blockKey, Date.now())
        .run();
      await env.DB.prepare(
        `DELETE FROM results WHERE subject_type = 'account' AND lower(subject_handle) = ?
         AND COALESCE(subject_platform, 'x') = ?`
      )
        .bind(lc, platform)
        .run();
    } catch (err) {
      return json({ error: 'could not remove — try again', code: 'upstream' }, 500);
    }
    logEvent(env, ctx, request, 'optout', { meta: blockKey });
    return json({ ok: true });
  }

  if (request.method === 'GET' && pathname.startsWith('/api/result/')) {
    const key = decodeURIComponent(pathname.slice('/api/result/'.length));
    const row = await resultByKey(env, key);
    if (!row) return json({ error: 'not found' }, 404);
    const out = {
      id: row.id,
      overall: row.overall,
      perModel: JSON.parse(row.per_model),
      grid: row.grid ? JSON.parse(row.grid) : null,
      percentile: await percentile(env, row.overall, row.subject_type === 'account' ? 'account' : 'self'),
    };
    if (row.subject_type === 'account') {
      out.subject = {
        type: 'account',
        platform: row.subject_platform || 'x',
        handle: row.subject_handle,
        name: row.subject_name,
        kept: row.grid ? JSON.parse(row.grid).length : null,
      };
      out.sources = row.sources ? JSON.parse(row.sources) : [];
    }
    return json(out);
  }

  return json({ error: 'not found' }, 404);
}

// Build the shareable heat grid: one row per answered question, one cell per
// word, colored by the word's surprisal averaged across models (green =
// human/surprising, red = clanker/predictable).
function buildGrid(rows) {
  const grid = [];
  for (const q of QUESTIONS) {
    const answers = rows.filter((r) => r.question_id === q.id);
    if (!answers.length) continue;
    const words = String(answers[0].completion).trim().split(/\s+/);
    const perModel = answers.map((r) => {
      try {
        return JSON.parse(r.per_word) || [];
      } catch {
        return [];
      }
    });
    const cells = words.map((_, i) => {
      const vals = perModel.map((pw) => pw[i]).filter((v) => v != null);
      if (!vals.length) return null;
      const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
      return heatLevel(mean);
    });
    // Per-question surprisal (mean across models) so the share page can rank
    // most-clanker vs least-clanker answers.
    const kl = Math.round((answers.reduce((s, r) => s + r.avg_kl, 0) / answers.length) * 100) / 100;
    grid.push({ prompt: q.prompt, answer: words.join(' '), cells, kl });
  }
  return grid;
}

// Build the account share grid: one row per sampled post, always GRID_COLS
// cells wide (5×8 with the current tuning — clean emoji share). Every model
// scores the same last-GRID_COLS-words window, so cell j is the same word for
// all models: its heat is the mean word surprisal across models. `label` is
// the display identity ("@handle" or "u/name") used as each row's prompt.
function buildDiagnoseGrid(samples, byId, label) {
  const grid = [];
  for (const t of samples) {
    const perModel = byId[t.id];
    if (!perModel) continue;
    const cells = [];
    for (let j = 0; j < GRID_COLS; j++) {
      const vals = TEXT_MODELS.map((m) => perModel[m.id]?.perStep?.[j])
        .filter(Boolean)
        .map((s) => -s.logprob);
      cells.push(vals.length ? heatLevelText(vals.reduce((a, b) => a + b, 0) / vals.length) : null);
    }
    // Per-post surprisal over the scored window so the share page can rank
    // most- vs least-clanker posts (consistent with the headline aggregation).
    const kls = TEXT_MODELS.map((m) => {
      const kept = (perModel[m.id]?.perStep || []).filter(Boolean);
      if (!kept.length) return null;
      return -kept.reduce((s, p) => s + p.logprob, 0) / kept.length;
    }).filter((v) => v != null);
    const kl = kls.length ? Math.round((kls.reduce((a, b) => a + b, 0) / kls.length) * 100) / 100 : null;
    grid.push({ prompt: label, answer: t.text, cells, kl });
  }
  return grid;
}


// Add `n` to today's global call counter, returning the new total (or null on
// error). Fail-open everywhere: a counter glitch must never take scoring down.
async function addUsage(env, n) {
  if (!n) return null;
  try {
    const day = new Date().toISOString().slice(0, 10);
    const row = await env.DB.prepare(
      `INSERT INTO usage (day, calls) VALUES (?, ?)
       ON CONFLICT(day) DO UPDATE SET calls = calls + ?
       RETURNING calls`
    )
      .bind(day, n, n)
      .first();
    return row?.calls ?? null;
  } catch {
    return null;
  }
}

// Sub-classify a thin outcome so analytics can separate handle misses from
// honest low-content accounts:
//   placeholder — someone typed the literal input placeholder
//   too-short   — material exists, but <5 items have enough words
//   not-english — X only: originals exist, none pass the lang:en filter
//   no-posts    — nothing readable at all (dormant/wiped/squatted handle)
// The X no-lang probe costs one extra scraper call, on the (rare) thin path
// only; reddit needs no probe (comments come back unfiltered).
async function thinCause(env, handle, counts, platform = 'x') {
  if (['handle', 'name'].includes(String(handle).toLowerCase())) return 'placeholder';
  if ((counts?.fetched || 0) > 0) return 'too-short';
  if (platform === 'reddit') return 'no-posts';
  try {
    return (await probeOriginals(env, handle)) > 0 ? 'not-english' : 'no-posts';
  } catch {
    return 'unknown';
  }
}

// Resolve a result by key: a result UUID (self-tests, legacy account links),
// an X handle (/r/jack), or a redditor (/r/u/jack) — each resolving to that
// account's LATEST diagnosis, case-insensitive. The shapes can't collide:
// UUIDs are 36 chars with dashes, X handles ≤15 chars of [A-Za-z0-9_], and
// the u/ prefix marks reddit.
async function resultByKey(env, key) {
  if (/^[0-9a-fA-F-]{16,}$/.test(key)) {
    return env.DB.prepare('SELECT * FROM results WHERE id = ?').bind(key).first();
  }
  const rm = key.match(/^u\/([A-Za-z0-9_-]{3,20})$/i);
  const handle = rm ? rm[1] : /^[A-Za-z0-9_]{1,15}$/.test(key) ? key : null;
  if (!handle) return null;
  return env.DB.prepare(
    `SELECT * FROM results WHERE subject_type = 'account' AND lower(subject_handle) = ?
     AND COALESCE(subject_platform, 'x') = ? ORDER BY created_at DESC LIMIT 1`
  )
    .bind(handle.toLowerCase(), rm ? 'reddit' : 'x')
    .first();
}

// Whether a handle has opted out. Fail-open (treat errors as not-blocked) so a
// DB hiccup never wrongly refuses; the blocklist is a courtesy, not a security
// control.
async function isBlocked(env, handle) {
  try {
    const row = await env.DB.prepare('SELECT 1 FROM blocklist WHERE handle = ?')
      .bind(handle.toLowerCase())
      .first();
    return !!row;
  } catch {
    return false;
  }
}

// Bump today's counter by 1 and report whether the global daily cap is now
// exceeded. DAILY_CALL_CAP=0 (or unset) disables the cap.
async function overDailyCap(env) {
  const cap = Number(env.DAILY_CALL_CAP ?? 0);
  if (!cap) return false;
  const calls = await addUsage(env, 1);
  return calls != null && calls > cap;
}

// Share of other finished runs strictly less clanker than this score, compared
// within the same population: self-tests rank against humans, diagnosed
// accounts against accounts (the result copy names the population).
async function percentile(env, overall, subjectType = 'self') {
  const cond =
    subjectType === 'account'
      ? `subject_type = 'account'`
      : `(subject_type IS NULL OR subject_type = 'self')`;
  const { total } = await env.DB.prepare(`SELECT COUNT(*) AS total FROM results WHERE ${cond}`).first();
  if (total <= 1) return null;
  const { below } = await env.DB.prepare(
    `SELECT COUNT(*) AS below FROM results WHERE ${cond} AND overall < ?`
  )
    .bind(overall)
    .first();
  return Math.round((100 * below) / (total - 1));
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
