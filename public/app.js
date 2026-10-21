// app.js — SPA inti Basarang: Bagarak Saurang
// Semua konten dinamis dirender dengan escaping (esc) — aman XSS.
'use strict';

(() => {
  const $app = document.getElementById('app');
  const $modalRoot = document.getElementById('modal-root');
  const $toastRoot = document.getElementById('toast-root');

  const state = { user: null, needsSetup: false, booted: false, luring: false };

  // ---------- Footer selalu terlihat ----------

  // Footer sticky (fixed, z-index 600) harus tidak menutupi konten app,
  // toast, HUD prompter, maupun panel pengaturannya — semua bergeser
  // sebesar var --footer-h. Tingginya diukur nyata (bisa wrap 2 baris di
  // layar sempit) dan dipantau ResizeObserver agar selalu akurat.
  const syncFooterHeight = () => {
    const f = document.querySelector('.site-footer');
    if (!f) return;
    const h = Math.round(f.getBoundingClientRect().height);
    if (h > 0) document.documentElement.style.setProperty('--footer-h', h + 'px');
  };
  syncFooterHeight();
  window.addEventListener('resize', syncFooterHeight);
  window.addEventListener('orientationchange', syncFooterHeight);
  const footerEl = document.querySelector('.site-footer');
  if (footerEl && 'ResizeObserver' in window) {
    new ResizeObserver(syncFooterHeight).observe(footerEl);
  }
  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(syncFooterHeight).catch(() => {});
  }

  // ---------- Util ----------

  const esc = (s) =>
    String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));

  function el(html) {
    const t = document.createElement('template');
    t.innerHTML = html.trim();
    return t.content.firstElementChild;
  }

  class ApiError extends Error {
    constructor(message, status, code) {
      super(message);
      this.status = status;
      this.code = code;
    }
  }

  async function api(path, opts = {}) {
    // Mode perangkat (APK full offline): seluruh permintaan dilayani penyimpanan
    // perangkat lewat LocalApi — tanpa fetch, tanpa jaringan; kontrak respons
    // identik dengan server sehingga semua view berjalan tanpa perubahan.
    if (LOCAL) {
      return LocalApi.call(opts.method || 'GET', path, opts.body);
    }
    const init = { method: opts.method || 'GET', headers: {} };
    if (opts.body !== undefined) {
      init.headers['content-type'] = 'application/json';
      init.body = JSON.stringify(opts.body);
    }
    let res;
    try {
      res = await fetch('/api' + path, init);
    } catch {
      // fetch melempar TypeError hanya saat jaringan putus (bukan jawaban server).
      throw new ApiError('Anda sedang luring (tanpa koneksi). Perubahan tetap disimpan di perangkat.', 0, 'offline');
    }
    let data = null;
    try {
      data = await res.json();
    } catch {
      /* kosong */
    }
    if (!res.ok || !data || data.ok === false) {
      throw new ApiError(
        (data && data.message) || 'Gagal terhubung ke server (' + res.status + ').',
        res.status,
        data && data.error
      );
    }
    return data.data;
  }

  // ---------- Mode luring (offline): draf lokal + antrean sinkron + cache ----------
  // Prinsip:
  //   (1) Tiap ketikan di editor langsung dicadangkan ke localStorage — teks tidak
  //       pernah hilang walau sinyal putus / aplikasi tertutup paksa.
  //   (2) Simpan yang gagal karena offline masuk antrean dan dikirim OTOMATIS
  //       begitu koneksi kembali (event 'online' + percobaan berkala).
  //   (3) Proyek & naskah yang pernah dibuka di-cache agar daftar, editor, dan
  //       teleprompter (mode Timer) tetap bisa dibuka tanpa jaringan.
  // Shell aplikasi (HTML/JS/CSS) di-cache oleh service worker (public/sw.js).
  const LS = {
    get(k, fb) {
      try {
        const v = localStorage.getItem(k);
        return v == null ? fb : JSON.parse(v);
      } catch {
        return fb;
      }
    },
    set(k, v) {
      try {
        localStorage.setItem(k, JSON.stringify(v));
        return true;
      } catch {
        Off.prune();
        try {
          localStorage.setItem(k, JSON.stringify(v));
          return true;
        } catch {
          return false;
        }
      }
    },
    del(k) {
      try {
        localStorage.removeItem(k);
      } catch {
        /* abaikan */
      }
    },
    keys(prefix) {
      const out = [];
      try {
        for (let i = 0; i < localStorage.length; i++) {
          const k = localStorage.key(i);
          if (k && k.indexOf(prefix) === 0) out.push(k);
        }
      } catch {
        /* abaikan */
      }
      return out;
    },
  };
  const Off = {
    queue: [],
    online: navigator.onLine !== false,
    draining: false,
    isNetErr(e) {
      return !!e && (e.status === 0 || e.code === 'offline');
    },
    // Gangguan SEMENTARA: jaringan putus ATAU server sedang tidak sanggup menulis
    // (5xx, 429, kuota D1 harian habis). Aman untuk dicoba ulang nanti — jangan
    // pernah buang antrean/draf karena ini.
    isTransientErr(e) {
      if (this.isNetErr(e)) return true;
      if (!e) return false;
      return e.status === 429 || e.status >= 500 || e.code === 'db_write_limited' || e.code === 'rate_limited';
    },
    init() {
      this.queue = LS.get('bsng.queue', []) || [];
      window.addEventListener('online', () => {
        this.online = true;
        toast('Kembali online — mengirim perubahan tersimpan di perangkat…', 'info', 3200);
        this.drain().then(() => {
          if (!window.Prompter || !window.Prompter.isActive()) render();
        });
      });
      window.addEventListener('offline', () => {
        this.online = false;
        toast('Anda luring — perubahan tetap bisa disimpan di perangkat.', 'info', 3600);
        if (!window.Prompter || !window.Prompter.isActive()) render();
      });
      // Percobaan berkala: event 'online' kadang tak terpicu (mis. beberapa WebView).
      setInterval(() => {
        this.drain();
      }, 30000);
      this.drain();
    },
    persistQueue() {
      LS.set('bsng.queue', this.queue);
    },
    enqueue(item) {
      // Satu antrean per naskah (key): simpan terbaru menimpa yang menunggu.
      this.queue = this.queue.filter((q) => q.key !== item.key);
      this.queue.push(item);
      this.persistQueue();
    },
    async drain() {
      if (this.draining || !this.online || !this.queue.length) return;
      this.draining = true;
      try {
        while (this.queue.length) {
          const item = this.queue[0];
          try {
            const data = await api(item.path, { method: item.method, body: item.body });
            this.queue.shift();
            this.persistQueue();
            if (data && data.script) this.cacheScript(data.script);
            toast('"' + (data && data.script ? data.script.title : item.body.title) + '" terkirim ke server ✓', 'ok', 3200);
          } catch (err) {
            if (this.isTransientErr(err)) break; // gangguan sementara (luring/server sibuk) — coba lagi nanti
            // Ditolak server secara permanen (4xx): tidak akan pernah lolos — buang.
            this.queue.shift();
            this.persistQueue();
            toast('Perubahan "' + item.body.title + '" ditolak server: ' + err.message, 'err', 5200);
          }
        }
      } finally {
        this.draining = false;
      }
    },
    cacheUser(u) {
      if (u) LS.set('bsng.user', u);
    },
    cachedUser() {
      return LS.get('bsng.user', null);
    },
    cacheProjects(list) {
      LS.set('bsng.projects', { projects: list, ts: Date.now() });
    },
    cachedProjects() {
      return LS.get('bsng.projects', null);
    },
    cacheProject(d) {
      LS.set('bsng.proj.' + d.project.id, Object.assign({}, d, { ts: Date.now() }));
    },
    cachedProject(id) {
      return LS.get('bsng.proj.' + id, null);
    },
    cacheScript(s) {
      if (!s || !s.id) return;
      LS.set('bsng.script.' + s.id, {
        id: s.id,
        project_id: s.project_id,
        title: s.title,
        content: s.content,
        words_per_minute: s.words_per_minute,
        updated_at: s.updated_at || '',
        ts: Date.now(),
      });
    },
    cachedScript(id) {
      return LS.get('bsng.script.' + id, null);
    },
    saveDraft(key, draft) {
      LS.set('bsng.draft.' + key, Object.assign({}, draft, { ts: Date.now() }));
    },
    loadDraft(key) {
      return LS.get('bsng.draft.' + key, null);
    },
    clearDraft(key) {
      LS.del('bsng.draft.' + key);
    },
    prune() {
      // Kuota localStorage penuh: buang cache isi naskah tertua (draf & antrean tak disentuh).
      const keys = LS.keys('bsng.script.').map((k) => ({ k, ts: (LS.get(k, {}) || {}).ts || 0 }));
      keys.sort((a, b) => a.ts - b.ts);
      for (let i = 0; i < Math.ceil(keys.length / 2); i++) LS.del(keys[i].k);
    },
    clearAll() {
      for (const k of LS.keys('bsng.')) LS.del(k);
      this.queue = [];
    },
  };

  // ---------- Mode perangkat (APK): full offline ----------
  // Di APK, seluruh aplikasi web dibundel di dalam paket dan disajikan WebView
  // dari origin https://app.basarang.local — setup akun, login, proyek, naskah,
  // editor, dan teleprompter (mode Timer) berjalan 100% TANPA internet: semua
  // data tersimpan di perangkat (IndexedDB + localStorage). Sinkronisasi ke
  // server bersifat opsional lewat tombol Sinkron (butuh koneksi). Di luar APK,
  // mode ini hanya bisa diaktifkan di localhost (?lokal=1) untuk pengujian —
  // perilaku situs web tidak berubah.
  const LOCAL =
    location.hostname === 'app.basarang.local' ||
    ((location.hostname === 'localhost' || location.hostname === '127.0.0.1') &&
      new URLSearchParams(location.search).get('lokal') === '1');

  // Penyimpanan akun & sesi lokal — sengaja TIDAK memakai prefix 'bsng.' agar
  // tidak ikut terhapus saat Off.clearAll() (logout membersihkan cache/draf,
  // bukan akun perangkat).
  const LR = {
    get(k, fb) {
      try {
        const v = localStorage.getItem('basarang.local.' + k);
        return v == null ? fb : JSON.parse(v);
      } catch {
        return fb;
      }
    },
    set(k, v) {
      try {
        localStorage.setItem('basarang.local.' + k, JSON.stringify(v));
      } catch {
        /* kuota penuh — pengguna & sesi berukuran kecil, hampir mustahil */
      }
    },
    del(k) {
      try {
        localStorage.removeItem('basarang.local.' + k);
      } catch {
        /* abaikan */
      }
    },
  };

  // IndexedDB: proyek, naskah (isi penuh — praktis tanpa batas ukuran), anggota.
  const LDB = {
    _p: null,
    _open() {
      if (!this._p) {
        this._p = new Promise((resolve, reject) => {
          const rq = indexedDB.open('basarang-local', 1);
          rq.onupgradeneeded = () => {
            const db = rq.result;
            db.createObjectStore('projects', { keyPath: 'id' });
            db.createObjectStore('scripts', { keyPath: 'id' });
            db.createObjectStore('members', { keyPath: 'key' });
          };
          rq.onsuccess = () => resolve(rq.result);
          rq.onerror = () => reject(rq.error || new Error('IndexedDB tidak tersedia'));
        });
      }
      return this._p;
    },
    async _tx(store, mode, fn) {
      const db = await this._open();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(store, mode);
        const req = fn(tx.objectStore(store));
        tx.oncomplete = () => resolve(req ? req.result : undefined);
        tx.onerror = () => reject(tx.error || new Error('Transaksi IndexedDB gagal'));
        tx.onabort = () => reject(tx.error || new Error('Transaksi dibatalkan'));
      });
    },
    all: (store) => LDB._tx(store, 'readonly', (s) => s.getAll()),
    get: (store, id) => LDB._tx(store, 'readonly', (s) => s.get(id)),
    put: (store, val) => LDB._tx(store, 'readwrite', (s) => s.put(val)),
    del: (store, id) => LDB._tx(store, 'readwrite', (s) => s.delete(id)),
  };

  // PBKDF2-SHA256 15.000 iterasi — format hash identik dengan server
  // (pbkdf2:<iter>:<salt-hex>:<hash-hex>) sehingga kekuatan sandi setara.
  async function localDerive(password, salt, iterations) {
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
    const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256);
    return new Uint8Array(bits);
  }
  function localHex(bytes) {
    return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  }
  function localUnhex(hex) {
    const out = new Uint8Array(Math.floor(hex.length / 2));
    for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
    return out;
  }
  async function localHashPassword(password) {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const hash = await localDerive(password, salt, 15000);
    return 'pbkdf2:15000:' + localHex(salt) + ':' + localHex(hash);
  }
  async function localVerifyPassword(password, stored) {
    try {
      const parts = String(stored || '').split(':');
      if (parts.length !== 4 || parts[0] !== 'pbkdf2') return false;
      const iter = parseInt(parts[1], 10);
      if (!Number.isFinite(iter) || iter <= 0) return false;
      const actual = await localDerive(password, localUnhex(parts[2]), iter);
      const expected = localUnhex(parts[3]);
      if (actual.length !== expected.length) return false;
      let diff = 0;
      for (let i = 0; i < actual.length; i++) diff |= actual[i] ^ expected[i];
      return diff === 0;
    } catch {
      return false;
    }
  }

  // Validasi — cermin persis aturan server (src/api.js) agar pesan konsisten.
  function localErr(status, code, message) {
    return new ApiError(message, status, code);
  }
  function localReqStr(v, name, min, max) {
    if (typeof v !== 'string') throw localErr(400, 'validation', 'Field ' + name + ' wajib berupa teks.');
    const s = v.trim();
    if (s.length < min) throw localErr(400, 'validation', 'Field ' + name + ' minimal ' + min + ' karakter.');
    if (s.length > max) throw localErr(400, 'validation', 'Field ' + name + ' maksimal ' + max + ' karakter.');
    return s;
  }
  function localOptStr(v, name, max) {
    if (v === undefined || v === null || v === '') return '';
    return localReqStr(v, name, 1, max);
  }
  function localValidUsername(v) {
    const s = String(v || '').trim().toLowerCase();
    if (!/^[a-z0-9._-]{3,30}$/.test(s)) {
      throw localErr(400, 'validation', 'Username 3-30 karakter, hanya huruf kecil, angka, titik, garis bawah, strip.');
    }
    return s;
  }
  function localValidPassword(v) {
    if (typeof v !== 'string' || v.length < 8 || v.length > 128) {
      throw localErr(400, 'validation', 'Kata sandi 8-128 karakter.');
    }
    return v;
  }
  function localValidRole(v) {
    if (!['super_admin', 'manager', 'member'].includes(v)) throw localErr(400, 'validation', 'Peran tidak valid.');
    return v;
  }
  function localValidWpm(v) {
    const n = Number(v);
    if (!Number.isInteger(n) || n < 60 || n > 250) {
      throw localErr(400, 'validation', 'Kecepatan baca (KPM) harus bilangan bulat 60-250.');
    }
    return n;
  }
  function localValidEmail(v) {
    const s = String(v || '').trim();
    if (!s) return null;
    if (s.length > 120 || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(s)) {
      throw localErr(400, 'validation', 'Format email tidak valid.');
    }
    return s.toLowerCase();
  }

  // LocalApi — implementasi penyimpanan perangkat dengan KONTRAK respons yang
  // sama persis dengan server (bentuk data & pesan error), sehingga seluruh UI
  // (setup, login, dashboard, proyek, editor, admin, prompter) jalan tanpa ubahan.
  const LocalApi = {
    _idSeq: 0,
    // ID numerik unik (router SPA memakai Number(id)); jauh lebih besar dari ID
    // server sehingga tidak bertabrakan dengan data hasil sinkronisasi.
    nextId() {
      this._idSeq = (this._idSeq + 1) % 1000;
      return Date.now() * 1000 + this._idSeq;
    },
    now() {
      return new Date().toISOString();
    },
    users() {
      return LR.get('users', []) || [];
    },
    saveUsers(list) {
      LR.set('users', list);
    },
    currentUser() {
      const s = LR.get('session', null);
      if (!s) return null;
      return this.users().find((u) => u.id === s.user_id && u.is_active) || null;
    },
    publicUser(u) {
      return {
        id: u.id,
        username: u.username,
        email: u.email,
        display_name: u.display_name,
        role: u.role,
        is_active: !!u.is_active,
        created_at: u.created_at,
        last_login_at: u.last_login_at,
      };
    },
    requireUser() {
      const u = this.currentUser();
      if (!u) throw localErr(401, 'auth', 'Silakan masuk terlebih dahulu.');
      return u;
    },
    requireAdmin() {
      const u = this.requireUser();
      if (u.role !== 'super_admin') throw localErr(403, 'forbidden', 'Akses khusus super admin.');
      return u;
    },
    // { project, role } bila user punya akses; role: 'owner' | 'member' | 'viewer'
    async accessProject(projectId, user) {
      const p = await LDB.get('projects', projectId);
      if (!p) return null;
      if (user.role === 'super_admin') {
        if (p.owner_id === user.id) return { project: p, role: 'owner' };
        const m = await LDB.get('members', projectId + ':' + user.id);
        return { project: p, role: m ? 'member' : 'viewer' };
      }
      if (p.owner_id === user.id) return { project: p, role: 'owner' };
      const m = await LDB.get('members', projectId + ':' + user.id);
      return m ? { project: p, role: 'member' } : null;
    },
    async scriptsOf(projectId) {
      const all = await LDB.all('scripts');
      return all
        .filter((s) => s.project_id === projectId)
        .sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)));
    },
    async membersOf(projectId) {
      const all = await LDB.all('members');
      return all.filter((m) => m.project_id === projectId);
    },
    canManage(role, user) {
      return role === 'owner' || user.role === 'super_admin';
    },
    // Kolom metadata-saja (tanpa content) — kontrak daftar naskah server.
    meta(s) {
      return {
        id: s.id,
        title: s.title,
        words_per_minute: s.words_per_minute,
        word_count: s.word_count,
        created_by: s.created_by,
        created_at: s.created_at,
        updated_at: s.updated_at,
      };
    },
    async call(method, path, body) {
      method = String(method || 'GET').toUpperCase();
      let m;

      // ----- Autentikasi -----
      if (path === '/auth/me') {
        const u = this.currentUser();
        return { user: u ? this.publicUser(u) : null, needsSetup: this.users().length === 0 };
      }
      if (path === '/auth/setup' && method === 'POST') {
        if (this.users().length) throw localErr(403, 'forbidden', 'Inisialisasi sudah selesai. Silakan masuk.');
        const username = localValidUsername(body && body.username);
        const password = localValidPassword(body && body.password);
        const display_name = localOptStr(body && body.display_name, 'nama tampilan', 60) || username;
        const email = localValidEmail(body && body.email);
        const now = this.now();
        const u = {
          id: this.nextId(),
          username,
          email,
          display_name,
          password_hash: await localHashPassword(password),
          role: 'super_admin',
          is_active: true,
          created_at: now,
          last_login_at: now,
        };
        this.saveUsers([u]);
        LR.set('session', { user_id: u.id, ts: Date.now() });
        return { user: this.publicUser(u) };
      }
      if (path === '/auth/login' && method === 'POST') {
        const username = localValidUsername(body && body.username);
        const password = typeof (body && body.password) === 'string' ? body.password : '';
        const list = this.users();
        const u = list.find((x) => x.username === username);
        const ok = u ? await localVerifyPassword(password, u.password_hash) : false;
        if (!u || !ok || !u.is_active) throw localErr(401, 'auth', 'Username atau kata sandi salah.');
        u.last_login_at = this.now();
        this.saveUsers(list);
        LR.set('session', { user_id: u.id, ts: Date.now() });
        return { user: this.publicUser(u) };
      }
      if (path === '/auth/password' && method === 'POST') {
        const me = this.requireUser();
        const current = typeof (body && body.current) === 'string' ? body.current : '';
        const next = localValidPassword(body && body.next);
        if (!(await localVerifyPassword(current, me.password_hash)))
          throw localErr(401, 'auth', 'Kata sandi saat ini salah.');
        const list = this.users();
        const u = list.find((x) => x.id === me.id);
        u.password_hash = await localHashPassword(next);
        this.saveUsers(list);
        return { changed: true };
      }
      if (path === '/auth/logout' && method === 'POST') {
        LR.del('session');
        return { loggedOut: true };
      }

      // ----- Proyek -----
      if (path === '/projects' && method === 'GET') {
        const me = this.requireUser();
        const [projects, scripts, members] = [await LDB.all('projects'), await LDB.all('scripts'), await LDB.all('members')];
        const users = this.users();
        const roleOf = (p) => {
          if (p.owner_id === me.id) return 'owner';
          if (me.role === 'super_admin') return members.some((mm) => mm.project_id === p.id && mm.user_id === me.id) ? 'member' : 'viewer';
          return 'member';
        };
        return {
          projects: projects
            .filter(
              (p) =>
                me.role === 'super_admin' ||
                p.owner_id === me.id ||
                members.some((mm) => mm.project_id === p.id && mm.user_id === me.id)
            )
            .map((p) => {
              const owner = users.find((u) => u.id === p.owner_id) || {};
              return {
                id: p.id,
                name: p.name,
                description: p.description,
                status: p.status,
                owner_id: p.owner_id,
                created_at: p.created_at,
                updated_at: p.updated_at,
                owner_username: owner.username || '?',
                owner_name: owner.display_name || '?',
                script_count: scripts.filter((s) => s.project_id === p.id).length,
                member_count: members.filter((mm) => mm.project_id === p.id).length,
                my_role: roleOf(p),
              };
            })
            .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at))),
        };
      }
      if (path === '/projects' && method === 'POST') {
        const me = this.requireUser();
        const name = localReqStr(body && body.name, 'nama proyek', 2, 120);
        const description = localOptStr(body && body.description, 'deskripsi', 600);
        // Guard kirim-ganda (15 detik) — kontrak sama dengan server.
        const cutoff = Date.now() - 15000;
        const recent = (await LDB.all('projects')).find(
          (p) => p.owner_id === me.id && p.name === name && Date.parse(p.created_at) > cutoff
        );
        if (recent) return { project: recent };
        const now = this.now();
        const project = {
          id: this.nextId(),
          name,
          description,
          owner_id: me.id,
          status: 'active',
          created_at: now,
          updated_at: now,
          sync: null,
        };
        await LDB.put('projects', project);
        return { project };
      }
      if ((m = path.match(/^\/projects\/(\d+)$/))) {
        const projectId = Number(m[1]);
        if (method === 'GET') {
          const me = this.requireUser();
          const acc = await this.accessProject(projectId, me);
          if (!acc) throw localErr(404, 'not_found', 'Proyek tidak ditemukan atau Anda tidak punya akses.');
          const users = this.users();
          const owner = users.find((u) => u.id === acc.project.owner_id) || { username: '?', display_name: '?' };
          return {
            project: acc.project,
            scripts: (await this.scriptsOf(projectId)).map((s) => this.meta(s)),
            members: (await this.membersOf(projectId)).map((mm) => {
              const u = users.find((x) => x.id === mm.user_id) || {};
              return {
                user_id: mm.user_id,
                member_role: 'member',
                added_at: mm.added_at,
                username: u.username || '?',
                display_name: u.display_name || '?',
              };
            }),
            owner: { username: owner.username, display_name: owner.display_name },
            my_role: acc.role,
            can_manage: this.canManage(acc.role, me),
          };
        }
        if (method === 'PATCH' || method === 'DELETE') {
          const me = this.requireUser();
          const acc = await this.accessProject(projectId, me);
          if (!acc) throw localErr(404, 'not_found', 'Proyek tidak ditemukan atau Anda tidak punya akses.');
          if (!this.canManage(acc.role, me))
            throw localErr(403, 'forbidden', 'Hanya pemilik proyek atau super admin yang dapat mengubah/menghapus proyek.');
          if (method === 'DELETE') {
            for (const s of await this.scriptsOf(projectId)) await LDB.del('scripts', s.id);
            for (const mm of await this.membersOf(projectId)) await LDB.del('members', mm.key);
            await LDB.del('projects', projectId);
            return { deleted: true };
          }
          const p = acc.project;
          if (body.name !== undefined) p.name = localReqStr(body.name, 'nama proyek', 2, 120);
          if (body.description !== undefined) p.description = localOptStr(body.description, 'deskripsi', 600);
          if (body.status !== undefined) {
            if (!['active', 'archived'].includes(body.status)) throw localErr(400, 'validation', 'Status hanya active/archived.');
            p.status = body.status;
          }
          p.updated_at = this.now();
          await LDB.put('projects', p);
          return { project: p };
        }
      }

      // ----- Anggota proyek -----
      if ((m = path.match(/^\/projects\/(\d+)\/members$/)) && method === 'POST') {
        const me = this.requireUser();
        const projectId = Number(m[1]);
        const acc = await this.accessProject(projectId, me);
        if (!acc) throw localErr(404, 'not_found', 'Proyek tidak ditemukan.');
        if (!this.canManage(acc.role, me))
          throw localErr(403, 'forbidden', 'Hanya pemilik proyek atau super admin yang dapat menambah anggota.');
        const username = localValidUsername(body && body.username);
        const target = this.users().find((x) => x.username === username);
        if (!target) throw localErr(404, 'not_found', `Pengguna "${username}" tidak ditemukan.`);
        if (target.id === acc.project.owner_id)
          throw localErr(409, 'conflict', 'Pemilik proyek tidak perlu ditambahkan sebagai anggota.');
        const key = projectId + ':' + target.id;
        if (await LDB.get('members', key)) throw localErr(409, 'conflict', `${username} sudah menjadi anggota.`);
        await LDB.put('members', { key, project_id: projectId, user_id: target.id, added_at: this.now() });
        return {
          user_id: target.id,
          username: target.username,
          display_name: target.display_name,
          member_role: 'member',
          added_at: this.now(),
        };
      }
      if ((m = path.match(/^\/projects\/(\d+)\/members\/(\d+)$/)) && method === 'DELETE') {
        const me = this.requireUser();
        const projectId = Number(m[1]);
        const targetUserId = Number(m[2]);
        const acc = await this.accessProject(projectId, me);
        if (!acc) throw localErr(404, 'not_found', 'Proyek tidak ditemukan.');
        const selfLeave = targetUserId === me.id && acc.role === 'member';
        if (!this.canManage(acc.role, me) && !selfLeave)
          throw localErr(403, 'forbidden', 'Tidak diizinkan menghapus anggota ini.');
        await LDB.del('members', projectId + ':' + targetUserId);
        return { removed: true };
      }

      // ----- Naskah -----
      if ((m = path.match(/^\/projects\/(\d+)\/scripts$/)) && method === 'POST') {
        const me = this.requireUser();
        const projectId = Number(m[1]);
        const acc = await this.accessProject(projectId, me);
        if (!acc) throw localErr(404, 'not_found', 'Proyek tidak ditemukan atau Anda tidak punya akses.');
        const title = localReqStr(body && body.title, 'judul naskah', 2, 120);
        const content = localOptStr(body && body.content, 'isi naskah', 100000);
        const wpm = body && body.words_per_minute !== undefined ? localValidWpm(body.words_per_minute) : 140;
        // Guard kirim-ganda (15 detik) — mencegah naskah dobel (autosave vs Simpan).
        const cutoff = Date.now() - 15000;
        const recent = (await this.scriptsOf(projectId)).find(
          (s) => s.title === title && s.created_by === me.id && Date.parse(s.created_at) > cutoff
        );
        if (recent) return { script: this.meta(recent) };
        const now = this.now();
        const script = {
          id: this.nextId(),
          project_id: projectId,
          title,
          content,
          words_per_minute: wpm,
          word_count: wordCount(content),
          created_by: me.id,
          created_at: now,
          updated_at: now,
          sync: null,
        };
        await LDB.put('scripts', script);
        return { script: this.meta(script) };
      }
      if ((m = path.match(/^\/scripts\/(\d+)$/))) {
        const scriptId = Number(m[1]);
        const me = this.requireUser();
        const script = await LDB.get('scripts', scriptId);
        if (!script) throw localErr(404, 'not_found', 'Naskah tidak ditemukan.');
        const acc = await this.accessProject(script.project_id, me);
        if (!acc) throw localErr(403, 'forbidden', 'Anda tidak punya akses ke naskah ini.');
        if (method === 'GET') {
          return {
            script,
            project: acc.project,
            my_role: acc.role,
            can_manage: this.canManage(acc.role, me),
          };
        }
        if (method === 'PUT' || method === 'PATCH' || method === 'DELETE') {
          const isOwnerOrAdmin = this.canManage(acc.role, me);
          const isOwnScript = acc.role === 'member' && script.created_by === me.id;
          if (!isOwnerOrAdmin && !isOwnScript)
            throw localErr(403, 'forbidden', 'Anggota hanya dapat mengubah naskah yang dibuatnya sendiri.');
          if (method === 'DELETE') {
            if (!isOwnerOrAdmin)
              throw localErr(403, 'forbidden', 'Hanya pemilik proyek atau super admin yang dapat menghapus naskah.');
            await LDB.del('scripts', scriptId);
            return { deleted: true };
          }
          if (body.title !== undefined) script.title = localReqStr(body.title, 'judul naskah', 2, 120);
          if (body.content !== undefined) {
            script.content = localOptStr(body.content, 'isi naskah', 100000);
            script.word_count = wordCount(script.content);
          }
          if (body.words_per_minute !== undefined) script.words_per_minute = localValidWpm(body.words_per_minute);
          script.updated_at = this.now();
          await LDB.put('scripts', script);
          return { script: this.meta(script) };
        }
      }

      // ----- Manajemen pengguna (super admin) -----
      if (path === '/users' && method === 'GET') {
        this.requireAdmin();
        const [projects, members] = [await LDB.all('projects'), await LDB.all('members')];
        return {
          users: this
            .users()
            .slice()
            .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)))
            .map((u) => ({
              ...this.publicUser(u),
              projects_owned: projects.filter((p) => p.owner_id === u.id).length,
              memberships: members.filter((mm) => mm.user_id === u.id).length,
            })),
        };
      }
      if (path === '/users' && method === 'POST') {
        this.requireAdmin();
        const username = localValidUsername(body && body.username);
        const password = localValidPassword(body && body.password);
        const display_name = localOptStr(body && body.display_name, 'nama tampilan', 60) || username;
        const email = localValidEmail(body && body.email);
        const role = localValidRole(body && body.role);
        const list = this.users();
        if (list.some((u) => u.username === username))
          throw localErr(409, 'conflict', `Username "${username}" sudah dipakai.`);
        if (email && list.some((u) => u.email === email))
          throw localErr(409, 'conflict', 'Email sudah dipakai pengguna lain.');
        const now = this.now();
        const u = {
          id: this.nextId(),
          username,
          email,
          display_name,
          password_hash: await localHashPassword(password),
          role,
          is_active: true,
          created_at: now,
          last_login_at: null,
        };
        list.push(u);
        this.saveUsers(list);
        return { user: this.publicUser(u) };
      }
      if ((m = path.match(/^\/users\/(\d+)$/)) && (method === 'PATCH' || method === 'PUT')) {
        const me = this.requireAdmin();
        const userId = Number(m[1]);
        const list = this.users();
        const target = list.find((u) => u.id === userId);
        if (!target) throw localErr(404, 'not_found', 'Pengguna tidak ditemukan.');
        if (body.role !== undefined) {
          const role = localValidRole(body.role);
          if (target.role === 'super_admin' && role !== 'super_admin' && list.filter((u) => u.role === 'super_admin' && u.is_active).length <= 1)
            throw localErr(400, 'validation', 'Minimal harus ada satu super admin aktif.');
          if (target.id === me.id && role !== 'super_admin')
            throw localErr(400, 'validation', 'Tidak dapat menurunkan peran Anda sendiri.');
          target.role = role;
        }
        if (body.display_name !== undefined)
          target.display_name = localOptStr(body.display_name, 'nama tampilan', 60) || target.username;
        if (body.email !== undefined) {
          const email = localValidEmail(body.email);
          if (email && email !== target.email && list.some((u) => u.email === email && u.id !== userId))
            throw localErr(409, 'conflict', 'Email sudah dipakai pengguna lain.');
          target.email = email;
        }
        if (body.is_active !== undefined) {
          const active = !!body.is_active;
          if (target.is_active && !active && target.id === me.id)
            throw localErr(400, 'validation', 'Tidak dapat menonaktifkan akun Anda sendiri.');
          if (!active && target.role === 'super_admin' && list.filter((u) => u.role === 'super_admin' && u.is_active).length <= 1)
            throw localErr(400, 'validation', 'Minimal harus ada satu super admin aktif.');
          target.is_active = active;
        }
        if (body.password !== undefined && body.password !== '')
          target.password_hash = await localHashPassword(localValidPassword(body.password));
        this.saveUsers(list);
        return { user: this.publicUser(target) };
      }
      if ((m = path.match(/^\/users\/(\d+)$/)) && method === 'DELETE') {
        const me = this.requireAdmin();
        const userId = Number(m[1]);
        if (userId === me.id) throw localErr(400, 'validation', 'Tidak dapat menghapus akun Anda sendiri.');
        const list = this.users();
        const target = list.find((u) => u.id === userId);
        if (!target) throw localErr(404, 'not_found', 'Pengguna tidak ditemukan.');
        if (target.role === 'super_admin' && list.filter((u) => u.role === 'super_admin' && u.is_active).length <= 1)
          throw localErr(400, 'validation', 'Minimal harus ada satu super admin.');
        // Hapus data milik pengguna (kontrak server): proyek + naskah + keanggotaan.
        for (const p of (await LDB.all('projects')).filter((p) => p.owner_id === userId)) {
          for (const s of await this.scriptsOf(p.id)) await LDB.del('scripts', s.id);
          for (const mm of await this.membersOf(p.id)) await LDB.del('members', mm.key);
          await LDB.del('projects', p.id);
        }
        for (const mm of (await LDB.all('members')).filter((x) => x.user_id === userId)) await LDB.del('members', mm.key);
        this.saveUsers(list.filter((u) => u.id !== userId));
        return { deleted: true };
      }

      // ----- Statistik (super admin) -----
      if (path === '/stats' && method === 'GET') {
        this.requireAdmin();
        const [projects, scripts] = [await LDB.all('projects'), await LDB.all('scripts')];
        return {
          stats: {
            users: this.users().length,
            projects: projects.length,
            scripts: scripts.length,
            active_sessions: this.currentUser() ? 1 : 0,
          },
        };
      }

      throw localErr(404, 'not_found', `Endpoint ${method} ${path} tidak ditemukan.`);
    },
  };

  // ---------- Sinkronisasi opsional ke server (mode perangkat) ----------
  // Data utama tetap tersimpan di perangkat; sinkron menyalin proyek & naskah
  // dua arah dengan server (Unduh = data server menang, Unggah = data perangkat
  // menang) agar naskah tetap bisa dilanjutkan di versi web. Aturan:
  //  - pasangan lokal-server dilacak lewat bidang sync.serverId;
  //  - hanya naskah yang berubah sejak sinkron terakhir yang dikirim (hemat kuota);
  //  - error per item tidak menghentikan sisanya — dilaporkan sebagai ringkasan.
  const Sync = {
    server() {
      const saved = LR.get('syncserver', '');
      if (saved) return saved;
      // Pengembangan/pengujian (localhost): worker lokal di origin yang sama.
      // Produksi (APK): server resmi Basarang.
      if (location.hostname === 'localhost' || location.hostname === '127.0.0.1') return location.origin;
      return 'https://basarang.synclicen.workers.dev';
    },
    acc() {
      return LR.get('sync', null);
    },
    clearAcc() {
      LR.del('sync');
    },
    async _fetch(method, path, body, token) {
      let res;
      try {
        res = await fetch(this.server() + '/api' + path, {
          method,
          headers: {
            'content-type': 'application/json',
            ...(token ? { authorization: 'Bearer ' + token } : {}),
          },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
      } catch {
        throw localErr(0, 'offline', 'Tidak dapat terhubung ke server — periksa koneksi internet Anda.');
      }
      let data = null;
      try {
        data = await res.json();
      } catch {
        /* kosong */
      }
      if (!res.ok || !data || data.ok === false) {
        throw localErr(res.status, (data && data.error) || 'sync', (data && data.message) || 'Gagal terhubung ke server (' + res.status + ').');
      }
      return data.data;
    },
    async login(username, password) {
      const d = await this._fetch('POST', '/auth/login', { username, password });
      if (!d || !d.token) throw localErr(500, 'sync', 'Server tidak mengembalikan token sinkron.');
      LR.set('sync', { username: d.user.username, display_name: d.user.display_name, token: d.token, ts: Date.now() });
      return d.user;
    },
    // Unduh: salin semua proyek & naskah dari server ke penyimpanan perangkat.
    async download() {
      LocalApi.requireUser();
      const acc = this.acc();
      if (!acc) throw localErr(401, 'sync_auth', 'Hubungkan akun server dulu.');
      let nProj = 0;
      let nScript = 0;
      let errors = 0;
      const { projects } = await this._fetch('GET', '/projects', undefined, acc.token);
      for (const sp of projects || []) {
        try {
          let p = (await LDB.all('projects')).find((x) => x.sync && x.sync.serverId === sp.id);
          if (!p) {
            p = {
              id: LocalApi.nextId(),
              name: sp.name,
              description: sp.description,
              status: sp.status,
              owner_id: LocalApi.requireUser().id,
              created_at: sp.created_at,
              updated_at: sp.updated_at,
              sync: { serverId: sp.id },
            };
            nProj++;
          } else {
            p.name = sp.name;
            p.description = sp.description;
            p.status = sp.status;
            p.updated_at = sp.updated_at;
          }
          await LDB.put('projects', p);
          const det = await this._fetch('GET', '/projects/' + sp.id, undefined, acc.token);
          for (const ss of det.scripts || []) {
            try {
              let s = (await LDB.all('scripts')).find((x) => x.sync && x.sync.serverId === ss.id);
              if (s && Date.parse(s.updated_at) >= Date.parse(ss.updated_at)) continue; // lokal lebih baru/sama
              const full = await this._fetch('GET', '/scripts/' + ss.id, undefined, acc.token);
              const f = full.script;
              if (!s) {
                s = {
                  id: LocalApi.nextId(),
                  project_id: p.id,
                  title: f.title,
                  content: f.content || '',
                  words_per_minute: f.words_per_minute || 140,
                  word_count: f.word_count != null ? f.word_count : wordCount(f.content),
                  created_by: LocalApi.requireUser().id,
                  created_at: f.created_at,
                  updated_at: f.updated_at,
                  sync: { serverId: ss.id },
                };
                nScript++;
              } else {
                s.project_id = p.id;
                s.title = f.title;
                s.content = f.content || '';
                s.words_per_minute = f.words_per_minute || 140;
                s.word_count = f.word_count != null ? f.word_count : wordCount(f.content);
                s.updated_at = f.updated_at;
              }
              await LDB.put('scripts', s);
            } catch (e) {
              errors++;
              console.error('sinkron unduh naskah gagal:', e && e.message);
            }
          }
        } catch (e) {
          errors++;
          console.error('sinkron unduh proyek gagal:', e && e.message);
        }
      }
      return { projects: nProj, scripts: nScript, errors };
    },
    // Unggah: kirim semua proyek & naskah perangkat yang berubah sejak sinkron
    // terakhir (atau belum pernah ada) ke server.
    async upload() {
      LocalApi.requireUser();
      const acc = this.acc();
      if (!acc) throw localErr(401, 'sync_auth', 'Hubungkan akun server dulu.');
      let nProj = 0;
      let nScript = 0;
      let errors = 0;
      const projects = await LDB.all('projects');
      for (const p of projects) {
        try {
          if (!p.sync || !p.sync.serverId) {
            const d = await this._fetch('POST', '/projects', { name: p.name, description: p.description }, acc.token);
            p.sync = { ...(p.sync || {}), serverId: d.project.id };
            nProj++;
          } else if (!p.sync.pushedAt || Date.parse(p.updated_at) > Date.parse(p.sync.pushedAt)) {
            await this._fetch(
              'PATCH',
              '/projects/' + p.sync.serverId,
              { name: p.name, description: p.description, status: p.status },
              acc.token
            );
          }
          const scripts = await LocalApi.scriptsOf(p.id);
          for (const s of scripts) {
            if (!s.sync || !s.sync.serverId) {
              const d = await this._fetch(
                'POST',
                '/projects/' + p.sync.serverId + '/scripts',
                { title: s.title, content: s.content, words_per_minute: s.words_per_minute },
                acc.token
              );
              s.sync = { serverId: d.script.id };
              nScript++;
            } else if (!s.sync.at || Date.parse(s.updated_at) > Date.parse(s.sync.at)) {
              await this._fetch(
                'PUT',
                '/scripts/' + s.sync.serverId,
                { title: s.title, content: s.content, words_per_minute: s.words_per_minute },
                acc.token
              );
            }
            await LDB.put('scripts', s);
          }
          p.sync.pushedAt = new Date().toISOString();
          await LDB.put('projects', p);
        } catch (e) {
          errors++;
          console.error('sinkron unggah gagal:', e && e.message);
        }
      }
      return { projects: nProj, scripts: nScript, errors };
    },
  };

  function syncPanel() {
    const acc = Sync.acc();
    openModal({
      title: 'Sinkronisasi Server',
      bodyHtml: acc
        ? `
        <p class="hint" style="margin-top:0">Terhubung sebagai <b>${esc(acc.display_name || acc.username)}</b> (@${esc(acc.username)}).
        Data utama tetap tersimpan di perangkat ini — sinkron menyalin proyek &amp; naskah ke/dari server agar bisa dilanjutkan di versi web.</p>
        ${Off.online ? '' : '<div class="off-note">Anda sedang luring — sinkron memerlukan koneksi internet.</div>'}
        <div class="row" style="gap:10px;flex-wrap:wrap">
          <button class="btn btn-purple" type="button" id="sync-dl">${I.sync} Unduh dari Server</button>
          <button class="btn btn-gold" type="button" id="sync-ul">${I.sync} Unggah ke Server</button>
        </div>
        <div id="sync-out" class="hint" style="min-height:18px;margin-top:10px"></div>
        <div class="modal-foot" style="padding:12px 0 0">
          <button class="btn btn-ghost" type="button" id="sync-out-btn">Keluar Akun Sinkron</button>
        </div>`
        : `
        <p class="hint" style="margin-top:0">Masuk dengan akun server Basarang (versi web) untuk menyalin proyek &amp; naskah dua arah. Akun server dibuat oleh super admin di versi web.</p>
        <form id="sync-form" novalidate>
          <label class="field">
            <span class="label-txt">Username server</span>
            <input class="input" name="username" autocomplete="username" autocapitalize="none" required>
          </label>
          <label class="field">
            <span class="label-txt">Kata sandi server</span>
            <input class="input" name="password" type="password" autocomplete="current-password" required>
          </label>
          <div class="form-err" id="sync-err"></div>
          <button class="btn btn-gold btn-block" type="submit">Hubungkan Akun Server</button>
        </form>`,
      onMount(root, close) {
        const form = root.querySelector('#sync-form');
        if (form) {
          form.addEventListener('submit', async (e) => {
            e.preventDefault();
            const errEl = root.querySelector('#sync-err');
            errEl.textContent = '';
            const fd = new FormData(form);
            const btn = form.querySelector('button[type=submit]');
            btn.disabled = true;
            btn.textContent = 'Menghubungkan…';
            try {
              const u = await Sync.login(String(fd.get('username') || '').trim().toLowerCase(), String(fd.get('password') || ''));
              toast('Akun server terhubung: ' + u.display_name, 'ok');
              close();
              syncPanel();
            } catch (err) {
              errEl.textContent = err.message;
              btn.disabled = false;
              btn.textContent = 'Hubungkan Akun Server';
            }
          });
        }
        const out = root.querySelector('#sync-out');
        const runBtn = (btn, fn, label) => {
          btn.addEventListener('click', async () => {
            btn.disabled = true;
            btn.textContent = 'Memproses…';
            out.textContent = 'Menyalin… (mohon tunggu)';
            out.style.color = '';
            try {
              const r = await fn();
              out.style.color = 'var(--ok)';
              out.textContent = `Selesai — ${r.projects} proyek & ${r.scripts} naskah diproses${r.errors ? `; ${r.errors} item gagal (lihat konsol)` : ''}.`;
              toast('Sinkron selesai.', 'ok');
              render();
            } catch (err) {
              out.style.color = 'var(--err)';
              out.textContent = err.message;
              btn.disabled = false;
              btn.textContent = label;
            }
          });
        };
        const dl = root.querySelector('#sync-dl');
        const ul = root.querySelector('#sync-ul');
        if (dl) runBtn(dl, () => Sync.download(), 'Unduh dari Server');
        if (ul) runBtn(ul, () => Sync.upload(), 'Unggah ke Server');
        const outBtn = root.querySelector('#sync-out-btn');
        if (outBtn)
          outBtn.addEventListener('click', () => {
            Sync.clearAcc();
            toast('Akun sinkron diputus.', 'info');
            close();
            syncPanel();
          });
      },
    });
  }

  function toast(msg, type = 'info', ms = 2600) {
    const node = el(`<div class="toast ${esc(type)}">${esc(msg)}</div>`);
    $toastRoot.appendChild(node);
    setTimeout(() => {
      node.style.opacity = '0';
      node.style.transition = 'opacity .3s';
      setTimeout(() => node.remove(), 320);
    }, ms);
  }

  function debounce(fn, ms) {
    let t = null;
    const wrapped = (...a) => {
      clearTimeout(t);
      t = setTimeout(() => fn(...a), ms);
    };
    wrapped.flush = (...a) => {
      clearTimeout(t);
      return fn(...a);
    };
    wrapped.cancel = () => clearTimeout(t);
    return wrapped;
  }

  const fmtRel = (() => {
    const rtf = new Intl.RelativeTimeFormat('id', { numeric: 'auto' });
    return (iso) => {
      if (!iso) return '—';
      const t = new Date(iso).getTime();
      if (!Number.isFinite(t)) return '—';
      const diff = t - Date.now();
      const abs = Math.abs(diff);
      const min = 60e3;
      const hour = 60 * min;
      const day = 24 * hour;
      if (abs < min) return 'baru saja';
      if (abs < hour) return rtf.format(Math.round(diff / min), 'minute');
      if (abs < day) return rtf.format(Math.round(diff / hour), 'hour');
      if (abs < 30 * day) return rtf.format(Math.round(diff / day), 'day');
      return new Date(iso).toLocaleDateString('id-ID', { day: 'numeric', month: 'short', year: 'numeric' });
    };
  })();

  function wordCount(text) {
    const m = String(text || '').trim().match(/[\p{L}\p{N}'’-]+/gu);
    return m ? m.length : 0;
  }
  function estMinutes(words, wpm) {
    if (!wpm) wpm = 140;
    const sec = Math.round((words / wpm) * 60);
    if (sec < 60) return sec + ' detik';
    return Math.round(sec / 60) + ' menit';
  }
  function initials(name) {
    const parts = String(name || '?').trim().split(/\s+/);
    return ((parts[0] || '?')[0] + (parts.length > 1 ? (parts[parts.length - 1][0] || '') : '')).toUpperCase();
  }
  function roleName(role) {
    return { super_admin: 'Super Admin', manager: 'Manager', member: 'Member' }[role] || role;
  }

  // ---------- Ikon SVG ----------

  const I = {
    play: '<svg class="icon" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5.5v13l11-6.5z"/></svg>',
    pause: '<svg class="icon" viewBox="0 0 24 24" fill="currentColor"><path d="M7 5h3.5v14H7zM13.5 5H17v14h-3.5z"/></svg>',
    mic: '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></svg>',
    auto: '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20 17.5 6.5"/><path d="M17.5 3 18.4 5.1 20.5 6 18.4 6.9 17.5 9 16.6 6.9 14.5 6 16.6 5.1Z" stroke-width="1.6"/><path d="M21.5 12.5v2.2M20.4 13.6h2.2" stroke-width="1.6"/></svg>',
    gear: '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1 1.55V21a2 2 0 1 1-4 0v-.09a1.7 1.7 0 0 0-1-1.55 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.7 1.7 0 0 0 .34-1.87 1.7 1.7 0 0 0-1.55-1H3a2 2 0 1 1 0-4h.09a1.7 1.7 0 0 0 1.55-1 1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34h.01a1.7 1.7 0 0 0 1-1.55V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1 1.55h.01a1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87v.01a1.7 1.7 0 0 0 1.55 1H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.55 1z"/></svg>',
    mirror: '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 2v20M8 7 4 12l4 5M16 7l4 5-4 5"/></svg>',
    plus: '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
    back: '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M15 5l-7 7 7 7"/></svg>',
    close: '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>',
    trash: '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg>',
    edit: '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16v4zM13 6.5 17.5 11"/></svg>',
    prompter: '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4.5" width="18" height="13" rx="2.5"/><path d="M7 9h9M7 12.5h5.5" stroke-width="1.8"/><path d="M12 17.5v3M8 21h8" stroke-width="1.8"/></svg>',
    users: '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0M16 5.2a3.5 3.5 0 0 1 0 5.6M21.5 20a6.5 6.5 0 0 0-4.5-6.2"/></svg>',
    logout: '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 4H5a1 1 0 0 0-1 1v14a1 1 0 0 0 1 1h4M15 8l4 4-4 4M19 12H9"/></svg>',
    key: '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="14" r="4"/><path d="M11 11 20 2M17 5l3 3M15 7l2 2"/></svg>',
    sync: '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 12a8 8 0 1 1-2.3-5.6M20 4v5h-5"/></svg>',
    fontUp: '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M4 20 9 6l5 14M5.8 15.5h6.4M15 12h6M18 9v6"/></svg>',
    fontDown: '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M4 20 9 6l5 14M5.8 15.5h6.4M15 15h6M18 12v6"/></svg>',
    video: '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><rect x="3" y="6" width="13" height="12" rx="2"/><path d="M16 10l5-3v10l-5-3"/></svg>',
    full: '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/></svg>',
    check: '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 12.5 10 18 19.5 7"/></svg>',
  };

  // ---------- Modal ----------

  function openModal({ title, bodyHtml, wide, onMount, onClose }) {
    const root = el(`
      <div class="modal-back">
        <div class="modal ${wide ? 'wide' : ''}" role="dialog" aria-modal="true" aria-label="${esc(title)}">
          <div class="modal-head">
            <h3>${esc(title)}</h3>
            <button class="x-btn" type="button" aria-label="Tutup">×</button>
          </div>
          <div class="modal-body"></div>
        </div>
      </div>`);
    const bodyEl = root.querySelector('.modal-body');
    bodyEl.appendChild(typeof bodyHtml === 'string' ? el(`<div>${bodyHtml}</div>`) : bodyHtml);
    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      root.remove();
      document.removeEventListener('keydown', onKey);
      if (onClose) onClose();
    };
    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        close();
      }
    };
    root.querySelector('.x-btn').addEventListener('click', close);
    root.addEventListener('mousedown', (e) => {
      if (e.target === root) close();
    });
    document.addEventListener('keydown', onKey);
    $modalRoot.appendChild(root);
    if (onMount) onMount(root, close);
    const firstInput = root.querySelector('input, textarea, select');
    if (firstInput) setTimeout(() => firstInput.focus(), 60);
    return { root, close };
  }

  function confirmDialog(title, message, { danger = true, okLabel = 'Ya, lanjutkan' } = {}) {
    return new Promise((resolve) => {
      openModal({
        title,
        bodyHtml: `<p style="margin:0;color:var(--text-2)">${esc(message)}</p>`,
        onMount(root, close) {
          const yes = el(`<button class="btn ${danger ? 'btn-danger' : 'btn-gold'}" type="button">${esc(okLabel)}</button>`);
          const no = el('<button class="btn btn-ghost" type="button">Batal</button>');
          // PENTING: resolve() harus dipanggil SEBELUM close() — close() memicu
          // onClose() yang juga me-resolve(false); Promise hanya menerima resolusi
          // pertama, jadi bila close() lebih dulu, klik "Ya" selalu dibaca batal.
          yes.addEventListener('click', () => {
            resolve(true);
            close();
          });
          no.addEventListener('click', () => {
            resolve(false);
            close();
          });
          const foot = el('<div class="modal-foot"></div>');
          foot.append(no, yes);
          root.querySelector('.modal-body').appendChild(foot);
        },
        onClose() {
          resolve(false);
        },
      });
    });
  }

  // ---------- Topbar & shell ----------

  function topbarHtml(active) {
    const u = state.user;
    const adminBtn =
      u && u.role === 'super_admin'
        ? `<a class="btn btn-ghost btn-sm ${active === 'admin' ? 'on' : ''}" href="#/admin" title="Kelola pengguna">${I.users}<span class="hide-sm">Pengguna</span></a>`
        : '';
    return `
    <header class="topbar">
      <div class="topbar-inner">
        <a class="brand" href="#/dashboard">
          <span class="brand-mark">${I.prompter}</span>
          <span class="brand-name"><em>BASARANG</em><span class="brand-tail">: Bagarak Saurang</span></span>
        </a>
        <div class="topbar-actions">
          ${LOCAL
            ? '<span class="pill pill-ok" title="Mode perangkat — seluruh data tersimpan di perangkat ini tanpa internet; sinkronisasi ke server bersifat opsional">Perangkat</span>' +
              '<button class="btn btn-ghost btn-sm" id="btn-sync" title="Sinkronisasi opsional dengan server Basarang (butuh internet)">' + I.sync + '<span class="hide-sm">Sinkron</span></button>'
            : state.luring || !Off.online
            ? '<span class="pill pill-warn" title="Tanpa koneksi — menampilkan data tersimpan di perangkat; perubahan dikirim otomatis saat online">Luring</span>'
            : Off.queue.length
              ? `<span class="pill pill-warn" title="${Off.queue.length} perubahan menunggu terkirim ke server">Kirim tertunda (${Off.queue.length})</span>`
              : ''}
          ${adminBtn}
          <a class="btn btn-ghost btn-sm" href="#/dashboard" title="Proyek">${I.prompter}<span class="hide-sm">Proyek</span></a>
          <button class="btn btn-ghost btn-sm" id="btn-pass" title="Ubah kata sandi">${I.key}</button>
          <div class="userchip">
            <span class="avatar">${esc(initials(u ? u.display_name : '?'))}</span>
            <span class="meta">
              <span class="nm">${esc(u ? u.display_name : '')}</span>
              <span class="rl">${esc(u ? roleName(u.role) : '')}</span>
            </span>
          </div>
          <button class="btn btn-ghost btn-sm" id="btn-logout" title="Keluar">${I.logout}</button>
        </div>
      </div>
    </header>`;
  }

  function bindLogout() {
    const b = document.getElementById('btn-logout');
    if (!b) return;
    b.addEventListener('click', async () => {
      try {
        await api('/auth/logout', { method: 'POST' });
      } catch {
        /* abaikan */
      }
      // Keluar = hapus semua data pribadi di perangkat (cache luring, draf, antrean).
      Off.clearAll();
      state.user = null;
      state.needsSetup = false;
      state.luring = false;
      navigate('#/login');
      toast('Anda telah keluar.', 'info');
    });
    const p = document.getElementById('btn-pass');
    if (p) p.addEventListener('click', () => passwordForm());
    // Tombol Sinkron (hanya mode perangkat): salin proyek & naskah dua arah
    // dengan server — opsional, data utama tetap di perangkat.
    const sb = document.getElementById('btn-sync');
    if (sb) sb.addEventListener('click', () => syncPanel());
  }

  function passwordForm() {
    openModal({
      title: 'Ubah Kata Sandi',
      bodyHtml: `
      <form id="pass-form" novalidate>
        <label class="field">
          <span class="label-txt">Kata sandi saat ini</span>
          <input class="input" name="current" type="password" autocomplete="current-password" required>
        </label>
        <label class="field">
          <span class="label-txt">Kata sandi baru</span>
          <input class="input" name="next" type="password" minlength="8" maxlength="128" autocomplete="new-password" required>
          <span class="hint">Minimal 8 karakter. Sesi di perangkat lain akan dikeluarkan.</span>
        </label>
        <div class="form-err" id="pass-err"></div>
        <button class="btn btn-gold btn-block" type="submit">Simpan Kata Sandi Baru</button>
      </form>`,
      onMount(root, close) {
        root.querySelector('#pass-form').addEventListener('submit', async (e) => {
          e.preventDefault();
          const errEl = root.querySelector('#pass-err');
          errEl.textContent = '';
          const fd = new FormData(e.target);
          try {
            await api('/auth/password', {
              method: 'POST',
              body: { current: fd.get('current'), next: fd.get('next') },
            });
            close();
            toast('Kata sandi berhasil diganti.', 'ok');
          } catch (err) {
            errEl.textContent = err.message;
          }
        });
      },
    });
  }

  // ---------- Router ----------

  function navigate(hash) {
    if (location.hash === hash) {
      render();
    } else {
      location.hash = hash;
    }
  }

  let currentCleanup = null;

  async function render() {
    if (currentCleanup) {
      try {
        currentCleanup();
      } catch {
        /* abaikan */
      }
      currentCleanup = null;
    }
    const hash = location.hash || '#/';
    const parts = hash.replace(/^#\//, '').split('/').filter(Boolean);
    const page = parts[0] || '';

    if (!state.booted) {
      $app.innerHTML = `<div class="page container"><div class="skel" style="height:200px"></div></div>`;
      return;
    }

    if (page === 'prompter' && parts[1]) {
      await viewPrompter(Number(parts[1]));
      return;
    }
    if (state.needsSetup) {
      return viewSetup();
    }
    if (!state.user) {
      return viewLogin();
    }
    if (!page || page === 'dashboard') return viewDashboard();
    if (page === 'project' && parts[1]) return viewProject(Number(parts[1]));
    if (page === 'admin') {
      if (state.user.role !== 'super_admin') {
        toast('Akses khusus super admin.', 'err');
        return navigate('#/dashboard');
      }
      return viewAdmin();
    }
    navigate('#/dashboard');
  }

  // ---------- View: Setup pertama ----------

  function viewSetup() {
    $app.innerHTML = `
    <div class="auth-wrap container">
      <div class="auth-card">
        <div class="auth-hero">
          <div class="mark-trio">
            <span class="mark mark-gold">${I.prompter}</span>
            <span class="mark mark-purple">${I.mic}</span>
            <span class="mark mark-silver">${I.auto}</span>
          </div>
          <h1><em>BASARANG</em>: Bagarak Saurang</h1>
          <p class="tag">Inisialisasi pertama — buat akun <b>Super Admin</b> untuk memulai.</p>
          <div class="feature-row">
            ${LOCAL
              ? '<span class="pill pill-gold">Full offline</span><span class="pill pill-purple">Sinkron opsional</span>'
              : '<span class="pill pill-gold">Sinkron lintas perangkat</span><span class="pill pill-purple">Gratis 100%</span>'}
          </div>
        </div>
        <form class="card" id="setup-form" novalidate>
          <label class="field">
            <span class="label-txt">Nama tampilan</span>
            <input class="input" name="display_name" maxlength="60" autocomplete="name">
          </label>
          <label class="field">
            <span class="label-txt">Username</span>
            <input class="input" name="username" maxlength="30" autocomplete="username" required>
            <span class="hint">Huruf kecil, angka, titik, garis bawah, strip.</span>
          </label>
          <label class="field">
            <span class="label-txt">Email (opsional)</span>
            <input class="input" name="email" type="email" maxlength="120" autocomplete="email">
          </label>
          <label class="field">
            <span class="label-txt">Kata sandi</span>
            <input class="input" name="password" type="password" minlength="8" maxlength="128" autocomplete="new-password" required>
          </label>
          <div class="form-err" id="setup-err"></div>
          <button class="btn btn-gold btn-block btn-lg" type="submit">Buat Super Admin</button>
        </form>
      </div>
    </div>`;
    const form = document.getElementById('setup-form');
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const errEl = document.getElementById('setup-err');
      errEl.textContent = '';
      const fd = new FormData(form);
      const btn = form.querySelector('button[type=submit]');
      btn.disabled = true;
      btn.textContent = 'Membuat akun…';
      try {
        const data = await api('/auth/setup', {
          method: 'POST',
          body: {
            display_name: fd.get('display_name'),
            username: fd.get('username'),
            email: fd.get('email'),
            password: fd.get('password'),
          },
        });
        state.user = data.user;
        state.needsSetup = false;
        toast('Super admin berhasil dibuat. Selamat datang!', 'ok');
        navigate('#/dashboard');
      } catch (err) {
        errEl.textContent = err.message;
        btn.disabled = false;
        btn.textContent = 'Buat Super Admin';
      }
    });
  }

  // ---------- View: Login ----------

  function viewLogin() {
    $app.innerHTML = `
    <div class="auth-wrap container">
      <div class="auth-card">
        <div class="auth-hero">
          <div class="mark-trio">
            <span class="mark mark-gold">${I.prompter}</span>
            <span class="mark mark-purple">${I.mic}</span>
            <span class="mark mark-silver">${I.auto}</span>
          </div>
          <h1><em>BASARANG</em>: Bagarak Saurang</h1>
        </div>
        <form class="card" id="login-form" novalidate>
          <label class="field">
            <span class="label-txt">Username</span>
            <input class="input" name="username" autocomplete="username" autocapitalize="none" required>
          </label>
          <label class="field">
            <span class="label-txt">Kata sandi</span>
            <input class="input" name="password" type="password" autocomplete="current-password" required>
          </label>
          <div class="form-err" id="login-err"></div>
          <button class="btn btn-gold btn-block btn-lg" type="submit">Masuk</button>
          ${LOCAL
            ? '<p class="hint" style="text-align:center;margin-top:8px;color:var(--ok)">Mode perangkat — masuk tanpa internet; seluruh data tersimpan di perangkat ini.</p>'
            : Off.online
              ? ''
              : '<p class="hint" style="text-align:center;margin-top:8px;color:var(--gold-2)">Anda sedang luring — masuk memerlukan koneksi internet.</p>'}
          <p class="hint" style="text-align:center;margin-top:12px">${LOCAL ? 'Akun dibuat oleh super admin di perangkat ini.' : 'Akun dibuat oleh super admin. Lupa kata sandi? Hubungi pengelola.'}</p>
        </form>
      </div>
    </div>`;
    const form = document.getElementById('login-form');
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const errEl = document.getElementById('login-err');
      errEl.textContent = '';
      const fd = new FormData(form);
      const btn = form.querySelector('button[type=submit]');
      btn.disabled = true;
      btn.textContent = 'Memeriksa…';
      try {
        const data = await api('/auth/login', {
          method: 'POST',
          body: { username: fd.get('username'), password: fd.get('password') },
        });
        state.user = data.user;
        Off.cacheUser(data.user);
        toast('Selamat datang kembali, ' + data.user.display_name + '!', 'ok');
        navigate('#/dashboard');
      } catch (err) {
        errEl.textContent = err.message;
        btn.disabled = false;
        btn.textContent = 'Masuk';
      }
    });
  }

  // ---------- View: Dashboard ----------

  async function viewDashboard() {
    $app.innerHTML = `
    ${topbarHtml('dashboard')}
    <main class="page container">
      <div id="dash-off"></div>
      <div class="page-head">
        <div class="grow">
          <h2 class="page-title">Proyek</h2>
        </div>
        <button class="btn btn-gold" id="btn-new-proj">${I.plus} Proyek Baru</button>
      </div>
      <div class="stat-strip" id="dash-stats"></div>
      <div id="dash-projects" class="grid-cards"></div>
    </main>`;
    bindLogout();
    document.getElementById('btn-new-proj').addEventListener('click', () => projectForm(null));

    if (state.user.role === 'super_admin') {
      api('/stats')
        .then((d) => {
          const s = d.stats;
          document.getElementById('dash-stats').innerHTML = `
            <div class="stat"><div class="v">${s.projects}</div><div class="k">Proyek</div></div>
            <div class="stat"><div class="v">${s.scripts}</div><div class="k">Naskah</div></div>
            <div class="stat"><div class="v">${s.users}</div><div class="k">Pengguna</div></div>
            <div class="stat"><div class="v">${s.active_sessions}</div><div class="k">Sesi Aktif</div></div>`;
        })
        .catch(() => {});
    }

    const wrap = document.getElementById('dash-projects');
    wrap.innerHTML = '<div class="skel"></div><div class="skel"></div><div class="skel"></div>';
    let d = null;
    let luring = false;
    try {
      d = await api('/projects');
      Off.cacheProjects(d.projects || []);
      state.luring = false;
    } catch (err) {
      const c = Off.isTransientErr(err) ? Off.cachedProjects() : null;
      if (c) {
        d = { projects: c.projects };
        luring = true;
      } else {
        wrap.innerHTML = `<div class="empty-state" style="grid-column:1/-1"><h3>Tidak dapat memuat proyek</h3>
          <p>${esc(err.message)}</p>
          <p class="hint">Buka aplikasi sekali saat online agar daftar proyek tersimpan untuk mode luring.</p></div>`;
        return;
      }
    }
    if (luring) {
      state.luring = true;
      const offSlot = document.getElementById('dash-off');
      if (offSlot)
        offSlot.innerHTML =
          '<div class="off-note">Mode luring — menampilkan data terakhir yang tersimpan di perangkat. Perubahan yang Anda simpan akan dikirim otomatis saat kembali online.</div>';
    }
    {
      const projects = (d && d.projects) || [];
      if (!projects.length) {
        wrap.innerHTML = `
        <div class="empty-state" style="grid-column:1/-1">
          <h3>Belum ada proyek</h3>
          <p>Buat proyek pertama Anda, tambahkan naskah, lalu biarkan Basarang mengikuti suara Anda saat presentasi.</p>
          <button class="btn btn-gold" id="btn-new-proj-2">${I.plus} Buat Proyek Pertama</button>
        </div>`;
        const b2 = document.getElementById('btn-new-proj-2');
        if (b2) b2.addEventListener('click', () => projectForm(null));
        return;
      }
      wrap.innerHTML = projects
        .map((p) => {
          const rolePill =
            p.my_role === 'owner'
              ? '<span class="pill pill-gold">Pemilik</span>'
              : p.my_role === 'member'
                ? '<span class="pill pill-purple">Anggota</span>'
                : '<span class="pill">Pengawasan</span>';
          // Hapus langsung dari kartu: pemilik proyek atau super admin.
          const canDel = p.my_role === 'owner' || state.user.role === 'super_admin';
          return `
        <div class="proj-card-wrap">
          <a class="card card-hover proj-card" href="#/project/${p.id}">
            <div class="top">
              <h3>${esc(p.name)}</h3>
              ${p.status === 'archived' ? '<span class="pill">Arsip</span>' : ''}
            </div>
            <p class="desc">${esc(p.description || 'Tanpa deskripsi.')}</p>
            <div class="meta">
              ${rolePill}
              <span>${p.script_count} naskah</span>
              <span>·</span>
              <span>${p.member_count} anggota</span>
              <span>·</span>
              <span>${esc(fmtRel(p.created_at))}</span>
            </div>
          </a>
          ${canDel ? `<button class="btn btn-danger proj-del" data-pdel="${p.id}" title="Hapus proyek ${esc(p.name)}">${I.trash} Hapus</button>` : ''}
        </div>`;
        })
        .join('');
      // Hapus proyek langsung dari kartu dashboard — konfirmasi dulu, lalu muat ulang daftar.
      wrap.querySelectorAll('[data-pdel]').forEach((b) =>
        b.addEventListener('click', async () => {
          const p = projects.find((x) => String(x.id) === b.dataset.pdel);
          if (!p) return;
          const yes = await confirmDialog('Hapus proyek?', `Proyek "${p.name}" beserta seluruh naskah dan anggotanya akan dihapus permanen.`);
          if (!yes) return;
          try {
            await api('/projects/' + p.id, { method: 'DELETE' });
            toast('Proyek dihapus.', 'ok');
            viewDashboard();
          } catch (err) {
            toast(err.message, 'err');
          }
        })
      );
    }
  }

  function projectForm(project, onSaved) {
    const isEdit = !!project;
    openModal({
      title: isEdit ? 'Ubah Proyek' : 'Proyek Baru',
      bodyHtml: `
      <form id="proj-form" novalidate>
        <label class="field">
          <span class="label-txt">Nama proyek</span>
          <input class="input" name="name" value="${esc(isEdit ? project.name : '')}" maxlength="120" required>
        </label>
        <label class="field">
          <span class="label-txt">Deskripsi</span>
          <textarea class="textarea" name="description" maxlength="600" style="min-height:84px">${esc(isEdit ? project.description : '')}</textarea>
        </label>
        ${isEdit ? `
        <label class="field">
          <span class="label-txt">Status</span>
          <select class="select" name="status">
            <option value="active" ${project.status === 'active' ? 'selected' : ''}>Aktif</option>
            <option value="archived" ${project.status === 'archived' ? 'selected' : ''}>Arsip</option>
          </select>
        </label>` : ''}
        <div class="form-err" id="proj-err"></div>
        <button class="btn btn-gold btn-block" type="submit">${isEdit ? 'Simpan Perubahan' : 'Buat Proyek'}</button>
      </form>`,
      onMount(root, close) {
        root.querySelector('#proj-form').addEventListener('submit', async (e) => {
          e.preventDefault();
          const btn = e.target.querySelector('button[type=submit]');
          if (btn.disabled) return; // cegah kirim ganda (klik dua kali / Enter dua kali)
          const errEl = root.querySelector('#proj-err');
          errEl.textContent = '';
          const fd = new FormData(e.target);
          const body = { name: fd.get('name'), description: fd.get('description') };
          if (isEdit) body.status = fd.get('status');
          btn.disabled = true;
          btn.textContent = 'Menyimpan…';
          try {
            const data = isEdit
              ? await api('/projects/' + project.id, { method: 'PATCH', body })
              : await api('/projects', { method: 'POST', body });
            close();
            toast(isEdit ? 'Proyek diperbarui.' : 'Proyek dibuat.', 'ok');
            if (onSaved) onSaved(data);
            else render();
          } catch (err) {
            errEl.textContent = err.message;
            btn.disabled = false;
            btn.textContent = isEdit ? 'Simpan Perubahan' : 'Buat Proyek';
          }
        });
      },
    });
  }

  // ---------- View: Detail proyek ----------

  async function viewProject(projectId) {
    $app.innerHTML = `${topbarHtml('dashboard')}
    <main class="page container"><div class="skel" style="height:300px"></div></main>`;
    bindLogout();
    let d;
    let luring = false;
    try {
      d = await api('/projects/' + projectId);
      Off.cacheProject(d);
      state.luring = false;
    } catch (err) {
      const c = Off.isTransientErr(err) ? Off.cachedProject(projectId) : null;
      if (c) {
        d = c;
        luring = true;
      } else {
        $app.innerHTML = `${topbarHtml()}
      <main class="page container">
        <div class="empty-state"><h3>Tidak dapat membuka proyek</h3><p>${esc(err.message)}</p>
        <p class="hint">${Off.isTransientErr(err) ? 'Buka proyek ini sekali saat normal agar tersimpan untuk mode luring.' : ''}</p>
        <a class="btn btn-ghost mt-3" href="#/dashboard">${I.back} Kembali</a></div>
      </main>`;
        bindLogout();
        return;
      }
    }
    state.luring = luring;
    const { project, scripts, members, owner, my_role, can_manage } = d;
    const isOwner = my_role === 'owner';
    const canAddScript = my_role === 'owner' || my_role === 'member' || state.user.role === 'super_admin';

    $app.innerHTML = `
    ${topbarHtml('dashboard')}
    <main class="page container">
      <div class="crumbs"><a href="#/dashboard">Proyek</a> / <b>${esc(project.name)}</b></div>
      ${luring ? '<div class="off-note">Mode luring — menampilkan data terakhir yang tersimpan di perangkat. Perubahan yang Anda simpan akan dikirim otomatis saat kembali online.</div>' : ''}
      <div class="page-head">
        <div class="grow">
          <h2 class="page-title"><span class="gold">${esc(project.name)}</span>
            ${project.status === 'archived' ? '<span class="pill">Arsip</span>' : ''}</h2>
          <p class="page-sub">${esc(project.description || 'Tanpa deskripsi.')}
            — pemilik: <b>${esc(owner.display_name || owner.username)}</b></p>
        </div>
        <div class="row">
          ${canAddScript ? `<button class="btn btn-gold" id="btn-new-script">${I.plus} Naskah Baru</button>` : ''}
          ${can_manage ? `<button class="btn btn-ghost" id="btn-edit-proj">${I.edit} Ubah</button>
          <button class="btn btn-danger" id="btn-del-proj" title="Hapus proyek ini permanen">${I.trash} Hapus</button>` : ''}
        </div>
      </div>
      <div class="split">
        <section>
          <div class="row spread" style="margin-bottom:10px">
            <h3 style="margin:0;font-family:var(--font-brand);font-size:var(--fs-lg)">Naskah <span class="muted">(${scripts.length})</span></h3>
          </div>
          <div class="grid-cards" id="script-grid"></div>
        </section>
        <aside>
          <div class="card">
            <h4 style="margin:0 0 10px;font-size:var(--fs-sm);text-transform:uppercase;letter-spacing:.08em;color:var(--silver-3)">Anggota <span class="muted">(${members.length + 1})</span></h4>
            <div class="member-list" id="member-list"></div>
            ${can_manage ? `
            <form class="row mt-3" id="member-add" style="gap:6px">
              <input class="input" id="member-username" maxlength="30" style="min-width:0;flex:1" autocapitalize="none">
              <button class="btn btn-purple btn-sm" type="submit" style="min-height:40px">${I.plus}</button>
            </form>
            <p class="hint">Anggota dapat membaca, membuat, dan mengedit naskahnya sendiri.</p>` : ''}
          </div>
          <div class="card mt-3">
            <h4 style="margin:0 0 8px;font-size:var(--fs-sm);text-transform:uppercase;letter-spacing:.08em;color:var(--silver-3)">Peran Anda</h4>
            <p style="margin:0;font-size:var(--fs-sm);color:var(--text-2)">
              ${isOwner ? 'Pemilik proyek — kendali penuh atas naskah dan anggota.' : my_role === 'member' ? 'Anggota — dapat membaca semua naskah dan mengedit naskah buatan sendiri.' : 'Pengawasan (super admin) — melihat semua proyek organisasi.'}
            </p>
          </div>
        </aside>
      </div>
    </main>`;
    bindLogout();

    // --- render naskah ---
    const grid = document.getElementById('script-grid');
    if (!scripts.length) {
      grid.innerHTML = `<div class="empty-state" style="grid-column:1/-1">
        <h3>Belum ada naskah</h3>
        <p>Tulis naskah presentasi Anda, lalu buka teleprompter — teks akan mengikuti suara Anda.</p>
        <div class="row mt-3" style="justify-content:center">
          ${canAddScript ? `<button class="btn btn-gold" id="btn-new-script-2">${I.plus} Tulis Naskah Pertama</button>` : ''}
          ${can_manage ? `<button class="btn btn-danger" id="btn-del-proj-2">${I.trash} Hapus Proyek Ini</button>` : ''}
        </div>
      </div>`;
      // CATATAN: tombol "Tulis Naskah Pertama" (btn-new-script-2) TIDAK diikat di
      // sini — sudah diikat sekali lewat newBtns di bawah. Pernah diikat dua kali
      // (dua listener → scriptEditor terpanggil 2x → DUA modal bertumpuk; setelah
      // menyimpan, modal kembar kosong masih tersisa & terkesan "tidak tertutup").
    } else {
      grid.innerHTML = scripts
        .map((s) => {
          // Jumlah kata sudah dihitung server saat simpan (kolom word_count) —
          // daftar naskah TIDAK lagi memuat isi penuh (bisa puluhan MB untuk ratusan naskah).
          const w = Number(s.word_count) || 0;
          return `
        <div class="card card-hover script-card">
          <h4>${esc(s.title)}</h4>
          <div class="meta">
            <span>${w} kata</span><span>·</span><span>~${estMinutes(w, s.words_per_minute)}</span>
            <span>·</span><span>${esc(fmtRel(s.updated_at))}</span>
          </div>
          <div class="actions">
            <a class="btn btn-gold btn-sm" href="#/prompter/${s.id}">${I.prompter} Teleprompter</a>
            <button class="btn btn-ghost btn-sm" data-edit="${s.id}" title="Ubah naskah">${I.edit} Ubah</button>
            ${can_manage ? `<button class="btn btn-danger btn-sm" data-del="${s.id}" title="Hapus naskah">${I.trash} Hapus</button>` : ''}
          </div>
        </div>`;
        })
        .join('');
      grid.querySelectorAll('[data-edit]').forEach((b) =>
        b.addEventListener('click', async () => {
          const s = scripts.find((x) => String(x.id) === b.dataset.edit);
          if (!s) return;
          // Isi naskah diambil on-demand saat editor dibuka (daftar hanya metadata).
          let full = null;
          try {
            const d = await api('/scripts/' + s.id);
            full = d.script;
            Off.cacheScript(d.script);
          } catch (err) {
            // Luring / server bermasalah: pakai isi terakhir yang tersimpan di perangkat.
            if (Off.isTransientErr(err)) full = Off.cachedScript(s.id);
            if (!full) {
              toast(
                'Tidak dapat membuka naskah: ' + err.message + (Off.isTransientErr(err) ? ' (naskah ini belum pernah dibuka saat normal)' : ''),
                'err',
                4200
              );
              return;
            }
          }
          scriptEditor(project, full);
        })
      );
      grid.querySelectorAll('[data-del]').forEach((b) =>
        b.addEventListener('click', async () => {
          const s = scripts.find((x) => String(x.id) === b.dataset.del);
          const yes = await confirmDialog('Hapus naskah?', `Naskah "${s.title}" akan dihapus permanen beserta isinya.`);
          if (!yes) return;
          try {
            await api('/scripts/' + s.id, { method: 'DELETE' });
            toast('Naskah dihapus.', 'ok');
            // Naskah terakhir terhapus → proyek jadi kosong dan mudah terkesan "tak terhapus"
            // (proyek = wadah banyak naskah, bukan naskah itu sendiri) — tawarkan hapus sekalian.
            if (scripts.length <= 1 && can_manage) {
              const delProj = await confirmDialog(
                'Hapus proyek kosong ini?',
                `Proyek "${project.name}" kini tidak memiliki naskah. Hapus proyeknya sekalian?`,
                { okLabel: 'Ya, hapus proyek' }
              );
              if (delProj) {
                try {
                  await api('/projects/' + project.id, { method: 'DELETE' });
                  toast('Proyek dihapus.', 'ok');
                  navigate('#/dashboard');
                } catch (err) {
                  toast(err.message, 'err');
                  render();
                }
                return;
              }
            }
            render();
          } catch (err) {
            toast(err.message, 'err');
          }
        })
      );
    }
    const newBtns = [document.getElementById('btn-new-script'), document.getElementById('btn-new-script-2')];
    newBtns.forEach((b) => b && b.addEventListener('click', () => scriptEditor(project, null)));

    // --- render anggota ---
    const memberList = document.getElementById('member-list');
    const renderMembers = () => {
      memberList.innerHTML =
        `<span class="member-chip"><span class="avatar">${esc(initials(owner.display_name || owner.username))}</span>
          <b>${esc(owner.display_name || owner.username)}</b><span class="pill pill-gold" style="padding:1px 8px;font-size:10px">Pemilik</span></span>` +
        members
          .map(
            (m) => `<span class="member-chip">
              <span class="avatar">${esc(initials(m.display_name || m.username))}</span>
              <span>${esc(m.display_name || m.username)}</span>
              ${can_manage || m.user_id === state.user.id ? `<button class="rm" data-rm="${m.user_id}" title="Keluarkan anggota">${I.close}</button>` : ''}
            </span>`
          )
          .join('');
      memberList.querySelectorAll('[data-rm]').forEach((b) =>
        b.addEventListener('click', async () => {
          const uid = Number(b.dataset.rm);
          const self = uid === state.user.id;
          const yes = await confirmDialog(self ? 'Keluar dari proyek?' : 'Keluarkan anggota?',
            self ? 'Anda akan kehilangan akses ke naskah proyek ini.' : 'Anggota akan kehilangan akses ke proyek ini.');
          if (!yes) return;
          try {
            await api(`/projects/${project.id}/members/${uid}`, { method: 'DELETE' });
            toast(self ? 'Anda keluar dari proyek.' : 'Anggota dikeluarkan.', 'ok');
            if (self) navigate('#/dashboard');
            else render();
          } catch (err) {
            toast(err.message, 'err');
          }
        })
      );
    };
    renderMembers();

    const memberForm = document.getElementById('member-add');
    if (memberForm) {
      memberForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const input = document.getElementById('member-username');
        const btn = memberForm.querySelector('button[type=submit]');
        if (btn.disabled) return; // cegah kirim ganda
        const username = input.value.trim().toLowerCase();
        if (!username) return;
        btn.disabled = true;
        try {
          const data = await api(`/projects/${project.id}/members`, { method: 'POST', body: { username } });
          members.push(data);
          input.value = '';
          toast('Anggota ditambahkan: ' + data.username, 'ok');
          renderMembers();
        } catch (err) {
          toast(err.message, 'err');
        } finally {
          btn.disabled = false;
        }
      });
    }

    const editBtn = document.getElementById('btn-edit-proj');
    if (editBtn) editBtn.addEventListener('click', () => projectForm(project, () => render()));
    // Hapus proyek — dipakai tombol header (btn-del-proj) maupun tombol empty-state
    // "Hapus Proyek Ini" (btn-del-proj-2) saat proyek tak punya naskah lagi.
    const deleteProject = async () => {
      const yes = await confirmDialog('Hapus proyek?', `Proyek "${project.name}" beserta seluruh naskah dan anggotanya akan dihapus permanen.`);
      if (!yes) return;
      try {
        await api('/projects/' + project.id, { method: 'DELETE' });
        toast('Proyek dihapus.', 'ok');
        navigate('#/dashboard');
      } catch (err) {
        toast(err.message, 'err');
      }
    };
    const delBtn = document.getElementById('btn-del-proj');
    if (delBtn) delBtn.addEventListener('click', deleteProject);
    const delBtn2 = document.getElementById('btn-del-proj-2');
    if (delBtn2) delBtn2.addEventListener('click', deleteProject);
  }

  // ---------- Editor naskah (modal, autosave) ----------

  function scriptEditor(project, script) {
    const isNew = !script;
    const wpm = script ? script.words_per_minute : 140;
    openModal({
      title: isNew ? 'Naskah Baru — ' + project.name : 'Edit Naskah',
      wide: true,
      bodyHtml: `
      <form id="script-form" novalidate>
        <label class="field">
          <span class="label-txt">Judul naskah</span>
          <input class="input" name="title" value="${esc(isNew ? '' : script.title)}" maxlength="120" required>
        </label>
        <label class="field">
          <span class="label-txt">Isi naskah</span>
          <textarea class="textarea" name="content" id="content-ta" style="min-height:240px;font-size:var(--fs-md)">${esc(isNew ? '' : script.content)}</textarea>
        </label>
        <div class="row spread" style="gap:10px">
          <label class="field" style="margin:0;flex:1;max-width:220px">
            <span class="label-txt">Kecepatan baca (KPM)</span>
            <input class="input" name="words_per_minute" type="number" min="60" max="250" step="5" value="${wpm}">
          </label>
          <div style="flex:1;min-width:150px;text-align:right">
            <div id="sc-stats" class="hint" style="margin-top:18px">0 kata · ~0 detik</div>
            <div id="sc-save" class="hint" style="color:var(--silver-3)">Belum tersimpan</div>
            <div id="sc-draft" class="hint" style="min-height:16px;color:var(--gold-2)"></div>
          </div>
        </div>
        <div class="form-err" id="script-err"></div>
        <div class="modal-foot" style="padding:12px 0 0">
          <button class="btn btn-ghost" type="button" id="sc-close">Tutup</button>
          <button class="btn btn-purple" type="submit">${I.check} Simpan</button>
          <button class="btn btn-gold" type="button" id="sc-open">${I.prompter} Teleprompter</button>
        </div>
      </form>`,
      onMount(root, close) {
        const form = root.querySelector('#script-form');
        const ta = root.querySelector('#content-ta');
        const stats = root.querySelector('#sc-stats');
        const saveHint = root.querySelector('#sc-save');
        const errEl = root.querySelector('#script-err');
        let savedId = isNew ? null : script.id;
        let lastSaved = isNew ? null : { title: script.title, content: script.content, wpm: script.words_per_minute };
        let dirty = false;
        const draftKey = isNew ? 'new:' + project.id : 'edit:' + script.id;
        // Draf lokal: tiap ketikan dicadangkan ke perangkat (debounce 400 ms).
        // Draf hanya dibersihkan setelah simpan BERHASIL ke server — apa pun yang
        // terjadi (sinyal putus, aplikasi tertutup, HP mati di tengah mengetik),
        // ketikan terakhir dipulihkan otomatis saat editor dibuka lagi.
        const draftEl = root.querySelector('#sc-draft');
        const saveDraftNow = debounce(() => {
          Off.saveDraft(draftKey, {
            title: form.title.value.trim(),
            content: ta.value,
            wpm: Number(form.words_per_minute.value) || 140,
          });
        }, 400);
        const draft = Off.loadDraft(draftKey);
        if (draft) {
          form.title.value = draft.title || '';
          ta.value = draft.content || '';
          if (draft.wpm) form.words_per_minute.value = draft.wpm;
          draftEl.textContent = 'Draf lokal dipulihkan — ' + new Date(draft.ts).toLocaleString('id-ID');
          dirty = true;
        }
        // Antrean simpan: autosave + Simpan + Teleprompter tidak pernah berjalan paralel,
        // dan setelah simpan pertama (POST) semua simpan berikutnya jadi PUT — mencegah naskah ganda.
        let saveChain = Promise.resolve();

        // Hitung kata di-debounce: regex atas naskah 100 ribu karakter di setiap
        // ketikan membuat editor tersendat — cukup per jeda mengetik (350 ms).
        const updateStats = debounce(() => {
          const w = wordCount(ta.value);
          const wpmv = Number(form.words_per_minute.value) || 140;
          stats.textContent = `${w} kata · ~${estMinutes(w, wpmv)}`;
        }, 350);
        updateStats.flush();
        ta.addEventListener('input', () => {
          dirty = true;
          updateStats();
          saveHint.textContent = 'Perubahan belum tersimpan…';
          saveHint.style.color = 'var(--warn)';
          saveDraftNow();
          autosave();
        });
        form.title.addEventListener('input', () => {
          saveDraftNow();
        });
        form.words_per_minute.addEventListener('input', () => {
          updateStats();
          saveDraftNow();
          if (!isNew) {
            dirty = true;
            autosave();
          }
        });

        const doSave = () => {
          saveChain = saveChain.then(async () => {
            const title = form.title.value.trim();
            if (title.length < 2) {
              errEl.textContent = 'Judul minimal 2 karakter.';
              return null;
            }
            const body = {
              title,
              content: ta.value,
              words_per_minute: Number(form.words_per_minute.value) || 140,
            };
            try {
              let data;
              if (savedId) {
                data = await api('/scripts/' + savedId, { method: 'PUT', body });
              } else {
                data = await api(`/projects/${project.id}/scripts`, { method: 'POST', body });
                savedId = data.script.id;
                history.replaceState(null, '', '#/project/' + project.id);
              }
              lastSaved = { title: body.title, content: body.content, wpm: body.words_per_minute };
              dirty = false;
              Off.clearDraft(draftKey);
              Off.cacheScript(data.script);
              if (draftEl) draftEl.textContent = '';
              saveHint.textContent = 'Tersimpan ✓ ' + new Date().toLocaleTimeString('id-ID');
              saveHint.style.color = 'var(--ok)';
              return data.script;
            } catch (err) {
              if (Off.isTransientErr(err)) {
                // LURING / SERVER SIBUK (5xx, kuota D1 harian habis): simpan di
                // perangkat + antre; terkirim otomatis saat koneksi/server pulih.
                lastSaved = { title: body.title, content: body.content, wpm: body.words_per_minute };
                dirty = false;
                Off.clearDraft(draftKey);
                if (draftEl) draftEl.textContent = '';
                const hintTunggu = Off.isNetErr(err)
                  ? 'Tersimpan di perangkat ✓ — terkirim otomatis saat online'
                  : 'Tersimpan di perangkat ✓ — terkirim otomatis saat server pulih';
                if (savedId) {
                  Off.enqueue({ key: 'edit:' + savedId, method: 'PUT', path: '/scripts/' + savedId, body, ts: Date.now() });
                  Off.cacheScript({ id: savedId, project_id: project.id, ...body });
                  saveHint.textContent = hintTunggu;
                  saveHint.style.color = 'var(--ok)';
                  return { id: savedId, project_id: project.id, queued: true, srvBusy: !Off.isNetErr(err), ...body };
                }
                // Naskah BARU saat luring: menunggu POST saat online (belum ada id server).
                Off.enqueue({ key: 'new:' + project.id, method: 'POST', path: '/projects/' + project.id + '/scripts', body, ts: Date.now() });
                saveHint.textContent = hintTunggu + ' — naskah baru muncul di daftar setelah tersinkron';
                saveHint.style.color = 'var(--ok)';
                return null;
              }
              saveHint.textContent = 'Gagal menyimpan — coba lagi.';
              saveHint.style.color = 'var(--err)';
              toast(err.message, 'err', 4000);
              return null;
            }
          });
          return saveChain;
        };
        const autosave = debounce(doSave, 1300);

        form.addEventListener('submit', async (e) => {
          e.preventDefault();
          const btn = form.querySelector('button[type=submit]');
          if (btn.disabled) return; // cegah kirim ganda
          btn.disabled = true;
          const s = await doSave();
          btn.disabled = false;
          if (s) {
            close();
            toast(
              s.queued
                ? s.srvBusy
                  ? 'Tersimpan di perangkat — akan dikirim otomatis saat server pulih.'
                  : 'Tersimpan di perangkat — akan dikirim otomatis saat online.'
                : 'Naskah tersimpan.',
              s.queued ? 'info' : 'ok'
            );
            render();
          }
        });
        root.querySelector('#sc-close').addEventListener('click', async () => {
          if (dirty) await doSave();
          close();
          if (dirty || !isNew) render();
        });
        root.querySelector('#sc-open').addEventListener('click', async () => {
          const s = await doSave();
          if (!s) return;
          close();
          navigate('#/prompter/' + s.id);
        });

        // Flush saat modal ditutup paksa / halaman disembunyikan.
        // (Hanya mode web — mode perangkat menyimpan via LocalApi, bukan fetch.)
        const flush = () => {
          if (!LOCAL && dirty && savedId) {
            try {
              fetch('/api/scripts/' + savedId, {
                method: 'PUT',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ title: form.title.value.trim() || (lastSaved ? lastSaved.title : 'Naskah'), content: ta.value, words_per_minute: Number(form.words_per_minute.value) || 140 }),
                keepalive: true,
              }).catch(() => {});
            } catch {
              /* abaikan */
            }
          }
        };
        const onVis = () => {
          if (document.visibilityState === 'hidden') flush();
        };
        document.addEventListener('visibilitychange', onVis);
        currentCleanup = () => document.removeEventListener('visibilitychange', onVis);
      },
    });
  }

  // ---------- View: Admin pengguna ----------

  async function viewAdmin() {
    $app.innerHTML = `${topbarHtml('admin')}
    <main class="page container">
      <div class="page-head">
        <div class="grow">
          <h2 class="page-title">Manajemen <span class="gold">Pengguna</span></h2>
          <p class="page-sub">Super admin dapat menambahkan pengguna baru (mis. manager) untuk menginisiasi proyek.</p>
        </div>
        <button class="btn btn-gold" id="btn-add-user">${I.plus} Tambah Pengguna</button>
      </div>
      <div class="stat-strip" id="adm-stats"></div>
      <div id="users-wrap" class="table-wrap"></div>
    </main>`;
    bindLogout();
    document.getElementById('btn-add-user').addEventListener('click', () => userForm(null));

    api('/stats')
      .then((d) => {
        const s = d.stats;
        document.getElementById('adm-stats').innerHTML = `
          <div class="stat"><div class="v">${s.users}</div><div class="k">Pengguna</div></div>
          <div class="stat"><div class="v">${s.projects}</div><div class="k">Proyek</div></div>
          <div class="stat"><div class="v">${s.scripts}</div><div class="k">Naskah</div></div>
          <div class="stat"><div class="v">${s.active_sessions}</div><div class="k">Sesi Aktif</div></div>`;
      })
      .catch(() => {});

    const wrap = document.getElementById('users-wrap');
    wrap.innerHTML = '<div class="skel" style="height:180px;border-radius:12px"></div>';
    let users = [];
    try {
      const d = await api('/users');
      users = d.users || [];
    } catch (err) {
      wrap.innerHTML = `<div class="empty-state"><h3>Gagal memuat</h3><p>${esc(err.message)}</p></div>`;
      return;
    }
    if (!users.length) {
      wrap.innerHTML = '<div class="empty-state"><h3>Belum ada pengguna</h3><p>Tambahkan pengguna pertama.</p></div>';
      return;
    }
    wrap.innerHTML = `
    <table class="tbl">
      <thead><tr>
        <th>Pengguna</th><th>Peran</th><th>Status</th><th>Proyek</th><th>Login terakhir</th><th></th>
      </tr></thead>
      <tbody>
        ${users
          .map(
            (u) => `
        <tr>
          <td><div class="cell-user">
            <span class="avatar">${esc(initials(u.display_name))}</span>
            <div><b>${esc(u.display_name)}</b><div class="sub">@${esc(u.username)}${u.email ? ' · ' + esc(u.email) : ''}</div></div>
          </div></td>
          <td><span class="pill ${u.role === 'super_admin' ? 'pill-gold' : u.role === 'manager' ? 'pill-purple' : ''}">${esc(roleName(u.role))}</span></td>
          <td>${u.is_active ? '<span class="pill pill-ok">Aktif</span>' : '<span class="pill pill-err">Nonaktif</span>'}</td>
          <td>${u.projects_owned} milik / ${u.memberships} ikut</td>
          <td class="muted">${esc(fmtRel(u.last_login_at))}</td>
          <td style="white-space:nowrap">
            <button class="btn btn-ghost btn-sm" data-uid="${u.id}" title="Ubah">${I.edit}</button>
            ${u.id !== state.user.id ? `<button class="btn btn-danger btn-sm" data-uid-del="${u.id}" title="Hapus pengguna">${I.trash} Hapus</button>` : ''}
          </td>
        </tr>`
          )
          .join('')}
      </tbody>
    </table>`;
    wrap.querySelectorAll('[data-uid]').forEach((b) =>
      b.addEventListener('click', () => {
        const u = users.find((x) => String(x.id) === b.dataset.uid);
        userForm(u);
      })
    );
    wrap.querySelectorAll('[data-uid-del]').forEach((b) =>
      b.addEventListener('click', async () => {
        const u = users.find((x) => String(x.id) === b.dataset.uidDel);
        const yes = await confirmDialog('Hapus pengguna?', `Akun @${u.username} beserta proyek yang dimiliknya akan dihapus permanen.`);
        if (!yes) return;
        try {
          await api('/users/' + u.id, { method: 'DELETE' });
          toast('Pengguna dihapus.', 'ok');
          render();
        } catch (err) {
          toast(err.message, 'err');
        }
      })
    );
  }

  function userForm(user) {
    const isEdit = !!user;
    openModal({
      title: isEdit ? 'Ubah Pengguna — @' + user.username : 'Tambah Pengguna',
      bodyHtml: `
      <form id="user-form" novalidate>
        ${isEdit ? '' : `
        <label class="field">
          <span class="label-txt">Username</span>
          <input class="input" name="username" maxlength="30" autocapitalize="none" required>
        </label>`}
        <label class="field">
          <span class="label-txt">Nama tampilan</span>
          <input class="input" name="display_name" value="${esc(isEdit ? user.display_name : '')}" maxlength="60">
        </label>
        <label class="field">
          <span class="label-txt">Email (opsional)</span>
          <input class="input" name="email" type="email" value="${esc(isEdit ? user.email || '' : '')}" maxlength="120">
        </label>
        <label class="field">
          <span class="label-txt">Peran</span>
          <select class="select" name="role">
            <option value="manager" ${isEdit && user.role === 'manager' ? 'selected' : ''}>Manager — dapat membuat & mengelola proyek</option>
            <option value="member" ${isEdit && user.role === 'member' ? 'selected' : ''}>Member — presenter/penulis naskah</option>
            <option value="super_admin" ${isEdit && user.role === 'super_admin' ? 'selected' : ''}>Super Admin — akses penuh</option>
          </select>
        </label>
        <label class="field">
          <span class="label-txt">${isEdit ? 'Kata sandi baru (kosongkan jika tetap)' : 'Kata sandi'}</span>
          <input class="input" name="password" type="password" minlength="8" maxlength="128" ${isEdit ? '' : 'required'}>
        </label>
        ${isEdit ? `
        <label class="field row" style="gap:10px">
          <input type="checkbox" name="is_active" id="uf-active" ${user.is_active ? 'checked' : ''} style="width:18px;height:18px;accent-color:var(--gold-2)">
          <label for="uf-active" style="margin:0;font-size:var(--fs-sm)">Akun aktif (nonaktif = tidak bisa masuk)</label>
        </label>` : ''}
        <div class="form-err" id="user-err"></div>
        <button class="btn btn-gold btn-block" type="submit">${isEdit ? 'Simpan' : 'Tambah Pengguna'}</button>
      </form>`,
      onMount(root, close) {
        root.querySelector('#user-form').addEventListener('submit', async (e) => {
          e.preventDefault();
          const btn = e.target.querySelector('button[type=submit]');
          if (btn.disabled) return; // cegah kirim ganda
          const errEl = root.querySelector('#user-err');
          errEl.textContent = '';
          const fd = new FormData(e.target);
          const body = {};
          if (!isEdit) body.username = fd.get('username');
          body.display_name = fd.get('display_name');
          body.email = fd.get('email');
          body.role = fd.get('role');
          const pw = fd.get('password');
          if (pw) body.password = pw;
          if (isEdit) body.is_active = !!fd.get('is_active');
          btn.disabled = true;
          btn.textContent = 'Menyimpan…';
          try {
            if (isEdit) await api('/users/' + user.id, { method: 'PATCH', body });
            else await api('/users', { method: 'POST', body });
            close();
            toast(isEdit ? 'Pengguna diperbarui.' : 'Pengguna ditambahkan.', 'ok');
            render();
          } catch (err) {
            errEl.textContent = err.message;
            btn.disabled = false;
            btn.textContent = isEdit ? 'Simpan' : 'Tambah Pengguna';
          }
        });
      },
    });
  }

  // ---------- View: Teleprompter ----------

  async function viewPrompter(scriptId) {
    if (!state.user) {
      navigate(state.needsSetup ? '#/setup' : '#/login');
      return;
    }
    $app.innerHTML = `${topbarHtml()}
    <main class="page container"><div class="skel" style="height:320px"></div></main>`;
    try {
      const d = await api('/scripts/' + scriptId);
      Off.cacheScript(d.script);
      if (!window.Prompter) throw new Error('Modul teleprompter gagal dimuat. Muat ulang halaman.');
      window.Prompter.open({
        script: d.script,
        projectName: d.project ? d.project.name : '',
        onExit: () => {
          navigate('#/project/' + d.script.project_id);
        },
      });
    } catch (err) {
      // Luring / server bermasalah: buka versi terakhir yang tersimpan di perangkat (mode Timer penuh).
      if (Off.isTransientErr(err) && window.Prompter) {
        const c = Off.cachedScript(scriptId);
        if (c) {
          const pc = Off.cachedProject(c.project_id);
          toast('Mode luring — memuat naskah versi terakhir yang tersimpan. Mode Timer berjalan penuh; mode Suara butuh koneksi.', 'info', 4200);
          window.Prompter.open({
            script: c,
            projectName: pc ? pc.project.name : '',
            onExit: () => {
              navigate('#/project/' + c.project_id);
            },
          });
          return;
        }
      }
      $app.innerHTML = `${topbarHtml()}
      <main class="page container">
        <div class="empty-state"><h3>Tidak dapat membuka teleprompter</h3><p>${esc(err.message)}</p>
        <a class="btn btn-ghost mt-3" href="#/dashboard">${I.back} Kembali</a></div>
      </main>`;
      bindLogout();
    }
  }

  // ---------- Boot ----------

  async function boot() {
    try {
      const d = await api('/auth/me');
      state.user = d.user;
      state.needsSetup = !!d.needsSetup;
      Off.cacheUser(d.user);
    } catch (e) {
      state.user = null;
      state.needsSetup = false;
      // Luring / server bermasalah: sesi terakhir yang tersimpan di perangkat tetap
      // bisa dipakai (data baca dari cache; tulisan masuk antrean sinkron).
      if (Off.isTransientErr(e)) {
        const cu = Off.cachedUser();
        if (cu) {
          state.user = cu;
          state.luring = true;
        }
      }
    }
    state.booted = true;
    if (!location.hash) location.hash = state.user ? '#/dashboard' : state.needsSetup ? '#/setup' : '#/login';
    render();
    // Antrean sinkron & pemantau online/offline hanya relevan di mode web —
    // mode perangkat tidak pernah mem-fetch (LocalApi) dan jauh lebih tenang
    // tanpa toast "Anda luring" yang menyesatkan (aplikasi memang full offline).
    if (!LOCAL) Off.init();
  }

  window.addEventListener('hashchange', () => {
    if (window.Prompter && window.Prompter.isActive()) {
      window.Prompter.exit();
    }
    render();
  });
  boot();
})();
