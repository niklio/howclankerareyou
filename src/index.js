import { QUESTIONS } from './questions.js';
import { MODELS, scoreModel, clankerScore, isMock, heatLevel } from './scoring.js';
import * as auth from './auth.js';
import { gatherAnalytics } from './analytics.js';
import { DASHBOARD_HTML } from './dashboard.js';

const ANALYTICS_HOST = 'analytics.howclankerareyou.com';
const ANALYTICS_URL = 'https://analytics.howclankerareyou.com/';
const CANONICAL = 'https://howclankerareyou.com';
const COOKIE_DOMAIN = '.howclankerareyou.com';
const SESSION_COOKIE = 'hcay_session';

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
    else if (request.method === 'GET' && /^\/r\/[0-9a-fA-F-]{8,}$/.test(url.pathname))
      logEvent(env, ctx, request, 'result_view');
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
    await auth.destroySession(env, auth.getCookie(request, SESSION_COOKIE));
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
    const email = await auth.sessionEmail(env, auth.getCookie(request, SESSION_COOKIE));
    const admin = auth.isAdmin(env, email);
    if (url.pathname === '/api/me') return json({ email: email || null, admin });
    if (!admin) return json({ error: 'forbidden' }, 403);
    if (url.pathname === '/api/analytics') return json(await gatherAnalytics(env));
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

  // Client-side event beacon (share taps). Only 'share' is client-loggable;
  // pageview/result_view are logged server-side to prevent inflation.
  if (request.method === 'POST' && pathname === '/api/event') {
    const body = await request.json().catch(() => ({}));
    if (body.type === 'share') logEvent(env, ctx, request, 'share', { session: body.session });
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
      percentile: await percentile(env, overall),
    });
  }

  if (request.method === 'GET' && pathname.startsWith('/api/result/')) {
    const id = pathname.slice('/api/result/'.length);
    const row = await env.DB.prepare('SELECT * FROM results WHERE id = ?').bind(id).first();
    if (!row) return json({ error: 'not found' }, 404);
    return json({
      id,
      overall: row.overall,
      perModel: JSON.parse(row.per_model),
      grid: row.grid ? JSON.parse(row.grid) : null,
      percentile: await percentile(env, row.overall),
    });
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

// Atomically bump today's scoring-call counter and report whether the global
// daily cap is exceeded. Fail-open: any error returns false so scoring survives
// a counter glitch. DAILY_CALL_CAP=0 (or unset default) disables the cap.
async function overDailyCap(env) {
  const cap = Number(env.DAILY_CALL_CAP ?? 0);
  if (!cap) return false;
  try {
    const day = new Date().toISOString().slice(0, 10);
    const row = await env.DB.prepare(
      `INSERT INTO usage (day, calls) VALUES (?, 1)
       ON CONFLICT(day) DO UPDATE SET calls = calls + 1
       RETURNING calls`
    )
      .bind(day)
      .first();
    return (row?.calls ?? 0) > cap;
  } catch {
    return false;
  }
}

// Share of other finished runs strictly less clanker than this score.
async function percentile(env, overall) {
  const { total } = await env.DB.prepare('SELECT COUNT(*) AS total FROM results').first();
  if (total <= 1) return null;
  const { below } = await env.DB.prepare(
    'SELECT COUNT(*) AS below FROM results WHERE overall < ?'
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
