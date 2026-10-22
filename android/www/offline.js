// offline.js — backend offline Basarang untuk APK Android (Task 27)
// Port setia dari src/api.js + src/auth.js ke sisi klien:
//   - seluruh endpoint API diimplementasikan lokal (tanpa jaringan);
//   - data disimpan di localStorage (kunci basarang_db_v1) dan dicerminkan
//     ke file internal Android lewat AndroidBridge.persistKeys (durabilitas);
//   - sandi memakai PBKDF2-SHA256 15.000 iterasi, format identik dengan server
//     (pbkdf2:<iter>:<salt-hex>:<hash-hex>) sehingga data bisa dipindahkan;
//   - hasil rekaman (blob:) disimpan ke folder Unduhan lewat bridge berpotong.
(function () {
  'use strict';
  if (window.__BSR_OFFLINE_INSTALLED__) return;
  window.__BSR_OFFLINE_INSTALLED__ = true;

  var DB_KEY = 'basarang_db_v1';
  var TOKEN_KEY = 'basarang_session_token';
  var PROMPTER_KEY = 'basarang.prompter';
  var SESSION_TTL_SEC = 30 * 24 * 3600;
  var LOGIN_WINDOW_SEC = 15 * 60;
  var LOGIN_MAX_ATTEMPTS = 10;
  var PBKDF2_ITERATIONS = 15000;
  var MAX_SCRIPT_CHARS = 100000;
  var ROLES = ['super_admin', 'manager', 'member'];

  // ---------- Seed dari file internal (pemulih bila profil WebView dibersihkan) ----------
  try {
    var seed = window.__BSR_SEED_LS;
    if (seed && typeof seed === 'object') {
      for (var sk in seed) {
        if (Object.prototype.hasOwnProperty.call(seed, sk) && localStorage.getItem(sk) === null) {
          try { localStorage.setItem(sk, String(seed[sk])); } catch (e) {}
        }
      }
    }
  } catch (e) {}

  // ---------- Util ----------
  function nowIso() { return new Date().toISOString(); }
  function countWords(text) {
    var m = String(text || '').trim().match(/[\p{L}\p{N}'’-]+/gu);
    return m ? m.length : 0;
  }
  function clone(o) { return JSON.parse(JSON.stringify(o)); }

  // ---------- Basis data ----------
  function emptyDb() {
    return { seq: { user: 0, project: 0, script: 0 }, users: [], sessions: [], projects: [], members: [], scripts: [], attempts: {}, meta: {} };
  }
  function loadDb() {
    try {
      var raw = localStorage.getItem(DB_KEY);
      if (!raw) return emptyDb();
      var d = JSON.parse(raw);
      if (!d || typeof d !== 'object') return emptyDb();
      var e = emptyDb();
      for (var k in e) if (d[k] === undefined) d[k] = e[k];
      return d;
    } catch (err) { return emptyDb(); }
  }
  var db = loadDb();

  var persistTimer = null;
  function saveDb() {
    try { localStorage.setItem(DB_KEY, JSON.stringify(db)); } catch (e) {}
    schedulePersist();
  }
  function schedulePersist() {
    if (persistTimer) return;
    persistTimer = setTimeout(flushPersist, 800);
  }
  function flushPersist() {
    persistTimer = null;
    if (!window.AndroidBridge || !window.AndroidBridge.persistKeys) return;
    try {
      var snap = {};
      var keys = [DB_KEY, TOKEN_KEY, PROMPTER_KEY];
      for (var i = 0; i < keys.length; i++) {
        var v = localStorage.getItem(keys[i]);
        if (v !== null) snap[keys[i]] = v;
      }
      window.AndroidBridge.persistKeys(JSON.stringify(snap));
    } catch (e) {}
  }
  window.addEventListener('pagehide', flushPersist);

  // ---------- Kripto (format identik auth.js) ----------
  var enc = new TextEncoder();
  function toHex(bytes) {
    var s = '';
    for (var i = 0; i < bytes.length; i++) s += bytes[i].toString(16).padStart(2, '0');
    return s;
  }
  function fromHex(hex) {
    var out = new Uint8Array(hex.length / 2);
    for (var i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
    return out;
  }
  async function derive(password, salt, iterations) {
    var baseKey = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
    var bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: salt, iterations: iterations }, baseKey, 256);
    return new Uint8Array(bits);
  }
  async function hashPassword(password) {
    var salt = crypto.getRandomValues(new Uint8Array(16));
    var hash = await derive(password, salt, PBKDF2_ITERATIONS);
    return 'pbkdf2:' + PBKDF2_ITERATIONS + ':' + toHex(salt) + ':' + toHex(hash);
  }
  async function verifyPassword(password, stored) {
    try {
      var parts = String(stored || '').split(':');
      if (parts.length !== 4 || parts[0] !== 'pbkdf2') return false;
      var iterations = parseInt(parts[1], 10);
      if (!Number.isFinite(iterations) || iterations <= 0) return false;
      var salt = fromHex(parts[2]);
      var expected = fromHex(parts[3]);
      var actual = await derive(password, salt, iterations);
      if (actual.length !== expected.length) return false;
      var diff = 0;
      for (var i = 0; i < actual.length; i++) diff |= actual[i] ^ expected[i];
      return diff === 0;
    } catch (e) { return false; }
  }
  function generateToken() { return toHex(crypto.getRandomValues(new Uint8Array(32))); }

  // ---------- Sesi ----------
  function setSessionToken(token) {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
    schedulePersist();
  }
  function currentSessionUser() {
    var token = localStorage.getItem(TOKEN_KEY);
    if (!token || !/^[0-9a-f]{64}$/.test(token)) return null;
    var sess = null;
    for (var i = 0; i < db.sessions.length; i++) {
      if (db.sessions[i].token === token) { sess = db.sessions[i]; break; }
    }
    if (!sess) return null;
    if (new Date(sess.expires_at).getTime() <= Date.now()) {
      db.sessions = db.sessions.filter(function (s) { return s.token !== token; });
      saveDb();
      return null;
    }
    var user = null;
    for (var j = 0; j < db.users.length; j++) {
      if (db.users[j].id === sess.user_id) { user = db.users[j]; break; }
    }
    if (!user || !user.is_active) return null;
    return user;
  }
  function createSession(userId) {
    var token = generateToken();
    var now = new Date();
    var expires = new Date(now.getTime() + SESSION_TTL_SEC * 1000);
    db.sessions.push({ token: token, user_id: userId, created_at: now.toISOString(), expires_at: expires.toISOString(), user_agent: 'offline-apk' });
    return token;
  }

  // ---------- Rate limit login ----------
  function checkLoginRateLimit(username) {
    var row = db.attempts[username];
    if (!row) return { allowed: true };
    var ageMs = Date.now() - new Date(row.window_start).getTime();
    if (ageMs >= LOGIN_WINDOW_SEC * 1000) return { allowed: true };
    if (row.count >= LOGIN_MAX_ATTEMPTS) {
      var waitMin = Math.max(1, Math.ceil((LOGIN_WINDOW_SEC * 1000 - ageMs) / 60000));
      return { allowed: false, waitMin: waitMin };
    }
    return { allowed: true };
  }
  function recordLoginFailure(username) {
    var now = nowIso();
    var row = db.attempts[username];
    if (!row || Date.now() - new Date(row.window_start).getTime() >= LOGIN_WINDOW_SEC * 1000) {
      db.attempts[username] = { count: 1, window_start: now };
    } else {
      row.count += 1;
    }
  }
  function clearLoginAttempts(username) { delete db.attempts[username]; }
  function cleanupSessions() {
    var now = new Date().toISOString();
    db.sessions = db.sessions.filter(function (s) { return s.expires_at > now; });
  }

  // ---------- Validasi (port reqStr/optStr/...) ----------
  function HttpError(status, code, message) {
    var e = new Error(message);
    e.status = status; e.code = code;
    return e;
  }
  function reqStr(v, name, min, max) {
    if (typeof v !== 'string') throw HttpError(400, 'validation', 'Field ' + name + ' wajib berupa teks.');
    var s = v.trim();
    if (s.length < min) throw HttpError(400, 'validation', 'Field ' + name + ' minimal ' + min + ' karakter.');
    if (s.length > max) throw HttpError(400, 'validation', 'Field ' + name + ' maksimal ' + max + ' karakter.');
    return s;
  }
  function optStr(v, name, max) {
    if (v === undefined || v === null || v === '') return '';
    return reqStr(v, name, 1, max);
  }
  function validUsername(v) {
    var s = String(v || '').trim().toLowerCase();
    if (!/^[a-z0-9._-]{3,30}$/.test(s)) {
      throw HttpError(400, 'validation', 'Username 3-30 karakter, hanya huruf kecil, angka, titik, garis bawah, strip.');
    }
    return s;
  }
  function validPassword(v) {
    if (typeof v !== 'string' || v.length < 8 || v.length > 128) {
      throw HttpError(400, 'validation', 'Kata sandi 8-128 karakter.');
    }
    return v;
  }
  function validRole(v) {
    if (ROLES.indexOf(v) < 0) throw HttpError(400, 'validation', 'Peran tidak valid.');
    return v;
  }
  function validWpm(v) {
    var n = Number(v);
    if (!Number.isInteger(n) || n < 60 || n > 250) {
      throw HttpError(400, 'validation', 'Kecepatan baca (KPM) harus bilangan bulat 60-250.');
    }
    return n;
  }
  function validEmail(v) {
    var s = String(v || '').trim();
    if (!s) return null;
    if (s.length > 120 || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(s)) {
      throw HttpError(400, 'validation', 'Format email tidak valid.');
    }
    return s.toLowerCase();
  }
  function parseId(v) {
    var n = Number(v);
    if (!Number.isInteger(n) || n <= 0 || n > Number.MAX_SAFE_INTEGER) {
      throw HttpError(400, 'validation', 'ID tidak valid.');
    }
    return n;
  }
  function requireUser(user) {
    if (!user) throw HttpError(401, 'auth', 'Silakan masuk terlebih dahulu.');
    return user;
  }
  function requireAdmin(user) {
    requireUser(user);
    if (user.role !== 'super_admin') throw HttpError(403, 'forbidden', 'Akses khusus super admin.');
    return user;
  }

  // ---------- Query ----------
  function findUser(id) {
    for (var i = 0; i < db.users.length; i++) if (db.users[i].id === id) return db.users[i];
    return null;
  }
  function userByUsername(username) {
    for (var i = 0; i < db.users.length; i++) if (db.users[i].username === username) return db.users[i];
    return null;
  }
  function findProject(id) {
    for (var i = 0; i < db.projects.length; i++) if (db.projects[i].id === id) return db.projects[i];
    return null;
  }
  function isMember(projectId, userId) {
    for (var i = 0; i < db.members.length; i++) {
      var m = db.members[i];
      if (m.project_id === projectId && m.user_id === userId) return true;
    }
    return false;
  }
  function getProjectAccess(projectId, user) {
    var project = findProject(projectId);
    if (!project) return null;
    if (user.role === 'super_admin') {
      if (project.owner_id === user.id) return { project: project, role: 'owner' };
      return { project: project, role: isMember(projectId, user.id) ? 'member' : 'viewer' };
    }
    if (project.owner_id === user.id) return { project: project, role: 'owner' };
    return isMember(projectId, user.id) ? { project: project, role: 'member' } : null;
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
      is_active: u.is_active === true,
      created_at: u.created_at,
      last_login_at: u.last_login_at
    };
  }
  function scriptMeta(s) {
    return {
      id: s.id,
      title: s.title,
      words_per_minute: s.words_per_minute,
      word_count: s.word_count,
      created_by: s.created_by,
      created_at: s.created_at,
      updated_at: s.updated_at
    };
  }
  function projectListRow(p, myRole) {
    var owner = findUser(p.owner_id) || { username: '?', display_name: '?' };
    var scriptCount = 0, memberCount = 0;
    for (var i = 0; i < db.scripts.length; i++) if (db.scripts[i].project_id === p.id) scriptCount++;
    for (var j = 0; j < db.members.length; j++) if (db.members[j].project_id === p.id) memberCount++;
    return {
      id: p.id, name: p.name, description: p.description, status: p.status,
      owner_id: p.owner_id, created_at: p.created_at, updated_at: p.updated_at,
      owner_username: owner.username, owner_name: owner.display_name,
      script_count: scriptCount, member_count: memberCount, my_role: myRole
    };
  }

  // ---------- Respons ----------
  function okBody(data) { return { ok: true, data: data }; }
  function failBody(status, code, message) { return { ok: false, error: code, message: message }; }
  function jsonResponse(body, status) {
    return new Response(JSON.stringify(body), {
      status: status || 200,
      headers: { 'content-type': 'application/json; charset=utf-8' }
    });
  }

  // ---------- Router ----------
  async function handleApi(url, init) {
    var method = (init && init.method ? String(init.method) : 'GET').toUpperCase();
    var path = url.split('?')[0].replace(/\/+$/, '') || '/';
    var query = url.indexOf('?') >= 0 ? new URLSearchParams(url.slice(url.indexOf('?') + 1)) : new URLSearchParams('');
    var body = null;
    var rawBody = init && init.body;
    if (rawBody !== undefined && rawBody !== null && method !== 'GET' && method !== 'HEAD') {
      if (typeof rawBody === 'string') {
        try { body = JSON.parse(rawBody); } catch (e) { body = null; }
      } else { body = rawBody; }
      if (body === null || typeof body !== 'object' || Array.isArray(body)) {
        return jsonResponse(failBody(400, 'validation', 'Body harus objek JSON.'), 400);
      }
    }
    var m;
    try {
      var user = currentSessionUser();

      if (path === '/api/health') {
        return jsonResponse(okBody({ name: 'Basarang: Bagarak Saurang (offline)', status: 'ok', time: nowIso() }));
      }

      // ----- Autentikasi -----
      if (path === '/api/auth/me' && method === 'GET') {
        if (user) return jsonResponse(okBody({ user: user, needsSetup: false }));
        return jsonResponse(okBody({ user: null, needsSetup: db.users.length === 0 }));
      }

      if (path === '/api/auth/setup' && method === 'POST') {
        if (db.users.length > 0) throw HttpError(403, 'forbidden', 'Inisialisasi sudah selesai. Silakan masuk.');
        var username = validUsername(body.username);
        var password = validPassword(body.password);
        var displayName = optStr(body.display_name, 'nama tampilan', 60) || username;
        var email = validEmail(body.email);
        var pwHash = await hashPassword(password);
        var now = nowIso();
        db.seq.user += 1;
        var userId = db.seq.user;
        db.meta.setup_done = now;
        db.users.push({ id: userId, username: username, email: email, display_name: displayName, password_hash: pwHash, role: 'super_admin', is_active: true, created_at: now, last_login_at: now });
        var token1 = createSession(userId);
        saveDb();
        setSessionToken(token1);
        return jsonResponse(okBody({ user: { id: userId, username: username, email: email, display_name: displayName, role: 'super_admin' } }), 201);
      }

      if (path === '/api/auth/login' && method === 'POST') {
        var lusername = validUsername(body.username);
        var lpassword = typeof body.password === 'string' ? body.password : '';
        var row = userByUsername(lusername);
        var pwOk = row ? await verifyPassword(lpassword, row.password_hash) : false;
        if (!row || !pwOk || row.is_active !== true) {
          recordLoginFailure(lusername);
          var rl = checkLoginRateLimit(lusername);
          if (!rl.allowed) {
            return jsonResponse(failBody(429, 'rate_limited', 'Terlalu banyak percobaan gagal. Coba lagi dalam ~' + rl.waitMin + ' menit.'), 429);
          }
          throw HttpError(401, 'auth', 'Username atau kata sandi salah.');
        }
        clearLoginAttempts(lusername);
        cleanupSessions();
        row.last_login_at = nowIso();
        var token2 = createSession(row.id);
        saveDb();
        setSessionToken(token2);
        return jsonResponse(okBody({ user: publicUser(row) }));
      }

      if (path === '/api/auth/password' && method === 'POST') {
        requireUser(user);
        var current = typeof body.current === 'string' ? body.current : '';
        var next = validPassword(body.next);
        var pwOk2 = await verifyPassword(current, user.password_hash);
        if (!pwOk2) throw HttpError(401, 'auth', 'Kata sandi saat ini salah.');
        user.password_hash = await hashPassword(next);
        // Musnahkan sesi lain, pertahankan sesi aktif
        var activeToken = localStorage.getItem(TOKEN_KEY);
        db.sessions = db.sessions.filter(function (s) { return s.user_id !== user.id || s.token === activeToken; });
        saveDb();
        return jsonResponse(okBody({ changed: true }));
      }

      if (path === '/api/auth/logout' && method === 'POST') {
        var t = localStorage.getItem(TOKEN_KEY);
        if (t) {
          db.sessions = db.sessions.filter(function (s) { return s.token !== t; });
          saveDb();
        }
        setSessionToken(null);
        return jsonResponse(okBody({ loggedOut: true }));
      }

      // ----- Proyek -----
      if (path === '/api/projects' && method === 'GET') {
        requireUser(user);
        var rows = [];
        var seen = {};
        for (var pi = 0; pi < db.projects.length; pi++) {
          var p = db.projects[pi];
          var myRole = null;
          if (user.role === 'super_admin') myRole = p.owner_id === user.id ? 'owner' : (isMember(p.id, user.id) ? 'member' : 'viewer');
          else if (p.owner_id === user.id) myRole = 'owner';
          else if (isMember(p.id, user.id)) myRole = 'member';
          if (myRole) { rows.push(projectListRow(p, myRole)); seen[p.id] = true; }
        }
        rows.sort(function (a, b) { return a.created_at < b.created_at ? 1 : -1; });
        return jsonResponse(okBody({ projects: rows }));
      }

      if (path === '/api/projects' && method === 'POST') {
        requireUser(user);
        var pname = reqStr(body.name, 'nama proyek', 2, 120);
        var pdescription = optStr(body.description, 'deskripsi', 600);
        var cutoffP = new Date(Date.now() - 15000).toISOString();
        for (var rp = db.projects.length - 1; rp >= 0; rp--) {
          var pr = db.projects[rp];
          if (pr.owner_id === user.id && pr.name === pname && pr.created_at > cutoffP) {
            return jsonResponse(okBody({ project: clone(pr) }), 201);
          }
        }
        var pnow = nowIso();
        db.seq.project += 1;
        var project = { id: db.seq.project, name: pname, description: pdescription, owner_id: user.id, status: 'active', created_at: pnow, updated_at: pnow };
        db.projects.push(project);
        saveDb();
        return jsonResponse(okBody({ project: clone(project) }), 201);
      }

      if ((m = path.match(/^\/api\/projects\/(\d+)$/))) {
        var projectId = parseId(m[1]);
        if (method === 'GET') {
          requireUser(user);
          var acc = getProjectAccess(projectId, user);
          if (!acc) throw HttpError(404, 'not_found', 'Proyek tidak ditemukan atau Anda tidak punya akses.');
          var scripts = db.scripts.filter(function (s) { return s.project_id === projectId; })
            .sort(function (a, b) { return a.updated_at < b.updated_at ? 1 : -1; })
            .map(scriptMeta);
          var members = db.members.filter(function (mm) { return mm.project_id === projectId; })
            .sort(function (a, b) { return a.added_at < b.added_at ? -1 : 1; })
            .map(function (mm) {
              var mu = findUser(mm.user_id) || { username: '?', display_name: '?' };
              return { user_id: mm.user_id, member_role: mm.role, added_at: mm.added_at, username: mu.username, display_name: mu.display_name };
            });
          var ownerU = findUser(acc.project.owner_id) || { username: '?', display_name: '?' };
          return jsonResponse(okBody({
            project: clone(acc.project),
            scripts: scripts,
            members: members,
            owner: { username: ownerU.username, display_name: ownerU.display_name },
            my_role: acc.role,
            can_manage: canManageProject(acc.role, user)
          }));
        }
        if (method === 'PATCH' || method === 'DELETE') {
          requireUser(user);
          var acc2 = getProjectAccess(projectId, user);
          if (!acc2) throw HttpError(404, 'not_found', 'Proyek tidak ditemukan atau Anda tidak punya akses.');
          if (!canManageProject(acc2.role, user)) {
            throw HttpError(403, 'forbidden', 'Hanya pemilik proyek atau super admin yang dapat mengubah/menghapus proyek.');
          }
          if (method === 'DELETE') {
            db.scripts = db.scripts.filter(function (s) { return s.project_id !== projectId; });
            db.members = db.members.filter(function (mm) { return mm.project_id !== projectId; });
            db.projects = db.projects.filter(function (pp) { return pp.id !== projectId; });
            saveDb();
            return jsonResponse(okBody({ deleted: true }));
          }
          var uname = body.name !== undefined ? reqStr(body.name, 'nama proyek', 2, 120) : acc2.project.name;
          var udesc = body.description !== undefined ? optStr(body.description, 'deskripsi', 600) : acc2.project.description;
          var ustatus = acc2.project.status;
          if (body.status !== undefined) {
            if (['active', 'archived'].indexOf(body.status) < 0) throw HttpError(400, 'validation', 'Status hanya active/archived.');
            ustatus = body.status;
          }
          acc2.project.name = uname;
          acc2.project.description = udesc;
          acc2.project.status = ustatus;
          acc2.project.updated_at = nowIso();
          saveDb();
          return jsonResponse(okBody({ project: clone(acc2.project) }));
        }
      }

      // ----- Anggota proyek -----
      if ((m = path.match(/^\/api\/projects\/(\d+)\/members$/)) && method === 'POST') {
        requireUser(user);
        var pidM = parseId(m[1]);
        var accM = getProjectAccess(pidM, user);
        if (!accM) throw HttpError(404, 'not_found', 'Proyek tidak ditemukan.');
        if (!canManageProject(accM.role, user)) throw HttpError(403, 'forbidden', 'Hanya pemilik proyek atau super admin yang dapat menambah anggota.');
        var musername = validUsername(body.username);
        var target = userByUsername(musername);
        if (!target) throw HttpError(404, 'not_found', 'Pengguna "' + musername + '" tidak ditemukan.');
        if (target.id === accM.project.owner_id) throw HttpError(409, 'conflict', 'Pemilik proyek tidak perlu ditambahkan sebagai anggota.');
        if (isMember(pidM, target.id)) throw HttpError(409, 'conflict', musername + ' sudah menjadi anggota.');
        var memberCount2 = 0;
        for (var mi = 0; mi < db.members.length; mi++) if (db.members[mi].project_id === pidM) memberCount2++;
        if (memberCount2 >= 50) throw HttpError(400, 'validation', 'Maksimal 50 anggota per proyek.');
        db.members.push({ project_id: pidM, user_id: target.id, role: 'member', added_at: nowIso() });
        saveDb();
        return jsonResponse(okBody({ user_id: target.id, username: target.username, display_name: target.display_name, member_role: 'member', added_at: nowIso() }), 201);
      }

      if ((m = path.match(/^\/api\/projects\/(\d+)\/members\/(\d+)$/)) && method === 'DELETE') {
        requireUser(user);
        var pidD = parseId(m[1]);
        var uidD = parseId(m[2]);
        var accD = getProjectAccess(pidD, user);
        if (!accD) throw HttpError(404, 'not_found', 'Proyek tidak ditemukan.');
        var selfLeave = uidD === user.id && accD.role === 'member';
        if (!canManageProject(accD.role, user) && !selfLeave) {
          throw HttpError(403, 'forbidden', 'Tidak diizinkan menghapus anggota ini.');
        }
        db.members = db.members.filter(function (mm) { return !(mm.project_id === pidD && mm.user_id === uidD); });
        saveDb();
        return jsonResponse(okBody({ removed: true }));
      }

      // ----- Naskah -----
      if ((m = path.match(/^\/api\/projects\/(\d+)\/scripts$/)) && method === 'POST') {
        requireUser(user);
        var pidS = parseId(m[1]);
        var accS = getProjectAccess(pidS, user);
        if (!accS) throw HttpError(404, 'not_found', 'Proyek tidak ditemukan atau Anda tidak punya akses.');
        var stitle = reqStr(body.title, 'judul naskah', 2, 120);
        var scontent = optStr(body.content, 'isi naskah', MAX_SCRIPT_CHARS);
        var swpm = body.words_per_minute !== undefined ? validWpm(body.words_per_minute) : 140;
        var swcount = countWords(scontent);
        var cutoffS = new Date(Date.now() - 15000).toISOString();
        for (var rs = db.scripts.length - 1; rs >= 0; rs--) {
          var sr = db.scripts[rs];
          if (sr.project_id === pidS && sr.title === stitle && sr.created_by === user.id && sr.created_at > cutoffS) {
            return jsonResponse(okBody({ script: scriptMeta(sr) }), 201);
          }
        }
        var snow = nowIso();
        db.seq.script += 1;
        var script = { id: db.seq.script, project_id: pidS, title: stitle, content: scontent, words_per_minute: swpm, word_count: swcount, created_by: user.id, created_at: snow, updated_at: snow };
        db.scripts.push(script);
        saveDb();
        return jsonResponse(okBody({ script: scriptMeta(script) }), 201);
      }

      if ((m = path.match(/^\/api\/scripts\/(\d+)$/))) {
        var scriptId = parseId(m[1]);
        var scriptRow = null;
        for (var si = 0; si < db.scripts.length; si++) if (db.scripts[si].id === scriptId) { scriptRow = db.scripts[si]; break; }
        if (method === 'GET') {
          requireUser(user);
          if (!scriptRow) throw HttpError(404, 'not_found', 'Naskah tidak ditemukan.');
          var accG = getProjectAccess(scriptRow.project_id, user);
          if (!accG) throw HttpError(403, 'forbidden', 'Anda tidak punya akses ke naskah ini.');
          return jsonResponse(okBody({ script: clone(scriptRow), project: clone(accG.project), my_role: accG.role, can_manage: canManageProject(accG.role, user) }));
        }
        if (method === 'PUT' || method === 'PATCH' || method === 'DELETE') {
          requireUser(user);
          if (!scriptRow) throw HttpError(404, 'not_found', 'Naskah tidak ditemukan.');
          var accU = getProjectAccess(scriptRow.project_id, user);
          if (!accU) throw HttpError(403, 'forbidden', 'Anda tidak punya akses ke naskah ini.');
          var isOwnerOrAdmin = canManageProject(accU.role, user);
          var isOwnScript = accU.role === 'member' && scriptRow.created_by === user.id;
          if (!isOwnerOrAdmin && !isOwnScript) {
            throw HttpError(403, 'forbidden', 'Anggota hanya dapat mengubah naskah yang dibuatnya sendiri.');
          }
          if (method === 'DELETE') {
            if (!isOwnerOrAdmin) throw HttpError(403, 'forbidden', 'Hanya pemilik proyek atau super admin yang dapat menghapus naskah.');
            db.scripts = db.scripts.filter(function (s) { return s.id !== scriptId; });
            saveDb();
            return jsonResponse(okBody({ deleted: true }));
          }
          var ntitle = body.title !== undefined ? reqStr(body.title, 'judul naskah', 2, 120) : scriptRow.title;
          var ncontent = body.content !== undefined ? optStr(body.content, 'isi naskah', MAX_SCRIPT_CHARS) : scriptRow.content;
          var nwpm = body.words_per_minute !== undefined ? validWpm(body.words_per_minute) : scriptRow.words_per_minute;
          var nwcount = body.content !== undefined ? countWords(ncontent) : (scriptRow.word_count != null ? scriptRow.word_count : countWords(scriptRow.content));
          scriptRow.title = ntitle;
          scriptRow.content = ncontent;
          scriptRow.words_per_minute = nwpm;
          scriptRow.word_count = nwcount;
          scriptRow.updated_at = nowIso();
          saveDb();
          return jsonResponse(okBody({ script: scriptMeta(scriptRow) }));
        }
      }

      // ----- Pencarian pengguna -----
      if (path === '/api/users/search' && method === 'GET') {
        requireUser(user);
        var q = String(query.get('q') || '').trim().toLowerCase();
        if (q.length < 2) return jsonResponse(okBody({ users: [] }));
        var found = [];
        for (var ui = 0; ui < db.users.length && found.length < 8; ui++) {
          var uu = db.users[ui];
          if (uu.is_active !== true) continue;
          if ((uu.username + ' ' + (uu.display_name || '')).toLowerCase().indexOf(q) >= 0) {
            found.push({ id: uu.id, username: uu.username, display_name: uu.display_name });
          }
        }
        return jsonResponse(okBody({ users: found }));
      }

      // ----- Manajemen pengguna (super admin) -----
      if (path === '/api/users' && method === 'GET') {
        requireAdmin(user);
        var urows = [];
        for (var u1 = 0; u1 < db.users.length; u1++) {
          var ur = db.users[u1];
          var owned = 0, memberships = 0;
          for (var o1 = 0; o1 < db.projects.length; o1++) if (db.projects[o1].owner_id === ur.id) owned++;
          for (var o2 = 0; o2 < db.members.length; o2++) if (db.members[o2].user_id === ur.id) memberships++;
          urows.push({
            id: ur.id, username: ur.username, email: ur.email, display_name: ur.display_name,
            role: ur.role, is_active: ur.is_active === true, created_at: ur.created_at, last_login_at: ur.last_login_at,
            projects_owned: owned, memberships: memberships
          });
        }
        urows.sort(function (a, b) { return a.created_at < b.created_at ? -1 : 1; });
        return jsonResponse(okBody({ users: urows }));
      }

      if (path === '/api/users' && method === 'POST') {
        requireAdmin(user);
        var nusername = validUsername(body.username);
        var npassword = validPassword(body.password);
        var ndisplay = optStr(body.display_name, 'nama tampilan', 60) || nusername;
        var nemail = validEmail(body.email);
        var nrole = validRole(body.role);
        if (userByUsername(nusername)) throw HttpError(409, 'conflict', 'Username "' + nusername + '" sudah dipakai.');
        if (nemail) {
          for (var e1 = 0; e1 < db.users.length; e1++) {
            if (db.users[e1].email && db.users[e1].email === nemail) throw HttpError(409, 'conflict', 'Email sudah dipakai pengguna lain.');
          }
        }
        var nhash = await hashPassword(npassword);
        db.seq.user += 1;
        var nuser = { id: db.seq.user, username: nusername, email: nemail, display_name: ndisplay, password_hash: nhash, role: nrole, is_active: true, created_at: nowIso(), last_login_at: null };
        db.users.push(nuser);
        saveDb();
        return jsonResponse(okBody({ user: publicUser(nuser) }), 201);
      }

      if ((m = path.match(/^\/api\/users\/(\d+)$/)) && (method === 'PATCH' || method === 'PUT')) {
        requireAdmin(user);
        var userId2 = parseId(m[1]);
        var target2 = findUser(userId2);
        if (!target2) throw HttpError(404, 'not_found', 'Pengguna tidak ditemukan.');
        var trole = target2.role;
        if (body.role !== undefined) {
          trole = validRole(body.role);
          if (target2.role === 'super_admin' && trole !== 'super_admin') {
            var admins1 = 0;
            for (var a1 = 0; a1 < db.users.length; a1++) if (db.users[a1].role === 'super_admin' && db.users[a1].is_active === true) admins1++;
            if (admins1 <= 1) throw HttpError(400, 'validation', 'Minimal harus ada satu super admin aktif.');
          }
          if (target2.id === user.id && trole !== 'super_admin') {
            throw HttpError(400, 'validation', 'Tidak dapat menurunkan peran Anda sendiri.');
          }
        }
        var tdisplay = body.display_name !== undefined ? (optStr(body.display_name, 'nama tampilan', 60) || target2.username) : target2.display_name;
        var temail = body.email !== undefined ? validEmail(body.email) : target2.email;
        if (temail && temail !== target2.email) {
          for (var e2 = 0; e2 < db.users.length; e2++) {
            if (db.users[e2].email && db.users[e2].email === temail && db.users[e2].id !== userId2) throw HttpError(409, 'conflict', 'Email sudah dipakai pengguna lain.');
          }
        }
        var tactive = body.is_active !== undefined ? (body.is_active ? true : false) : target2.is_active;
        if (target2.is_active === true && tactive === false && target2.id === user.id) {
          throw HttpError(400, 'validation', 'Tidak dapat menonaktifkan akun Anda sendiri.');
        }
        if (tactive === false && target2.role === 'super_admin') {
          var admins2 = 0;
          for (var a2 = 0; a2 < db.users.length; a2++) if (db.users[a2].role === 'super_admin' && db.users[a2].is_active === true) admins2++;
          if (admins2 <= 1) throw HttpError(400, 'validation', 'Minimal harus ada satu super admin aktif.');
        }
        if (body.password !== undefined && body.password !== '') {
          target2.password_hash = await hashPassword(validPassword(body.password));
        }
        target2.display_name = tdisplay;
        target2.email = temail;
        target2.role = trole;
        target2.is_active = tactive;
        if (tactive === false) {
          db.sessions = db.sessions.filter(function (s) { return s.user_id !== userId2; });
        }
        saveDb();
        return jsonResponse(okBody({ user: publicUser(target2) }));
      }

      if ((m = path.match(/^\/api\/users\/(\d+)$/)) && method === 'DELETE') {
        requireAdmin(user);
        var userId3 = parseId(m[1]);
        if (userId3 === user.id) throw HttpError(400, 'validation', 'Tidak dapat menghapus akun Anda sendiri.');
        var target3 = findUser(userId3);
        if (!target3) throw HttpError(404, 'not_found', 'Pengguna tidak ditemukan.');
        if (target3.role === 'super_admin') {
          var admins3 = 0;
          for (var a3 = 0; a3 < db.users.length; a3++) if (db.users[a3].role === 'super_admin' && db.users[a3].is_active === true) admins3++;
          if (admins3 <= 1) throw HttpError(400, 'validation', 'Minimal harus ada satu super admin.');
        }
        var ownedProjects = [];
        for (var o3 = 0; o3 < db.projects.length; o3++) if (db.projects[o3].owner_id === userId3) ownedProjects.push(db.projects[o3].id);
        db.sessions = db.sessions.filter(function (s) { return s.user_id !== userId3; });
        db.members = db.members.filter(function (mm) { return mm.user_id !== userId3; });
        db.scripts = db.scripts.filter(function (s) { return ownedProjects.indexOf(s.project_id) < 0; });
        db.members = db.members.filter(function (mm) { return ownedProjects.indexOf(mm.project_id) < 0; });
        db.projects = db.projects.filter(function (pp) { return pp.owner_id !== userId3; });
        db.users = db.users.filter(function (uu2) { return uu2.id !== userId3; });
        saveDb();
        return jsonResponse(okBody({ deleted: true }));
      }

      // ----- Statistik -----
      if (path === '/api/stats' && method === 'GET') {
        requireAdmin(user);
        var nowS = nowIso();
        var activeSessions = 0;
        for (var s2 = 0; s2 < db.sessions.length; s2++) if (db.sessions[s2].expires_at > nowS) activeSessions++;
        return jsonResponse(okBody({
          stats: {
            users: db.users.length,
            projects: db.projects.length,
            scripts: db.scripts.length,
            active_sessions: activeSessions
          }
        }));
      }

      throw HttpError(404, 'not_found', 'Endpoint ' + method + ' ' + path + ' tidak ditemukan.');
    } catch (err) {
      var status = err && err.status ? err.status : 500;
      var code = err && err.code ? err.code : 'error';
      var message = err && err.message ? err.message : 'Kesalahan internal.';
      return jsonResponse(failBody(status, code, message), status);
    }
  }

  // ---------- Override fetch ----------
  var origFetch = typeof window.fetch === 'function' ? window.fetch.bind(window) : null;
  window.fetch = function (input, init) {
    var url = '';
    if (typeof input === 'string') url = input;
    else if (input && input.url) url = input.url;
    if (url.indexOf('/api/') === 0 || url === '/api') {
      return handleApi(url, init || {});
    }
    return origFetch ? origFetch(input, init) : Promise.reject(new Error('fetch tidak tersedia'));
  };

  // ---------- Simpan hasil rekaman ke Unduhan (blob: → bridge Android, berpotongan) ----------
  function saveBlobToAndroid(blobUrl, name) {
    var id = toHex(crypto.getRandomValues(new Uint8Array(8)));
    fetch(blobUrl).then(function (r) { return r.blob(); }).then(function (blob) {
      var fr = new FileReader();
      fr.onload = function () {
        try {
          var b64 = String(fr.result).split(',')[1] || '';
          var CH = 262144; // 256 KB per potongan — aman di bawah batas transfer Binder
          var total = Math.ceil(b64.length / CH);
          var i = 0;
          function next() {
            if (i >= total) { window.AndroidBridge.blobCommit(id, name, blob.type || 'video/webm'); return; }
            window.AndroidBridge.blobChunk(id, i, total, b64.substr(i * CH, CH));
            i++;
            setTimeout(next, 0);
          }
          next();
        } catch (e) {}
      };
      fr.onerror = function () {};
      fr.readAsDataURL(blob);
    }).catch(function () {});
  }
  document.addEventListener('click', function (e) {
    var a = e.target && e.target.closest ? e.target.closest('a[download]') : null;
    if (!a || !window.AndroidBridge || !window.AndroidBridge.blobChunk) return;
    var href = a.getAttribute('href') || '';
    if (href.indexOf('blob:') !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    var name = a.getAttribute('download') || ('basarang-' + Date.now() + '.webm');
    saveBlobToAndroid(href, name);
  }, true);

  // ---------- Layar tetap menyala saat teleprompter terbuka ----------
  function syncKeepScreenOn() {
    if (!window.AndroidBridge || !window.AndroidBridge.keepScreenOn) return;
    try { window.AndroidBridge.keepScreenOn(/#\/prompter\//.test(location.hash)); } catch (e) {}
  }
  window.addEventListener('hashchange', syncKeepScreenOn);
  syncKeepScreenOn();
})();
