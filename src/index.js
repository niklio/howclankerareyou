import { QUESTIONS } from './questions.js';
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
import { parseHandle, getUser, searchSamples } from './twitter.js';
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
    // Fire-and-forget traffic instrumentation.
    if (request.method === 'GET' && url.pathname === '/') logEvent(env, ctx, request, 'pageview');
    else if (['GET', 'HEAD'].includes(request.method) && /^\/r\/[0-9a-fA-F-]{8,}$/.test(url.pathname)) {
      // meta = the result id, so analytics can join views to results and
      // split account-result opens from self-test opens.
      if (request.method === 'GET')
        logEvent(env, ctx, request, 'result_view', { meta: url.pathname.slice(3) });
      // Result pages can name a real person (diagnosed X accounts), so keep
      // them out of search indexes. The SPA shell is shared, so we noindex all
      // /r/ pages via header; the homepage stays indexable.
      const res = await env.ASSETS.fetch(request);
      const headers = new Headers(res.headers);
      headers.set('x-robots-tag', 'noindex');
      return new Response(res.body, { status: res.status, headers });
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
      questions: QUESTIONS,
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

  // Diagnose an X account: resolve → pull recent posts → score each post
  // against every model → aggregate into the same result shape the share page
  // already renders. Costs many upstream calls, so it's rate-limited and
  // counts toward the daily cap.
  if (request.method === 'POST' && pathname === '/api/diagnose') {
    const tStart = Date.now();
    // Every exit logs exactly one `diagnose` event: outcome + timings (+ cache
    // flag and search-page count for cost tracking). The analytics dashboard
    // is built on these.
    const diag = (res, outcome, extra = {}) => {
      logEvent(env, ctx, request, 'diagnose', {
        meta: JSON.stringify({
          handle: extra.handle ? String(extra.handle).toLowerCase() : null,
          outcome,
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

    const body = await request.json().catch(() => ({}));
    const handle = parseHandle(body.input);
    if (!handle) {
      return diag(json({ error: "that doesn't look like an X handle", code: 'badinput' }, 400), 'badinput');
    }

    if (await isBlocked(env, handle)) {
      return diag(json({ error: 'this account asked to be removed from the tool', code: 'blocked' }, 403), 'blocked', { handle });
    }

    // Cache: serve a recent diagnosis of the same account instead of re-running
    // the scrape + 15 model walks. Checked before the daily-cap bump — a cache
    // hit costs nothing upstream. Percentile is recomputed (it drifts as more
    // accounts get graded).
    const cached = await env.DB.prepare(
      `SELECT * FROM results WHERE subject_type = 'account' AND lower(subject_handle) = ?
       AND created_at > ? ORDER BY created_at DESC LIMIT 1`
    )
      .bind(handle.toLowerCase(), Date.now() - DIAGNOSE_CACHE_MS)
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
    // One advanced-search call returns the account's original posts + author
    // metadata together (no user/info round-trip, no timeline pagination in
    // the common case). getUser runs only on the empty-result sad path to
    // distinguish protected / nonexistent / just-quiet accounts.
    let user, samples, counts;
    try {
      ({ user, samples, counts } = await searchSamples(env, handle, {
        maxTweets: SAMPLE_TWEETS,
        minWords: MIN_POST_WORDS,
      }));
    } catch (err) {
      return diag(json({ error: 'the post source is having a moment — try again in a sec', code: 'upstream' }, 502), 'upstream', { handle });
    }
    if (!user) {
      try {
        const u = await getUser(env, handle);
        if (u.protected)
          return diag(json({ error: `@${u.handle}'s posts are protected`, code: 'protected', handle: u.handle }, 422), 'protected', { handle: u.handle });
        return diag(
          json({ error: `not enough public posts to grade @${u.handle} fairly`, code: 'thin', handle: u.handle, kept: 0 }, 422),
          'thin',
          { handle: u.handle, pages: counts.pages }
        );
      } catch (err) {
        if (err.code === 'notfound')
          return diag(json({ error: `can't find @${handle} on X`, code: 'notfound' }, 404), 'notfound', { handle });
        return diag(json({ error: 'the post source is having a moment — try again in a sec', code: 'upstream' }, 502), 'upstream', { handle });
      }
    }
    if (samples.length < MIN_SAMPLE_TWEETS) {
      return diag(
        json({ error: `not enough public posts to grade @${user.handle} fairly`, code: 'thin', handle: user.handle, kept: samples.length }, 422),
        'thin',
        { handle: user.handle, pages: counts.pages }
      );
    }

    const tFetch = Date.now() - t0;

    // Score every (post × model) pair: one echo call each, all in parallel —
    // 15 calls total, no chains, well inside the Worker's connection budget.
    const jobs = [];
    for (const t of samples) for (const m of TEXT_MODELS) jobs.push({ t, m });
    const scored = await Promise.all(
      jobs.map(async ({ t, m }) => ({ t, m, r: await scorePostEcho(env, m, t.text, GRID_COLS) }))
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
    const grid = buildDiagnoseGrid(samples, byId, user.handle);
    const sources = samples.map((t) => ({ id: t.id, text: t.text }));

    // Persist off the critical path — the row lands in ~50ms, long before a
    // share link could plausibly be opened.
    const id = crypto.randomUUID();
    ctx?.waitUntil?.(
      env.DB.prepare(
        `INSERT INTO results (id, created_at, overall, per_model, grid, subject_type, subject_handle, subject_name, sources)
         VALUES (?, ?, ?, ?, ?, 'account', ?, ?, ?)`
      )
        .bind(
          id,
          Date.now(),
          overall,
          JSON.stringify(perModel),
          JSON.stringify(grid),
          user.handle,
          user.name,
          JSON.stringify(sources)
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
    const handle = parseHandle(body.handle);
    if (!handle) return json({ error: 'bad handle', code: 'badinput' }, 400);
    const lc = handle.toLowerCase();
    try {
      await env.DB.prepare('INSERT OR IGNORE INTO blocklist (handle, created_at) VALUES (?, ?)')
        .bind(lc, Date.now())
        .run();
      await env.DB.prepare(
        "DELETE FROM results WHERE subject_type = 'account' AND lower(subject_handle) = ?"
      )
        .bind(lc)
        .run();
    } catch (err) {
      return json({ error: 'could not remove — try again', code: 'upstream' }, 500);
    }
    logEvent(env, ctx, request, 'optout', { meta: lc });
    return json({ ok: true });
  }

  if (request.method === 'GET' && pathname.startsWith('/api/result/')) {
    const id = pathname.slice('/api/result/'.length);
    const row = await env.DB.prepare('SELECT * FROM results WHERE id = ?').bind(id).first();
    if (!row) return json({ error: 'not found' }, 404);
    const out = {
      id,
      overall: row.overall,
      perModel: JSON.parse(row.per_model),
      grid: row.grid ? JSON.parse(row.grid) : null,
      percentile: await percentile(env, row.overall, row.subject_type === 'account' ? 'account' : 'self'),
    };
    if (row.subject_type === 'account') {
      out.subject = {
        type: 'account',
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
// all models: its heat is the mean word surprisal across models.
function buildDiagnoseGrid(samples, byId, handle) {
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
    grid.push({ prompt: `@${handle}`, answer: t.text, cells, kl });
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
