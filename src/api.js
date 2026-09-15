// api.js — seluruh endpoint API Basarang: Bagarak Saurang
// Konvensi respons: { ok: true, data: ... } atau { ok: false, error, message }

import { nowIso } from './db.js';
import * as auth from './auth.js';

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' };
const MAX_BODY_BYTES = 300000; // 300 KB — naskah dibatasi 100.000 karakter
const MAX_SCRIPT_CHARS = 100000; // ~1,5 jam pidato; TANPA batasan demo 700 karakter
const ROLES = ['super_admin', 'manager', 'member'];

export class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), { status, headers: { ...JSON_HEADERS, ...headers } });
}
function ok(data) {
  return json({ ok: true, data });
}
function fail(status, code, message) {
  return json({ ok: false, error: code, message }, status);
}

// ---------- Validasi ----------

function reqStr(v, name, min, max) {
  if (typeof v !== 'string') throw new HttpError(400, 'validation', `Field ${name} wajib berupa teks.`);
  const s = v.trim();
  if (s.length < min) throw new HttpError(400, 'validation', `Field ${name} minimal ${min} karakter.`);
  if (s.length > max) throw new HttpError(400, 'validation', `Field ${name} maksimal ${max} karakter.`);
  return s;
}
function optStr(v, name, max) {
  if (v === undefined || v === null || v === '') return '';
  return reqStr(v, name, 1, max);
}
function validUsername(v) {
  const s = String(v || '').trim().toLowerCase();
  if (!/^[a-z0-9._-]{3,30}$/.test(s)) {
    throw new HttpError(400, 'validation', 'Username 3-30 karakter, hanya huruf kecil, angka, titik, garis bawah, strip.');
  }
  return s;
}
function validPassword(v) {
  if (typeof v !== 'string' || v.length < 8 || v.length > 128) {
    throw new HttpError(400, 'validation', 'Kata sandi 8-128 karakter.');
  }
  return v;
}
function validRole(v) {
  if (!ROLES.includes(v)) throw new HttpError(400, 'validation', 'Peran tidak valid.');
  return v;
}
function validWpm(v) {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 60 || n > 250) {
    throw new HttpError(400, 'validation', 'Kecepatan baca (KPM) harus bilangan bulat 60-250.');
  }
  return n;
}
function validEmail(v) {
  const s = String(v || '').trim();
  if (!s) return null;
  if (s.length > 120 || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(s)) {
    throw new HttpError(400, 'validation', 'Format email tidak valid.');
  }
  return s.toLowerCase();
}
function parseId(v) {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0 || n > Number.MAX_SAFE_INTEGER) {
    throw new HttpError(400, 'validation', 'ID tidak valid.');
  }
  return n;
}

function requireUser(user) {
  if (!user) throw new HttpError(401, 'auth', 'Silakan masuk terlebih dahulu.');
  return user;
}
function requireAdmin(user) {
  requireUser(user);
  if (user.role !== 'super_admin') throw new HttpError(403, 'forbidden', 'Akses khusus super admin.');
  return user;
}

// ---------- CSRF: origin & sec-fetch-site ----------

function assertSameOrigin(request, url) {
  const method = request.method.toUpperCase();
  if (['GET', 'HEAD', 'OPTIONS'].includes(method)) return;
  const site = request.headers.get('sec-fetch-site');
  if (site && site !== 'same-origin' && site !== 'same-site' && site !== 'none') {
    throw new HttpError(403, 'csrf', 'Permintaan lintas situs ditolak.');
  }
  const origin = request.headers.get('origin');
  if (origin) {
    try {
      if (new URL(origin).host !== url.host) throw new HttpError(403, 'csrf', 'Origin tidak cocok.');
    } catch (e) {
      if (e instanceof HttpError) throw e;
      throw new HttpError(403, 'csrf', 'Origin tidak valid.');
    }
  }
}

async function readJsonBody(request) {
  const len = Number(request.headers.get('content-length') || '0');
  if (len > MAX_BODY_BYTES) throw new HttpError(413, 'too_large', 'Payload terlalu besar (maks 300 KB).');
  const ctype = (request.headers.get('content-type') || '').split(';')[0].trim();
  if (ctype !== 'application/json') {
    throw new HttpError(400, 'validation', 'Content-Type harus application/json.');
  }
  let body;
  try {
    body = await request.json();
  } catch {
    throw new HttpError(400, 'validation', 'Body JSON tidak valid.');
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new HttpError(400, 'validation', 'Body harus objek JSON.');
  }
  return body;
}

// ---------- Akses proyek ----------

// Mengembalikan { project, role } atau null bila tidak ada akses.
// role: 'owner' | 'member' | 'viewer' (viewer hanya untuk super_admin non-anggota)
async function getProjectAccess(db, projectId, user) {
  const project = await db.prepare('SELECT * FROM projects WHERE id = ?').bind(projectId).first();
  if (!project) return null;
  if (user.role === 'super_admin') {
    if (project.owner_id === user.id) return { project, role: 'owner' };
    const m = await db
      .prepare('SELECT 1 AS x FROM project_members WHERE project_id = ? AND user_id = ?')
      .bind(projectId, user.id)
      .first();
    return { project, role: m ? 'member' : 'viewer' };
  }
  if (project.owner_id === user.id) return { project, role: 'owner' };
  const m = await db
    .prepare('SELECT 1 AS x FROM project_members WHERE project_id = ? AND user_id = ?')
    .bind(projectId, user.id)
    .first();
  return m ? { project, role: 'member' } : null;
}

function canManageProject(role, user) {
  return role === 'owner' || user.role === 'super_admin';
}

function publicUser(u) {
  return {
    id: u.id,
    username: u.username,
    email: u.email,
    display_name: u.display_name,
    role: u.role,
    is_active: String(u.is_active) === '1',
    created_at: u.created_at,
    last_login_at: u.last_login_at,
  };
}

// ---------- Router ----------

export async function handleApi(request, env, url) {
  const db = env.DB;
  assertSameOrigin(request, url);
  const user = await auth.getSessionUser(db, request);

  const path = url.pathname.replace(/\/+$/, '') || '/';
  const method = request.method.toUpperCase();
  let m;

  if (path === '/api/health') {
    return ok({ name: 'Basarang: Bagarak Saurang', status: 'ok', time: nowIso() });
  }

  // ----- Autentikasi -----

  if (path === '/api/auth/me' && method === 'GET') {
    if (user) return ok({ user, needsSetup: false });
    const row = await db.prepare('SELECT COUNT(*) AS c FROM users').first();
    return ok({ user: null, needsSetup: (row ? row.c : 0) === 0 });
  }

  if (path === '/api/auth/setup' && method === 'POST') {
    const body = await readJsonBody(request);
    const count = await db.prepare('SELECT COUNT(*) AS c FROM users').first();
    if (count && count.c > 0) throw new HttpError(403, 'forbidden', 'Inisialisasi sudah selesai. Silakan masuk.');
    const username = validUsername(body.username);
    const password = validPassword(body.password);
    const displayName = optStr(body.display_name, 'nama tampilan', 60) || username;
    const email = validEmail(body.email);
    const pwHash = await auth.hashPassword(password);
    const now = nowIso();
    // Atomik: tandai setup selesai + buat super admin pertama
    const res = await db.batch([
      db
        .prepare('INSERT INTO app_meta (key, value) VALUES (?, ?)')
        .bind('setup_done', now),
      db
        .prepare(
          'INSERT INTO users (username, email, display_name, password_hash, role, is_active, created_at, last_login_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?)'
        )
        .bind(username, email, displayName, pwHash, 'super_admin', now, now),
    ]);
    const userId = Number(res[1].meta.last_row_id);
    const token = await auth.createSession(db, userId, request.headers.get('user-agent'));
    return json(
      { ok: true, data: { user: { id: userId, username, email, display_name: displayName, role: 'super_admin' } } },
      201,
      { 'set-cookie': auth.sessionCookieHeader(token, auth.SESSION_TTL_SEC) }
    );
  }

  if (path === '/api/auth/login' && method === 'POST') {
    const body = await readJsonBody(request);
    const username = validUsername(body.username);
    const password = typeof body.password === 'string' ? body.password : '';
    const row = await db.prepare('SELECT * FROM users WHERE username = ?').bind(username).first();
    const pwOk = row ? await auth.verifyPassword(password, row.password_hash) : false;
    if (!row || !pwOk || String(row.is_active) !== '1') {
      // Upaya gagal tercatat; melewati batas → 429. Kata sandi benar tetap diizinkan
      // agar pengguna sah tidak terkunci karena salah ketik berkali-kali.
      await auth.recordLoginFailure(db, username);
      const rl = await auth.checkLoginRateLimit(db, username);
      if (!rl.allowed) {
        return fail(429, 'rate_limited', `Terlalu banyak percobaan gagal. Coba lagi dalam ~${rl.waitMin} menit.`);
      }
      // Pesan seragam agar tidak membocorkan keberadaan username
      throw new HttpError(401, 'auth', 'Username atau kata sandi salah.');
    }
    await auth.clearLoginAttempts(db, username);
    await auth.cleanupOnLogin(db);
    await db.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').bind(nowIso(), row.id).run();
    const token = await auth.createSession(db, row.id, request.headers.get('user-agent'));
    return json(
      { ok: true, data: { user: publicUser({ ...row, last_login_at: nowIso() }) } },
      200,
      { 'set-cookie': auth.sessionCookieHeader(token, auth.SESSION_TTL_SEC) }
    );
  }

  if (path === '/api/auth/password' && method === 'POST') {
    requireUser(user);
    const body = await readJsonBody(request);
    const current = typeof body.current === 'string' ? body.current : '';
    const next = validPassword(body.next);
    const row = await db.prepare('SELECT * FROM users WHERE id = ?').bind(user.id).first();
    const pwOk = row ? await auth.verifyPassword(current, row.password_hash) : false;
    if (!pwOk) throw new HttpError(401, 'auth', 'Kata sandi saat ini salah.');
    const pwHash = await auth.hashPassword(next);
    await db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').bind(pwHash, user.id).run();
    // Musnahkan sesi lain, tapi pertahankan sesi aktif agar tidak langsung terlogout
    await db.prepare('DELETE FROM sessions WHERE user_id = ? AND token != ?').bind(user.id, user.sessionToken).run();
    return ok({ changed: true });
  }

  if (path === '/api/auth/logout' && method === 'POST') {
    if (user) await auth.destroySession(db, user.sessionToken);
    return json({ ok: true, data: { loggedOut: true } }, 200, {
      'set-cookie': auth.clearSessionCookieHeader(),
    });
  }

  // ----- Proyek -----

  if (path === '/api/projects' && method === 'GET') {
    requireUser(user);
    let rows;
    if (user.role === 'super_admin') {
      rows = await db
        .prepare(
          `SELECT p.id, p.name, p.description, p.status, p.owner_id, p.created_at, p.updated_at,
                  u.username AS owner_username, u.display_name AS owner_name,
                  (SELECT COUNT(*) FROM scripts s WHERE s.project_id = p.id) AS script_count,
                  (SELECT COUNT(*) FROM project_members mm WHERE mm.project_id = p.id) AS member_count,
                  CASE WHEN p.owner_id = ? THEN 'owner'
                       WHEN EXISTS(SELECT 1 FROM project_members m2 WHERE m2.project_id = p.id AND m2.user_id = ?) THEN 'member'
                       ELSE 'viewer' END AS my_role
             FROM projects p JOIN users u ON u.id = p.owner_id
            ORDER BY p.created_at DESC`
        )
        .bind(user.id, user.id)
        .all();
    } else {
      rows = await db
        .prepare(
          `SELECT * FROM (
             SELECT p.id, p.name, p.description, p.status, p.owner_id, p.created_at, p.updated_at,
                    u.username AS owner_username, u.display_name AS owner_name,
                    (SELECT COUNT(*) FROM scripts s WHERE s.project_id = p.id) AS script_count,
                    (SELECT COUNT(*) FROM project_members mm WHERE mm.project_id = p.id) AS member_count,
                    'owner' AS my_role
               FROM projects p JOIN users u ON u.id = p.owner_id
              WHERE p.owner_id = ?
             UNION ALL
             SELECT p.id, p.name, p.description, p.status, p.owner_id, p.created_at, p.updated_at,
                    u.username AS owner_username, u.display_name AS owner_name,
                    (SELECT COUNT(*) FROM scripts s WHERE s.project_id = p.id) AS script_count,
                    (SELECT COUNT(*) FROM project_members mm WHERE mm.project_id = p.id) AS member_count,
                    'member' AS my_role
               FROM projects p JOIN users u ON u.id = p.owner_id
                    JOIN project_members m ON m.project_id = p.id
              WHERE m.user_id = ? AND p.owner_id != ?
           ) ORDER BY created_at DESC`
        )
        .bind(user.id, user.id, user.id)
        .all();
    }
    return ok({ projects: rows.results || [] });
  }

  if (path === '/api/projects' && method === 'POST') {
    requireUser(user);
    const body = await readJsonBody(request);
    const name = reqStr(body.name, 'nama proyek', 2, 120);
    const description = optStr(body.description, 'deskripsi', 600);
    // Guard kirim-ganda: proyek bernama sama oleh pemilik sama dalam 15 detik terakhir
    // dikembalikan yang sudah ada — mencegah proyek dobel karena klik dua kali / jaringan lambat.
    const cutoff = new Date(Date.now() - 15000).toISOString();
    const recent = await db
      .prepare('SELECT * FROM projects WHERE owner_id = ? AND name = ? AND created_at > ? ORDER BY id DESC LIMIT 1')
      .bind(user.id, name, cutoff)
      .first();
    if (recent) return json({ ok: true, data: { project: recent } }, 201);
    const now = nowIso();
    const res = await db
      .prepare('INSERT INTO projects (name, description, owner_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(name, description, user.id, 'active', now, now)
      .run();
    const project = await db.prepare('SELECT * FROM projects WHERE id = ?').bind(res.meta.last_row_id).first();
    return json({ ok: true, data: { project } }, 201);
  }

  if ((m = path.match(/^\/api\/projects\/(\d+)$/))) {
    const projectId = parseId(m[1]);
    if (method === 'GET') {
      requireUser(user);
      const acc = await getProjectAccess(db, projectId, user);
      if (!acc) throw new HttpError(404, 'not_found', 'Proyek tidak ditemukan atau Anda tidak punya akses.');
      const [scripts, members, owner] = await Promise.all([
        db.prepare('SELECT * FROM scripts WHERE project_id = ? ORDER BY updated_at DESC').bind(projectId).all(),
        db
          .prepare(
            `SELECT pm.user_id, pm.role AS member_role, pm.added_at, u.username, u.display_name
               FROM project_members pm JOIN users u ON u.id = pm.user_id
              WHERE pm.project_id = ? ORDER BY pm.added_at ASC`
          )
          .bind(projectId)
          .all(),
        db
          .prepare('SELECT username, display_name FROM users WHERE id = ?')
          .bind(acc.project.owner_id)
          .first(),
      ]);
      return ok({
        project: acc.project,
        scripts: scripts.results || [],
        members: members.results || [],
        owner: owner || { username: '?', display_name: '?' },
        my_role: acc.role,
        can_manage: canManageProject(acc.role, user),
      });
    }
    if (method === 'PATCH' || method === 'DELETE') {
      requireUser(user);
      const acc = await getProjectAccess(db, projectId, user);
      if (!acc) throw new HttpError(404, 'not_found', 'Proyek tidak ditemukan atau Anda tidak punya akses.');
      if (!canManageProject(acc.role, user)) {
        throw new HttpError(403, 'forbidden', 'Hanya pemilik proyek atau super admin yang dapat mengubah/menghapus proyek.');
      }
      if (method === 'DELETE') {
        await db.batch([
          db.prepare('DELETE FROM scripts WHERE project_id = ?').bind(projectId),
          db.prepare('DELETE FROM project_members WHERE project_id = ?').bind(projectId),
          db.prepare('DELETE FROM projects WHERE id = ?').bind(projectId),
        ]);
        return ok({ deleted: true });
      }
      const body = await readJsonBody(request);
      const name = body.name !== undefined ? reqStr(body.name, 'nama proyek', 2, 120) : acc.project.name;
      const description =
        body.description !== undefined ? optStr(body.description, 'deskripsi', 600) : acc.project.description;
      const status =
        body.status !== undefined
          ? ['active', 'archived'].includes(body.status)
            ? body.status
            : (() => {
                throw new HttpError(400, 'validation', 'Status hanya active/archived.');
              })()
          : acc.project.status;
      await db
        .prepare('UPDATE projects SET name = ?, description = ?, status = ?, updated_at = ? WHERE id = ?')
        .bind(name, description, status, nowIso(), projectId)
        .run();
      const project = await db.prepare('SELECT * FROM projects WHERE id = ?').bind(projectId).first();
      return ok({ project });
    }
  }

  // ----- Anggota proyek -----

  if ((m = path.match(/^\/api\/projects\/(\d+)\/members$/)) && method === 'POST') {
    requireUser(user);
    const projectId = parseId(m[1]);
    const acc = await getProjectAccess(db, projectId, user);
    if (!acc) throw new HttpError(404, 'not_found', 'Proyek tidak ditemukan.');
    if (!canManageProject(acc.role, user)) throw new HttpError(403, 'forbidden', 'Hanya pemilik proyek atau super admin yang dapat menambah anggota.');
    const body = await readJsonBody(request);
    const username = validUsername(body.username);
    const target = await db.prepare('SELECT * FROM users WHERE username = ?').bind(username).first();
    if (!target) throw new HttpError(404, 'not_found', `Pengguna "${username}" tidak ditemukan.`);
    if (target.id === acc.project.owner_id) throw new HttpError(409, 'conflict', 'Pemilik proyek tidak perlu ditambahkan sebagai anggota.');
    const exists = await db
      .prepare('SELECT 1 AS x FROM project_members WHERE project_id = ? AND user_id = ?')
      .bind(projectId, target.id)
      .first();
    if (exists) throw new HttpError(409, 'conflict', `${username} sudah menjadi anggota.`);
    const count = await db
      .prepare('SELECT COUNT(*) AS c FROM project_members WHERE project_id = ?')
      .bind(projectId)
      .first();
    if (count && count.c >= 50) throw new HttpError(400, 'validation', 'Maksimal 50 anggota per proyek.');
    await db
      .prepare('INSERT INTO project_members (project_id, user_id, role, added_at) VALUES (?, ?, ?, ?)')
      .bind(projectId, target.id, 'member', nowIso())
      .run();
    return json(
      { ok: true, data: { user_id: target.id, username: target.username, display_name: target.display_name, member_role: 'member', added_at: nowIso() } },
      201
    );
  }

  if ((m = path.match(/^\/api\/projects\/(\d+)\/members\/(\d+)$/)) && method === 'DELETE') {
    requireUser(user);
    const projectId = parseId(m[1]);
    const targetUserId = parseId(m[2]);
    const acc = await getProjectAccess(db, projectId, user);
    if (!acc) throw new HttpError(404, 'not_found', 'Proyek tidak ditemukan.');
    const selfLeave = targetUserId === user.id && acc.role === 'member';
    if (!canManageProject(acc.role, user) && !selfLeave) {
      throw new HttpError(403, 'forbidden', 'Tidak diizinkan menghapus anggota ini.');
    }
    await db
      .prepare('DELETE FROM project_members WHERE project_id = ? AND user_id = ?')
      .bind(projectId, targetUserId)
      .run();
    return ok({ removed: true });
  }

  // ----- Naskah (scripts) -----

  if ((m = path.match(/^\/api\/projects\/(\d+)\/scripts$/)) && method === 'POST') {
    requireUser(user);
    const projectId = parseId(m[1]);
    const acc = await getProjectAccess(db, projectId, user);
    if (!acc) throw new HttpError(404, 'not_found', 'Proyek tidak ditemukan atau Anda tidak punya akses.');
    const body = await readJsonBody(request);
    const title = reqStr(body.title, 'judul naskah', 2, 120);
    const content = optStr(body.content, 'isi naskah', MAX_SCRIPT_CHARS);
    const wpm = body.words_per_minute !== undefined ? validWpm(body.words_per_minute) : 140;
    // Guard kirim-ganda: naskah berjudul sama oleh pembuat sama pada proyek sama dalam 15 detik
    // dikembalikan yang sudah ada — mencegah naskah dobel (autosave vs klik Simpan beririsan).
    const cutoff = new Date(Date.now() - 15000).toISOString();
    const recent = await db
      .prepare('SELECT * FROM scripts WHERE project_id = ? AND title = ? AND created_by = ? AND created_at > ? ORDER BY id DESC LIMIT 1')
      .bind(projectId, title, user.id, cutoff)
      .first();
    if (recent) return json({ ok: true, data: { script: recent } }, 201);
    const now = nowIso();
    const res = await db
      .prepare(
        'INSERT INTO scripts (project_id, title, content, words_per_minute, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
      )
      .bind(projectId, title, content, wpm, user.id, now, now)
      .run();
    const script = await db.prepare('SELECT * FROM scripts WHERE id = ?').bind(res.meta.last_row_id).first();
    return json({ ok: true, data: { script } }, 201);
  }

  if ((m = path.match(/^\/api\/scripts\/(\d+)$/))) {
    const scriptId = parseId(m[1]);
    if (method === 'GET') {
      requireUser(user);
      const script = await db.prepare('SELECT * FROM scripts WHERE id = ?').bind(scriptId).first();
      if (!script) throw new HttpError(404, 'not_found', 'Naskah tidak ditemukan.');
      const acc = await getProjectAccess(db, script.project_id, user);
      if (!acc) throw new HttpError(403, 'forbidden', 'Anda tidak punya akses ke naskah ini.');
      return ok({ script, project: acc.project, my_role: acc.role, can_manage: canManageProject(acc.role, user) });
    }
    if (method === 'PUT' || method === 'PATCH' || method === 'DELETE') {
      requireUser(user);
      const script = await db.prepare('SELECT * FROM scripts WHERE id = ?').bind(scriptId).first();
      if (!script) throw new HttpError(404, 'not_found', 'Naskah tidak ditemukan.');
      const acc = await getProjectAccess(db, script.project_id, user);
      if (!acc) throw new HttpError(403, 'forbidden', 'Anda tidak punya akses ke naskah ini.');
      const isOwnerOrAdmin = canManageProject(acc.role, user);
      const isOwnScript = acc.role === 'member' && script.created_by === user.id;
      if (!isOwnerOrAdmin && !isOwnScript) {
        throw new HttpError(403, 'forbidden', 'Anggota hanya dapat mengubah naskah yang dibuatnya sendiri.');
      }
      if (method === 'DELETE') {
        if (!isOwnerOrAdmin) throw new HttpError(403, 'forbidden', 'Hanya pemilik proyek atau super admin yang dapat menghapus naskah.');
        await db.prepare('DELETE FROM scripts WHERE id = ?').bind(scriptId).run();
        return ok({ deleted: true });
      }
      const body = await readJsonBody(request);
      const title = body.title !== undefined ? reqStr(body.title, 'judul naskah', 2, 120) : script.title;
      const content = body.content !== undefined ? optStr(body.content, 'isi naskah', MAX_SCRIPT_CHARS) : script.content;
      const wpm =
        body.words_per_minute !== undefined ? validWpm(body.words_per_minute) : script.words_per_minute;
      await db
        .prepare('UPDATE scripts SET title = ?, content = ?, words_per_minute = ?, updated_at = ? WHERE id = ?')
        .bind(title, content, wpm, nowIso(), scriptId)
        .run();
      const updated = await db.prepare('SELECT * FROM scripts WHERE id = ?').bind(scriptId).first();
      return ok({ script: updated });
    }
  }

  // ----- Pencarian pengguna (untuk tambah anggota) -----

  if (path === '/api/users/search' && method === 'GET') {
    requireUser(user);
    const q = String(url.searchParams.get('q') || '').trim().toLowerCase();
    if (q.length < 2) return ok({ users: [] });
    const like = `%${q.replace(/[\\%_]/g, (c) => '\\' + c)}%`;
    const rows = await db
      .prepare(
        `SELECT id, username, display_name FROM users
          WHERE is_active = 1 AND (username LIKE ? ESCAPE '\\' OR display_name LIKE ? ESCAPE '\\')
          ORDER BY username LIMIT 8`
      )
      .bind(like, like)
      .all();
    return ok({ users: rows.results || [] });
  }

  // ----- Manajemen pengguna (super admin) -----

  if (path === '/api/users' && method === 'GET') {
    requireAdmin(user);
    const rows = await db
      .prepare(
        `SELECT u.id, u.username, u.email, u.display_name, u.role, u.is_active, u.created_at, u.last_login_at,
                (SELECT COUNT(*) FROM projects p WHERE p.owner_id = u.id) AS projects_owned,
                (SELECT COUNT(*) FROM project_members pm WHERE pm.user_id = u.id) AS memberships
           FROM users u ORDER BY u.created_at ASC`
      )
      .all();
    return ok({ users: rows.results || [] });
  }

  if (path === '/api/users' && method === 'POST') {
    requireAdmin(user);
    const body = await readJsonBody(request);
    const username = validUsername(body.username);
    const password = validPassword(body.password);
    const displayName = optStr(body.display_name, 'nama tampilan', 60) || username;
    const email = validEmail(body.email);
    const role = validRole(body.role);
    const exists = await db.prepare('SELECT 1 AS x FROM users WHERE username = ?').bind(username).first();
    if (exists) throw new HttpError(409, 'conflict', `Username "${username}" sudah dipakai.`);
    if (email) {
      const emailUsed = await db.prepare('SELECT 1 AS x FROM users WHERE email = ?').bind(email).first();
      if (emailUsed) throw new HttpError(409, 'conflict', 'Email sudah dipakai pengguna lain.');
    }
    const pwHash = await auth.hashPassword(password);
    const res = await db
      .prepare(
        'INSERT INTO users (username, email, display_name, password_hash, role, is_active, created_at) VALUES (?, ?, ?, ?, ?, 1, ?)'
      )
      .bind(username, email, displayName, pwHash, role, nowIso())
      .run();
    const created = await db.prepare('SELECT * FROM users WHERE id = ?').bind(res.meta.last_row_id).first();
    return json({ ok: true, data: { user: publicUser(created) } }, 201);
  }

  if ((m = path.match(/^\/api\/users\/(\d+)$/)) && (method === 'PATCH' || method === 'PUT')) {
    requireAdmin(user);
    const userId = parseId(m[1]);
    const target = await db.prepare('SELECT * FROM users WHERE id = ?').bind(userId).first();
    if (!target) throw new HttpError(404, 'not_found', 'Pengguna tidak ditemukan.');
    const body = await readJsonBody(request);
    let role = target.role;
    if (body.role !== undefined) {
      role = validRole(body.role);
      if (target.role === 'super_admin' && role !== 'super_admin') {
        const admins = await db
          .prepare("SELECT COUNT(*) AS c FROM users WHERE role = 'super_admin' AND is_active = 1")
          .first();
        if (admins && admins.c <= 1) {
          throw new HttpError(400, 'validation', 'Minimal harus ada satu super admin aktif.');
        }
      }
      if (target.id === user.id && role !== 'super_admin') {
        throw new HttpError(400, 'validation', 'Tidak dapat menurunkan peran Anda sendiri.');
      }
    }
    const displayName =
      body.display_name !== undefined ? optStr(body.display_name, 'nama tampilan', 60) || target.username : target.display_name;
    const email = body.email !== undefined ? validEmail(body.email) : target.email;
    if (email && email !== target.email) {
      const emailUsed = await db.prepare('SELECT 1 AS x FROM users WHERE email = ? AND id != ?').bind(email, userId).first();
      if (emailUsed) throw new HttpError(409, 'conflict', 'Email sudah dipakai pengguna lain.');
    }
    const isActive = body.is_active !== undefined ? (body.is_active ? 1 : 0) : String(target.is_active) === '1' ? 1 : 0;
    if (String(target.is_active) === '1' && isActive === 0 && target.id === user.id) {
      throw new HttpError(400, 'validation', 'Tidak dapat menonaktifkan akun Anda sendiri.');
    }
    if (isActive === 0 && target.role === 'super_admin') {
      const admins = await db
        .prepare("SELECT COUNT(*) AS c FROM users WHERE role = 'super_admin' AND is_active = 1")
        .first();
      if (admins && admins.c <= 1) throw new HttpError(400, 'validation', 'Minimal harus ada satu super admin aktif.');
    }
    let pwHash = target.password_hash;
    if (body.password !== undefined && body.password !== '') {
      pwHash = await auth.hashPassword(validPassword(body.password));
    }
    await db
      .prepare(
        'UPDATE users SET display_name = ?, email = ?, role = ?, is_active = ?, password_hash = ? WHERE id = ?'
      )
      .bind(displayName, email, role, isActive, pwHash, userId)
      .run();
    if (isActive === 0) {
      await db.prepare('DELETE FROM sessions WHERE user_id = ?').bind(userId).run();
    }
    const updated = await db.prepare('SELECT * FROM users WHERE id = ?').bind(userId).first();
    return ok({ user: publicUser(updated) });
  }

  if ((m = path.match(/^\/api\/users\/(\d+)$/)) && method === 'DELETE') {
    requireAdmin(user);
    const userId = parseId(m[1]);
    if (userId === user.id) throw new HttpError(400, 'validation', 'Tidak dapat menghapus akun Anda sendiri.');
    const target = await db.prepare('SELECT * FROM users WHERE id = ?').bind(userId).first();
    if (!target) throw new HttpError(404, 'not_found', 'Pengguna tidak ditemukan.');
    if (target.role === 'super_admin') {
      const admins = await db
        .prepare("SELECT COUNT(*) AS c FROM users WHERE role = 'super_admin' AND is_active = 1")
        .first();
      if (admins && admins.c <= 1) throw new HttpError(400, 'validation', 'Minimal harus ada satu super admin.');
    }
    await db.batch([
      db.prepare('DELETE FROM sessions WHERE user_id = ?').bind(userId),
      db.prepare('DELETE FROM project_members WHERE user_id = ?').bind(userId),
      db.prepare('DELETE FROM scripts WHERE project_id IN (SELECT id FROM projects WHERE owner_id = ?)').bind(userId),
      db.prepare('DELETE FROM project_members WHERE project_id IN (SELECT id FROM projects WHERE owner_id = ?)').bind(userId),
      db.prepare('DELETE FROM projects WHERE owner_id = ?').bind(userId),
      db.prepare('DELETE FROM users WHERE id = ?').bind(userId),
    ]);
    return ok({ deleted: true });
  }

  // ----- Statistik (super admin) -----

  if (path === '/api/stats' && method === 'GET') {
    requireAdmin(user);
    const [u, p, s, sess] = await db.batch([
      db.prepare('SELECT COUNT(*) AS c FROM users'),
      db.prepare('SELECT COUNT(*) AS c FROM projects'),
      db.prepare('SELECT COUNT(*) AS c FROM scripts'),
      db.prepare('SELECT COUNT(*) AS c FROM sessions WHERE expires_at > ?').bind(nowIso()),
    ]);
    return ok({
      stats: {
        users: u.results[0].c,
        projects: p.results[0].c,
        scripts: s.results[0].c,
        active_sessions: sess.results[0].c,
      },
    });
  }

  throw new HttpError(404, 'not_found', `Endpoint ${method} ${path} tidak ditemukan.`);
}

export { json, ok, fail };
