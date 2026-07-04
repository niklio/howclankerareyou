// Google OAuth (authorization-code flow) + D1-backed admin sessions for the
// analytics dashboard. Mirrors the clawcast pattern: OAuth is pinned to the
// canonical apex host so the redirect_uri always matches what Google has
// registered, and the session cookie is scoped to .howclankerareyou.com so a
// login on the apex authenticates the analytics subdomain too.

const SESSION_DAYS = 30;

export function googleAuthUrl(env, redirectUri, state) {
  const p = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'openid email profile',
    state,
    access_type: 'online',
    prompt: 'select_account',
  });
  return 'https://accounts.google.com/o/oauth2/v2/auth?' + p.toString();
}

export async function exchangeCode(env, code, redirectUri) {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    }),
  });
  const tok = await res.json();
  if (!tok.id_token) throw new Error('token exchange failed');
  // The id_token came directly from Google's token endpoint over TLS, so we
  // read the email from its payload without re-verifying the signature.
  const b64 = tok.id_token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
  const payload = JSON.parse(atob(b64));
  if (!payload.email) throw new Error('no email in token');
  return { email: String(payload.email).toLowerCase(), verified: payload.email_verified };
}

export async function createSession(env, email) {
  const id = (crypto.randomUUID() + crypto.randomUUID()).replace(/-/g, '');
  const now = Date.now();
  await env.DB.prepare(
    'INSERT INTO web_sessions (id, email, created_at, expires_at) VALUES (?, ?, ?, ?)'
  )
    .bind(id, email, now, now + SESSION_DAYS * 86400 * 1000)
    .run();
  return id;
}

export async function sessionEmail(env, sid) {
  if (!sid) return null;
  const row = await env.DB.prepare(
    'SELECT email, expires_at FROM web_sessions WHERE id = ?'
  )
    .bind(sid)
    .first();
  if (!row || row.expires_at < Date.now()) return null;
  return row.email;
}

// Resolve a session from ALL cookies with this name, not just the first.
// Browsers can hold duplicate same-name cookies (host-only vs domain-scoped,
// or a stale one that outlived a DB migration) and send the stale one first —
// which shadowed fresh logins with a permanent 403 until it expired.
export async function sessionEmailFrom(env, request, name) {
  for (const sid of getCookies(request, name)) {
    const email = await sessionEmail(env, sid);
    if (email) return email;
  }
  return null;
}

export async function destroySessionsFrom(env, request, name) {
  for (const sid of getCookies(request, name)) await destroySession(env, sid);
}

export async function destroySession(env, sid) {
  if (sid) await env.DB.prepare('DELETE FROM web_sessions WHERE id = ?').bind(sid).run();
}

export function isAdmin(env, email) {
  const allowed = (env.ADMIN_EMAILS || '')
    .toLowerCase()
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return !!email && allowed.includes(email.toLowerCase());
}

// --- cookie helpers ---

export function getCookie(request, name) {
  return getCookies(request, name)[0] ?? null;
}

export function getCookies(request, name) {
  const raw = request.headers.get('cookie') || '';
  const values = [];
  for (const part of raw.split(/;\s*/)) {
    const eq = part.indexOf('=');
    if (eq > 0 && part.slice(0, eq) === name) values.push(decodeURIComponent(part.slice(eq + 1)));
  }
  return values;
}

export function cookieHeader(name, value, { maxAge, domain } = {}) {
  let c = `${name}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax`;
  if (domain) c += `; Domain=${domain}`;
  if (maxAge != null) c += `; Max-Age=${maxAge}`;
  return c;
}
