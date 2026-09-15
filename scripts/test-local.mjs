// test-local.mjs — uji end-to-end worker Basarang di Node dengan mock D1 (node:sqlite).
// Menjalankan fetch() worker yang sama persis dengan yang dideploy ke Cloudflare.

import { DatabaseSync } from 'node:sqlite';
import { rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import worker from '../src/index.js';

// ---------- Mock D1 (meniru API resmi: prepare().bind().first()/run()/all(), batch, exec) ----------

class MockStatement {
  constructor(db, sql) {
    this.db = db;
    this.sql = sql;
    this.params = [];
  }
  bind(...params) {
    const s = new MockStatement(this.db, this.sql);
    s.params = params;
    return s;
  }
  async _run() {
    const stmt = this.db.prepare(this.sql);
    const info = stmt.run(...this._conv(this.params));
    return { success: true, meta: { changes: info.changes, last_row_id: Number(info.lastInsertRowid) } };
  }
  async run() {
    return this._run();
  }
  async first() {
    const stmt = this.db.prepare(this.sql);
    return stmt.get(...this._conv(this.params)) || null;
  }
  async all() {
    const stmt = this.db.prepare(this.sql);
    return { results: stmt.all(...this._conv(this.params)) || [] };
  }
  _conv(params) {
    return params.map((p) => (typeof p === 'boolean' ? (p ? 1 : 0) : p));
  }
}

class MockD1 {
  constructor(path) {
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL;');
  }
  prepare(sql) {
    return new MockStatement(this.db, sql);
  }
  async batch(statements) {
    const out = [];
    this.db.exec('BEGIN');
    try {
      for (const st of statements) {
        if (!(st instanceof MockStatement)) throw new Error('batch: bukan prepared statement');
        if (/^\s*select/i.test(st.sql)) {
          // D1 mengembalikan baris hasil untuk SELECT dalam batch
          const stmt = this.db.prepare(st.sql);
          out.push({ success: true, results: stmt.all(...st._conv(st.params)) || [], meta: {} });
        } else {
          const r = await st._run();
          out.push({ ...r, results: [] });
        }
      }
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
    return out;
  }
  async exec(sql) {
    this.db.exec(sql);
  }
}

// ---------- Harness ----------

const tmp = mkdtempSync(join(tmpdir(), 'basarang-test-'));
const db = new MockD1(join(tmp, 'test.db'));
const env = { DB: db };
const ORIGIN = 'https://basarang.test';

let passed = 0;
let failed = 0;
const jars = {}; // cookie jar bernama

function jarCookies(jar) {
  return (jars[jar] || []).map(([k, v]) => `${k}=${v}`).join('; ');
}
function storeCookies(jar, res) {
  const sc = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  jars[jar] = jars[jar] || [];
  for (const c of sc) {
    const [pair] = c.split(';');
    const idx = pair.indexOf('=');
    const k = pair.slice(0, idx).trim();
    const v = pair.slice(idx + 1).trim();
    if (v === '' || Number(c.match(/Max-Age=(\d+)/)?.[1]) === 0) {
      jars[jar] = jars[jar].filter(([jk]) => jk !== k);
    } else {
      jars[jar] = jars[jar].filter(([jk]) => jk !== k);
      jars[jar].push([k, v]);
    }
  }
}

async function req(jar, method, path, { body, origin, headers = {} } = {}) {
  const h = { ...headers };
  if (jar) h['cookie'] = jarCookies(jar);
  if (origin) h['origin'] = origin;
  let payload;
  if (body !== undefined) {
    h['content-type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const r = new Request(ORIGIN + path, { method, headers: h, body: payload });
  const res = await worker.fetch(r, env);
  if (jar) storeCookies(jar, res);
  let data = null;
  let text = null;
  const ct = res.headers.get('content-type') || '';
  if (ct.startsWith('text/') || ct.includes('json') || ct.includes('svg')) {
    text = await res.text();
    try {
      data = JSON.parse(text);
    } catch {
      /* non-json */
    }
  }
  return { status: res.status, data, text, res };
}

function check(name, cond, extra = '') {
  if (cond) {
    passed++;
    console.log('  ✓ ' + name);
  } else {
    failed++;
    console.error('  ✗ ' + name + (extra ? ' — ' + extra : ''));
  }
}

// ---------- Skenario ----------

console.log('— Aset statis & kesehatan —');
{
  const r = await req(null, 'GET', '/api/health');
  check('health ok', r.status === 200 && r.data.ok === true && r.data.data.name.includes('Basarang'));
  const page = await req(null, 'GET', '/');
  const html = page.text || '';
  check('root menyajikan HTML', page.status === 200 && html.includes('Basarang') && !html.includes('UNDER MY RESPONSIBILITY'));
  check('footer lengkap', html.includes('@2026 - Made by Fajrianor') && html.includes('UIN Antasari Banjarmasin') && html.includes('Pusat Humas dan Keterbukaan Informasi'));
  const css = await req(null, 'GET', '/style.css');
  check('css tersaji', css.status === 200 && (css.text || '').includes('--gold-2'));
  const js = await req(null, 'GET', '/app.js');
  check('app.js tersaji', js.status === 200);
  // Regresi footer selalu terlihat: fixed z-600 (di atas prompter z-500),
  // semua lapisan bergeser via var --footer-h, tinggi diukur app.js.
  check(
    'footer fixed di atas semua lapisan',
    (css.text || '').includes('z-index: 600') && (css.text || '').includes('position: fixed') && (css.text || '').includes('backdrop-filter: blur(12px)')
  );
  check(
    'lapisan bergeser di atas footer (--footer-h)',
    (css.text || '').includes('--footer-h') && (css.text || '').includes('.app-root { flex: 1 0 auto; width: 100%; padding-bottom: var(--footer-h); }') && (css.text || '').includes('.p-hud-bot { bottom: var(--footer-h);') && (css.text || '').includes('padding: 38dvh 18px calc(46dvh + var(--footer-h));')
  );
  check(
    'tinggi footer diukur dinamis app.js',
    ((await js.res.text()) || '').includes('syncFooterHeight')
  );
  const al = await req(null, 'GET', '/align.js');
  check('align.js tersaji', al.status === 200);
  const pj = await req(null, 'GET', '/prompter.js');
  check('prompter.js tersaji', pj.status === 200);
  // Regresi garis panduan: .p-guide harus di LUAR .p-scroll (muncul setelah p-content,
  // sebagai saudara root) — jika di dalam wadah gulir, garis ikut tergulir bersama naskah.
  {
    const t = (await pj.res.text()) || '';
    check(
      'garis panduan di luar wadah gulir',
      t.indexOf('id="p-content"') >= 0 && t.indexOf('id="p-guide"') > t.indexOf('id="p-content"')
    );
    check('garis panduan absolut 42%', (css.text || '').includes('.p-guide') && (css.text || '').includes('top: 42%'));
    check(
      'slider HUD bawah + antisipasi suara',
      t.includes('id="p-speed"') && t.includes('voiceLead') && t.includes('displayPos') && t.includes('applySpeedControl')
    );
    check('CSS slider HUD bawah', (css.text || '').includes('.p-speed') && (css.text || '').includes('.p-speed input[type="range"]'));
    check(
      'pengaturan blok kata emas',
      t.includes('ps-wordblock') && t.includes('wordBlock') && (css.text || '').includes('.prompter.no-wordblock .p-word.cur')
    );
    check(
      'tombol HUD bawah: blok emas + ulang dari awal',
      t.includes('id="p-wordblock"') && t.includes('id="p-restart"') && t.includes('function restartFromTop') && t.includes('function toggleWordBlock') && t.includes('function syncWordBlockButtons')
    );
    check(
      'pintasan B & Home/0 terdaftar',
      t.includes("case 'b':") && t.includes("case 'Home':") && t.includes('Home ulang dari awal')
    );
    check(
      'pemilih mode gulir di HUD bawah',
      t.includes('id="p-mode"') && t.includes('data-mode="voice"') && t.includes('data-mode="timer"') && t.includes('class="seg p-mode"')
    );
    check(
      'setMode/syncModeButtons satu pintu ganti mode',
      t.includes('function setMode') && t.includes('function syncModeButtons') && t.includes("setMode(b.dataset.mode)") && t.includes("root.querySelectorAll('[data-mode]')")
    );
    check(
      'fallback peramban menyinkronkan tombol HUD',
      t.indexOf('syncModeButtons();') > t.indexOf('function startVoice') && t.indexOf('syncModeButtons();', t.indexOf('if (!supportedVoice())', t.indexOf('function startVoice'))) > 0
    );
    check('CSS pemilih mode HUD', (css.text || '').includes('.p-mode {') && (css.text || '').includes('.p-mode button') && (css.text || '').includes('.p-mode button .txt { display: none; }'));
    check(
      'pintasan T ganti mode terdaftar',
      t.includes("case 't':") && t.includes('T ganti mode gulir')
    );
    check(
      'footage tetap tampil: kamera tak dimatikan saat rekaman berhenti',
      t.includes('function stopCamera') && t.includes('function setVideoMode') && t.includes('function attachCamera') && !t.includes("elVideo.classList.add('hidden')")
    );
    check(
      'kotak footage: tombol hasil/langsung, matikan kamera, titik REC',
      t.includes('id="p-video-box"') && t.includes('id="p-video-off"') && t.includes('id="p-video-play"') && t.includes('id="p-video-dot"') && t.includes("S.videoMode === 'replay' ? 'live' : 'replay'")
    );
    check(
      'CSS footage di atas semua lapisan (z-index 21)',
      (css.text || '').includes('.p-video-box') && (css.text || '').includes('z-index: 21') && (css.text || '').includes('.p-video-dot') && (css.text || '').includes('.p-video-off')
    );
    check(
      'HUD ultra-kompak (50%): tombol 24px, play 24px, padding 2px',
      (css.text || '').includes('min-width: 24px; height: 24px;') && (css.text || '').includes('border-radius: 7px;') && (css.text || '').includes('min-width: 24px; height: 24px; border-radius: 50%') && (css.text || '').includes('padding: 2px clamp(6px, 2vw, 12px)') && (css.text || '').includes('width: clamp(40px, 7vw, 72px); height: 14px;')
    );
    check(
      'HUD ultra-kompak: offset panel 40px, target sentuh 32px, ikon 10px',
      (css.text || '').includes('bottom: calc(40px + var(--footer-h))') && (css.text || '').includes('min-width: 32px; height: 32px;') && (css.text || '').includes('min-height: 32px;') && (css.text || '').includes('.p-ctrl .icon { width: 10px; height: 10px; }')
    );
    check(
      'ponsel: kontrol satu baris (elemen sekunder disembunyikan)',
      (css.text || '').includes('.p-hud-bot .p-time, .p-hud-bot .p-pct') && (css.text || '').includes('.p-hud-bot #p-font-up') && (css.text || '').includes('.p-hud-bot #p-mirror { display: none; }')
    );
    check(
      'layar penuh: ruang footer diklaim kembali',
      (css.text || '').includes('.prompter.p-fs { --footer-h: 0px; }') && t.includes('fullscreenchange')
    );
    check(
      'auto-hide HUD bawah meluncur ke bawah (translateY 100%)',
      (css.text || '').includes('.p-hud-hidden .p-hud-bot') && (css.text || '').includes('translateY(100%)')
    );
    check(
      'rata teks: tombol siklus HUD + segmen 4 opsi panel',
      t.includes('id="p-align"') && t.includes('data-align="left"') && t.includes('data-align="center"') && t.includes('data-align="right"') && t.includes('data-align="justify"') && t.includes("align: 'left'")
    );
    check(
      'rata teks: setAlign satu pintu, siklus pintasan A, tersinkron',
      t.includes('function setAlign') && t.includes('function cycleAlign') && t.includes('function syncAlignButtons') && t.includes("case 'a':") && t.includes('elContent.style.textAlign') && (css.text || '').includes('#ps-align .txt { display: none; }')
    );
  }
  const fav = await req(null, 'GET', '/favicon.svg');
  check('favicon tersaji', fav.status === 200);
  const nf = await req(null, 'GET', '/tidak-ada');
  check('jalur asing dialihkan ke /', nf.status === 302 || nf.status === 301);
}

console.log('— Setup & autentikasi —');
{
  const me0 = await req(null, 'GET', '/api/auth/me');
  check('belum ada user → needsSetup', me0.data.data.needsSetup === true && me0.data.data.user === null);

  const bad = await req(null, 'POST', '/api/auth/setup', { body: { username: 'X', password: '123' } });
  check('validasi username ditolak', bad.status === 400);

  const setup = await req('admin', 'POST', '/api/auth/setup', {
    body: { username: 'fajrianor', display_name: 'Fajrianor', password: 'rahasia-kuat-2026' },
  });
  check('setup super admin berhasil', setup.status === 201 && setup.data.data.user.role === 'super_admin');
  check('cookie sesi terpasang', jarCookies('admin').includes('basarang_session='));

  const me1 = await req('admin', 'GET', '/api/auth/me');
  check('sesi berlaku lintas permintaan', me1.data.data.user.username === 'fajrianor');

  const setup2 = await req('other', 'POST', '/api/auth/setup', {
    body: { username: 'perampok', password: 'rahasia-kuat-2026' },
  });
  check('setup kedua ditolak', setup2.status === 403);

  const wrong = await req(null, 'POST', '/api/auth/login', { body: { username: 'fajrianor', password: 'salah-total' } });
  check('login salah ditolak', wrong.status === 401);

  const login = await req('admin2', 'POST', '/api/auth/login', {
    body: { username: 'fajrianor', password: 'rahasia-kuat-2026' },
  });
  check('login perangkat kedua berhasil (sinkron D1)', login.status === 200);
  const me2 = await req('admin2', 'GET', '/api/auth/me');
  check('perangkat kedua mengenali sesi', me2.data.data.user.username === 'fajrianor');
}

console.log('— Rate limit login —');
{
  for (let i = 0; i < 9; i++) {
    const r = await req(null, 'POST', '/api/auth/login', { body: { username: 'fajrianor', password: 'salah-' + i } });
    if (r.status !== 401) check('upaya gagal ke-' + (i + 1) + ' harusnya 401', false, 'status=' + r.status);
  }
  const blocked = await req(null, 'POST', '/api/auth/login', {
    body: { username: 'fajrianor', password: 'salah-lagi' },
  });
  check('percobaan ke-10 diblokir 429', blocked.status === 429, 'status=' + blocked.status);
  const loginOk = await req('admin3', 'POST', '/api/auth/login', {
    body: { username: 'fajrianor', password: 'rahasia-kuat-2026' },
  });
  check('kata sandi benar tetap diizinkan saat terkunci', loginOk.status === 200, 'status=' + loginOk.status);
  const wrongAfter = await req(null, 'POST', '/api/auth/login', {
    body: { username: 'fajrianor', password: 'masih-salah' },
  });
  check('upaya salah berikutnya kembali diblokir (counter direset lalu naik lagi)', wrongAfter.status === 401, 'status=' + wrongAfter.status);
}

console.log('— Manajemen pengguna (RBAC) —');
{
  const mk = await req('admin', 'POST', '/api/users', {
    body: { username: 'manager.satub', display_name: 'Manager Satu', role: 'manager', password: 'password-manager' },
  });
  check('super admin buat manager', mk.status === 201 && mk.data.data.user.role === 'manager');

  const mk2 = await req('admin', 'POST', '/api/users', {
    body: { username: 'presenter', display_name: 'Presenter A', role: 'member', password: 'password-presenter' },
  });
  check('super admin buat member', mk2.status === 201);

  const dup = await req('admin', 'POST', '/api/users', {
    body: { username: 'manager.satub', role: 'manager', password: 'password-manager' },
  });
  check('username duplikat ditolak', dup.status === 409);

  const forbidden = await req('manager', 'POST', '/api/auth/login', {
    body: { username: 'manager.satub', password: 'password-manager' },
  });
  check('login manager ok', forbidden.status === 200);

  const tryUsers = await req('manager', 'GET', '/api/users');
  check('manager dilarang akses daftar user', tryUsers.status === 403);
  const tryStats = await req('manager', 'GET', '/api/stats');
  check('manager dilarang akses stats', tryStats.status === 403);
  const adminUsers = await req('admin', 'GET', '/api/users');
  check('super admin melihat 3 user', adminUsers.data.data.users.length === 3);
}

console.log('— Proyek & naskah —');
{
  const mkp = await req('manager', 'POST', '/api/projects', {
    body: { name: 'Konten Humas 2026', description: 'Naskah video resmi humas' },
  });
  check('manager membuat proyek', mkp.status === 201);
  const pid = mkp.data.data.project.id;

  // Regresi: kirim-ganda proyek (klik dua kali / jaringan lambat) tidak boleh mendobel
  const dupProj = await req('manager', 'POST', '/api/projects', {
    body: { name: 'Konten Humas 2026', description: 'uji kirim-ganda' },
  });
  check('kirim-ganda proyek tidak mendobel (guard 15 detik)', dupProj.status === 201 && dupProj.data.data.project.id === pid, 'id=' + JSON.stringify(dupProj.data.data.project.id));

  const mks = await req('manager', 'POST', `/api/projects/${pid}/scripts`, {
    body: {
      title: 'Sambutan Rektor Dies Natalis',
      content: "Assalamu'alaikum warahmatullahi wabarakatuh.\n\nBapak Ibu yang saya hormati, selamat datang di acara dies natalis ke-59 UIN Antasari Banjarmasin.",
      words_per_minute: 130,
    },
  });
  check('manager membuat naskah', mks.status === 201);
  const sid = mks.data.data.script.id;

  // Regresi: kirim-ganda naskah (autosave vs Simpan beririsan) tidak boleh mendobel
  const dupScript = await req('manager', 'POST', `/api/projects/${pid}/scripts`, {
    body: { title: 'Sambutan Rektor Dies Natalis', content: 'uji kirim-ganda' },
  });
  check('kirim-ganda naskah tidak mendobel (guard 15 detik)', dupScript.status === 201 && dupScript.data.data.script.id === sid, 'id=' + JSON.stringify(dupScript.data.data.script.id));

  const put = await req('manager', 'PUT', `/api/scripts/${sid}`, {
    body: { content: 'Naskah revisi: Assalamualaikum Bapak Ibu sekalian.', title: 'Sambutan Rektor (revisi)' },
  });
  check('naskah bisa diedit (autosave)', put.status === 200 && put.data.data.script.title.includes('revisi'));

  const noAccessLogin = await req('presenter', 'POST', '/api/auth/login', {
    body: { username: 'presenter', password: 'password-presenter' },
  });
  check('login presenter ok', noAccessLogin.status === 200);

  const noAccess = await req('presenter', 'GET', `/api/scripts/${sid}`);
  check('non-anggota tidak bisa baca naskah', noAccess.status === 403, 'status=' + noAccess.status);

  // tambah anggota
  const addMem = await req('manager', 'POST', `/api/projects/${pid}/members`, {
    body: { username: 'presenter' },
  });
  check('tambah anggota via username', addMem.status === 201);
  const nowAccess = await req('presenter', 'GET', `/api/scripts/${sid}`);
  check('anggota kini bisa baca naskah', nowAccess.status === 200 && nowAccess.data.data.my_role === 'member');

  const projListMgr = await req('manager', 'GET', '/api/projects');
  check('proyek muncul di daftar pemilik', projListMgr.data.data.projects.length === 1 && projListMgr.data.data.projects[0].my_role === 'owner');
  const projListPrs = await req('presenter', 'GET', '/api/projects');
  check('proyek muncul di daftar anggota', projListPrs.data.data.projects.length === 1 && projListPrs.data.data.projects[0].my_role === 'member');
  const projListAdm = await req('admin', 'GET', '/api/projects');
  check('super admin melihat semua proyek', projListAdm.data.data.projects.length === 1);

  // anggota membuat naskah sendiri, edit milik sendiri ok, edit milik orang lain ditolak
  const mks2 = await req('presenter', 'POST', `/api/projects/${pid}/scripts`, {
    body: { title: 'Naskah Presenter', content: 'Halo semuanya.' },
  });
  const sid2 = mks2.data.data.script.id;
  const editOwn = await req('presenter', 'PUT', `/api/scripts/${sid2}`, { body: { content: 'Halo semuanya, revisi.' } });
  check('anggota edit naskah sendiri', editOwn.status === 200);
  const editOther = await req('presenter', 'PUT', `/api/scripts/${sid}`, { body: { content: 'perusakan' } });
  check('anggota edit naskah orang lain ditolak', editOther.status === 403);
  const delOther = await req('presenter', 'DELETE', `/api/scripts/${sid}`);
  check('anggota hapus naskah orang lain ditolak', delOther.status === 403);

  // detail proyek memuat semuanya
  const detail = await req('presenter', 'GET', `/api/projects/${pid}`);
  check('detail proyek lengkap', detail.data.data.scripts.length === 2 && detail.data.data.members.length === 1 && detail.data.data.can_manage === false);

  // pencarian pengguna
  const search = await req('manager', 'GET', '/api/users/search?q=pres');
  check('pencarian pengguna bekerja', search.status === 200 && search.data.data.users.some((u) => u.username === 'presenter'));
  const searchInj = await req('manager', 'GET', '/api/users/search?q=%25%25');
  check('injeksi LIKE aman', searchInj.status === 200);
}

console.log('— Keamanan (CSRF, XSS-stor, SQLi, sesi) —');
{
  const csrf = await req('admin', 'POST', '/api/projects', {
    body: { name: 'Proyek Jahat' },
    origin: 'https://evil.example',
  });
  check('origin asing ditolak (CSRF)', csrf.status === 403);

  const badCt = await req('admin', 'POST', '/api/projects', { body: { name: 'x' }, headers: { 'content-type': 'text/plain' } });
  check('content-type non-JSON ditolak', badCt.status === 400);

  const sqli = await req(null, 'POST', '/api/auth/login', {
    body: { username: "admin'--", password: "' OR '1'='1" },
  });
  check('injeksi SQL login aman', sqli.status === 400 || sqli.status === 401, 'status=' + sqli.status);

  const mkp = await req('manager', 'GET', '/api/projects');
  const pid = mkp.data.data.projects[0].id;
  const xss = await req('manager', 'POST', `/api/projects/${pid}/scripts`, {
    body: { title: '<script>alert(1)</script>', content: '<img src=x onerror=alert(2)> naskah' },
  });
  check('payload XSS tersimpan mentah (disanitasi di render klien)', xss.status === 201);
  const got = await req('manager', 'GET', `/api/scripts/${xss.data.data.script.id}`);
  check('payload dikembalikan sebagai data, bukan dieksekusi', got.data.data.script.title === '<script>alert(1)</script>');

  const noAuth = await req(null, 'GET', '/api/projects');
  check('tanpa sesi → 401', noAuth.status === 401);

  // manipulasi cookie token palsu
  const forged = await req('fake', 'GET', '/api/projects', { headers: { cookie: 'basarang_session=' + 'a'.repeat(64) } });
  check('token palsu ditolak', forged.status === 401);

  // logout memusnahkan sesi
  const out = await req('admin2', 'POST', '/api/auth/logout');
  check('logout ok', out.status === 200);
  const after = await req('admin2', 'GET', '/api/auth/me');
  check('sesi admin2 musnah', after.data.data.user === null);
}

console.log('— Perlindungan super admin terakhir & nonaktif —');
{
  const selfDemote = await req('admin', 'PATCH', '/api/users/1', { body: { role: 'member' } });
  check('super admin tidak bisa menurunkan diri sendiri', selfDemote.status === 400);
  const selfDelete = await req('admin', 'DELETE', '/api/users/1');
  check('super admin tidak bisa menghapus diri sendiri', selfDelete.status === 400);

  const mk2 = await req('admin', 'POST', '/api/users', {
    body: { username: 'admin.kedua', display_name: 'Admin Kedua', role: 'super_admin', password: 'password-admin2' },
  });
  check('buat super admin kedua', mk2.status === 201);
  const uid2 = mk2.data.data.user.id;

  // demote super admin lain kini diizinkan (masih ada 1 super admin aktif tersisa)
  const demote = await req('admin', 'PATCH', '/api/users/' + uid2, { body: { role: 'manager' } });
  check('demote super admin lain diizinkan', demote.status === 200, 'status=' + demote.status + ' ' + JSON.stringify(demote.data));
  const promote = await req('admin', 'PATCH', '/api/users/' + uid2, { body: { role: 'super_admin' } });
  check('promote kembali', promote.status === 200);

  const deactivate = await req('admin', 'PATCH', '/api/users/' + uid2, { body: { is_active: false } });
  check('nonaktifkan user', deactivate.status === 200);
  const loginDeact = await req('x', 'POST', '/api/auth/login', {
    body: { username: 'admin.kedua', password: 'password-admin2' },
  });
  check('user nonaktif tidak bisa login', loginDeact.status === 401);
  const reactivate = await req('admin', 'PATCH', '/api/users/' + uid2, { body: { is_active: true } });
  check('aktifkan kembali', reactivate.status === 200);
}

console.log('— Statistik & bersih-bersih —');
{
  const stats = await req('admin', 'GET', '/api/stats');
  check('stats tersedia', stats.status === 200 && stats.data.data.stats.users === 4 && stats.data.data.stats.projects === 1);

  // hak hapus proyek + kaskade naskah
  const list = await req('admin', 'GET', '/api/projects');
  const pid = list.data.data.projects.find((p) => p.name === 'Konten Humas 2026').id;
  const sidOld = (await req('admin', 'GET', '/api/projects/' + pid)).data.data.scripts[0].id;
  const del = await req('presenter', 'DELETE', `/api/projects/${pid}`);
  check('anggota biasa tidak bisa hapus proyek', del.status === 403);
  const delOk = await req('admin', 'DELETE', `/api/projects/${pid}`);
  check('super admin menghapus proyek', delOk.status === 200);
  const gone = await req('admin', 'GET', `/api/scripts/${sidOld}`);
  check('naskah ikut terhapus (kaskade)', gone.status === 404);

  // ganti kata sandi mandiri
  const badPw = await req('manager', 'POST', '/api/auth/password', {
    body: { current: 'salah', next: 'password-baru-123' },
  });
  check('ganti sandi dengan sandi lama salah → ditolak', badPw.status === 401);
  const goodPw = await req('manager', 'POST', '/api/auth/password', {
    body: { current: 'password-manager', next: 'password-manager-baru' },
  });
  check('ganti sandi mandiri berhasil', goodPw.status === 200);
  const oldLogin = await req('mgr-old', 'POST', '/api/auth/login', {
    body: { username: 'manager.satub', password: 'password-manager' },
  });
  check('sandi lama tidak berlaku', oldLogin.status === 401);
  const newLogin = await req('mgr-new', 'POST', '/api/auth/login', {
    body: { username: 'manager.satub', password: 'password-manager-baru' },
  });
  check('sandi baru bisa masuk', newLogin.status === 200);

  // kaskade saat hapus pengguna pemilik proyek
  const mkProj = await req('mgr-new', 'POST', '/api/projects', {
    body: { name: 'Proyek Sementara', description: 'akan dihapus bersama pemiliknya' },
  });
  const pidTmp = mkProj.data.data.project.id;
  const mkScr = await req('mgr-new', 'POST', `/api/projects/${pidTmp}/scripts`, {
    body: { title: 'Naskah Sementara', content: 'naskah uji' },
  });
  const sidTmp = mkScr.data.data.script.id;
  const mgrId = newLogin.data.data.user.id;
  const delUser = await req('admin', 'DELETE', '/api/users/' + mgrId);
  check('hapus pengguna pemilik proyek', delUser.status === 200);
  const orphan = await req('admin', 'GET', `/api/scripts/${sidTmp}`);
  check('naskah proyek pengguna terhapus ikut musnah (tanpa data yatim)', orphan.status === 404, 'status=' + orphan.status);

  const notFound = await req('admin', 'GET', '/api/endpoint-tak-ada');
  check('endpoint tak dikenal → 404', notFound.status === 404);
}

console.log('');
console.log(`Hasil: ${passed} lulus, ${failed} gagal`);
rmSync(tmp, { recursive: true, force: true });
if (failed > 0) process.exit(1);
