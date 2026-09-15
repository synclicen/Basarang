// auth.js — autentikasi berbasis D1 (sinkron lintas perangkat)
// - PBKDF2-SHA256 25.000 iterasi (~5ms CPU, aman untuk batas 10ms Workers Free)
//   dikombinasikan rate-limit login 10 percobaan / 15 menit per username.
// - Sesi: token acak 256-bit disimpan di D1 (bukan localStorage), cookie HttpOnly,
//   sehingga login di perangkat mana pun langsung sinkron.
// - Format hash: pbkdf2:<iter>:<salt-hex>:<hash-hex> (iterasi bisa dinaikkan nanti).

const PBKDF2_ITERATIONS = 25000;
export const SESSION_COOKIE = 'basarang_session';
export const SESSION_TTL_SEC = 30 * 24 * 3600; // 30 hari
const LOGIN_WINDOW_SEC = 15 * 60; // 15 menit
const LOGIN_MAX_ATTEMPTS = 10;

const enc = new TextEncoder();

function toHex(bytes) {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}
function fromHex(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}

async function derive(password, salt, iterations) {
  const baseKey = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
    baseKey,
    256
  );
  return new Uint8Array(bits);
}

export async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await derive(password, salt, PBKDF2_ITERATIONS);
  return `pbkdf2:${PBKDF2_ITERATIONS}:${toHex(salt)}:${toHex(hash)}`;
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

export async function verifyPassword(password, stored) {
  try {
    const parts = String(stored || '').split(':');
    if (parts.length !== 4 || parts[0] !== 'pbkdf2') return false;
    const iterations = parseInt(parts[1], 10);
    if (!Number.isFinite(iterations) || iterations <= 0) return false;
    const salt = fromHex(parts[2]);
    const expected = fromHex(parts[3]);
    const actual = await derive(password, salt, iterations);
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

// ---------- Cookie ----------

export function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

export function sessionCookieHeader(token, maxAgeSec) {
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAgeSec}`;
}
export function clearSessionCookieHeader() {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

// ---------- Sesi ----------

export function generateToken() {
  return toHex(crypto.getRandomValues(new Uint8Array(32)));
}

export async function createSession(db, userId, userAgent) {
  const token = generateToken();
  const now = new Date();
  const expires = new Date(now.getTime() + SESSION_TTL_SEC * 1000);
  await db
    .prepare('INSERT INTO sessions (token, user_id, created_at, expires_at, user_agent) VALUES (?, ?, ?, ?, ?)')
    .bind(token, userId, now.toISOString(), expires.toISOString(), String(userAgent || '').slice(0, 250))
    .run();
  return token;
}

export async function destroySession(db, token) {
  if (!token) return;
  await db.prepare('DELETE FROM sessions WHERE token = ?').bind(token).run();
}

export async function getSessionUser(db, request) {
  const cookies = parseCookies(request.headers.get('cookie'));
  const token = cookies[SESSION_COOKIE];
  if (!token || !/^[0-9a-f]{64}$/.test(token)) return null;
  const row = await db
    .prepare(
      `SELECT u.id, u.username, u.email, u.display_name, u.role, u.is_active, u.last_login_at,
              s.token AS session_token, s.expires_at
         FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.token = ?`
    )
    .bind(token)
    .first();
  if (!row) return null;
  if (String(row.is_active) !== '1') return null;
  if (new Date(row.expires_at).getTime() <= Date.now()) {
    await destroySession(db, token);
    return null;
  }
  return {
    id: row.id,
    username: row.username,
    email: row.email,
    display_name: row.display_name,
    role: row.role,
    last_login_at: row.last_login_at,
    sessionToken: row.session_token,
  };
}

// ---------- Rate limit login ----------

export async function checkLoginRateLimit(db, username) {
  const row = await db
    .prepare('SELECT count, window_start FROM login_attempts WHERE username = ?')
    .bind(username)
    .first();
  if (!row) return { allowed: true };
  const ageMs = Date.now() - new Date(row.window_start).getTime();
  if (ageMs >= LOGIN_WINDOW_SEC * 1000) return { allowed: true };
  if (row.count >= LOGIN_MAX_ATTEMPTS) {
    const waitMin = Math.max(1, Math.ceil((LOGIN_WINDOW_SEC * 1000 - ageMs) / 60000));
    return { allowed: false, waitMin };
  }
  return { allowed: true };
}

export async function recordLoginFailure(db, username) {
  const now = new Date().toISOString();
  const row = await db
    .prepare('SELECT count, window_start FROM login_attempts WHERE username = ?')
    .bind(username)
    .first();
  if (!row || Date.now() - new Date(row.window_start).getTime() >= LOGIN_WINDOW_SEC * 1000) {
    await db
      .prepare(
        'INSERT INTO login_attempts (username, count, window_start) VALUES (?, 1, ?) ' +
          'ON CONFLICT(username) DO UPDATE SET count = 1, window_start = excluded.window_start'
      )
      .bind(username, now)
      .run();
  } else {
    await db
      .prepare('UPDATE login_attempts SET count = count + 1 WHERE username = ?')
      .bind(username)
      .run();
  }
}

export async function clearLoginAttempts(db, username) {
  await db.prepare('DELETE FROM login_attempts WHERE username = ?').bind(username).run();
}

// Bersih-bersigi berkala (murah: hanya saat login sukses)
export async function cleanupOnLogin(db) {
  const cutoff = new Date(Date.now() - LOGIN_WINDOW_SEC * 1000).toISOString();
  await db.batch([
    db.prepare('DELETE FROM sessions WHERE expires_at <= ?').bind(new Date().toISOString()),
    db.prepare('DELETE FROM login_attempts WHERE window_start < ?').bind(cutoff),
  ]);
}
