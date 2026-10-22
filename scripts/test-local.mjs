// test-local.mjs — uji end-to-end worker Basarang di Node dengan mock D1 (node:sqlite).
// Menjalankan fetch() worker yang sama persis dengan yang dideploy ke Cloudflare.

import { DatabaseSync } from 'node:sqlite';
import { rmSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import worker from '../src/index.js';
import { SCHEMA_SQL } from '../src/db.js';
import { PBKDF2_ITERATIONS } from '../src/auth.js';

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
  const jsText = (await js.res.text()) || '';
  check(
    'tinggi footer diukur dinamis app.js',
    jsText.includes('syncFooterHeight')
  );
  // Regresi UX hapus: naskah terakhir terhapus → tawarkan hapus proyek kosong;
  // empty-state memuat tombol "Hapus Proyek Ini"; tombol hapus naskah hanya untuk
  // pengelola (API 403 untuk anggota biasa — tombol tak boleh menjanjikan lain).
  {
    const a = jsText;
    check(
      'hapus naskah terakhir → tawarkan hapus proyek kosong',
      a.includes('Hapus proyek kosong ini?') && a.includes('scripts.length <= 1 && can_manage') && a.includes("'Ya, hapus proyek'")
    );
    check(
      'empty-state: tombol Hapus Proyek Ini (btn-del-proj-2)',
      a.includes('btn-del-proj-2') && a.includes('Hapus Proyek Ini') && a.includes('const deleteProject = async () =>')
    );
    check(
      'tombol hapus naskah hanya untuk pengelola (selaras API 403 anggota)',
      !a.includes('can_manage || s.created_by === state.user.id) ? `<button class="btn btn-danger')
    );
    check(
      'tombol hapus berlabel teks "Hapus" (bukan ikon-saja yang mudah terlewat)',
      a.includes('id="btn-del-proj" title="Hapus proyek ini permanen">${I.trash} Hapus</button>') && a.includes('data-del="${s.id}" title="Hapus naskah">${I.trash} Hapus</button>') && a.includes('data-uid-del="${u.id}" title="Hapus pengguna">${I.trash} Hapus</button>')
    );
    check(
      'dashboard: tombol hapus proyek langsung di kartu (pemilik/super admin)',
      a.includes('data-pdel="${p.id}"') && a.includes("wrap.querySelectorAll('[data-pdel]')") && a.includes('proj-card-wrap') && (css.text || '').includes('.proj-del { position: absolute; top: 12px; right: 12px;')
    );
    // Regresi bug fatal: klik "Ya, lanjutkan" dibaca batal karena close() memicu
    // onClose() → resolve(false) sebelum resolve(true) sempat berjalan (Promise
    // hanya menerima resolusi pertama) — semua aksi konfirmasi diam-diam batal.
    check(
      'confirmDialog: resolve dipanggil sebelum close (klik Ya benar-benar konfirmasi)',
      /resolve\(true\);\s*close\(\);/.test(a) && !/close\(\);\s*resolve\(true\);/.test(a)
    );
    // Regresi UX: suggestion text (placeholder) dihapus dari semua kolom isian —
    // label & hint permanen di bawah kolom sudah cukup; placeholder menambah ramai.
    check(
      'kolom isian bebas suggestion text (placeholder dihapus)',
      !a.includes('placeholder=') && !(css.text || '').includes('::placeholder')
    );
    // Regresi modal dobel: btn-new-script-2 pernah diikat DUA kali (empty-state
    // + newBtns) → klik "Tulis Naskah Pertama" membuka 2 modal bertumpuk; setelah
    // disimpan, modal kembar kosong tersisa & terkesan "tidak mau tertutup".
    check(
      'proyek kosong: Tulis Naskah Pertama hanya diikat sekali (newBtns)',
      a.includes("const newBtns = [document.getElementById('btn-new-script'), document.getElementById('btn-new-script-2')];") &&
        !a.includes("b2.addEventListener('click', () => scriptEditor(project, null))")
    );
  }
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
    // Regresi fade tepi: dulu hardcoded (tak bisa diubah user) — kini slider
    // "Memudar tepi" 0-100% via var --fade-op di .p-fade.
    check(
      'pengaturan memudar tepi (fade atas/bawah)',
      t.includes('ps-fade') && t.includes('edgeFade') && t.includes('--fade-op') && (css.text || '').includes('opacity: var(--fade-op')
    );
    // Regresi mode gulir: efek karaoke (kata terlewati diredupkan + blok emas)
    // HANYA mode suara — updateTimerProgress dulu memanggil highlight() tiap
    // tick sehingga kata di atas posisi proporsional "menghitam" dan mengganggu
    // pembacaan pengguna mode gulir (laporan riil 22 Okt 2026).
    {
      const fnUpdate = t.slice(t.indexOf('function updateTimerProgress'), t.indexOf('function setPlaying'));
      const fnSetMode = t.slice(t.indexOf('function setMode'), t.indexOf('function syncWordBlockButtons'));
      const fnPlay = t.slice(t.indexOf('function playOrPause'), t.indexOf('function hudWake'));
      check(
        'mode gulir tanpa redup kata terlewati (karaoke hanya mode suara)',
        t.includes('function clearWordMarks') && t.includes("if (S.mode === 'timer') {") &&
          fnUpdate.includes('curIdx = pos - 1') && !fnUpdate.includes('highlight(')
      );
      check(
        'ganti mode bersihkan/pasang penanda kata di posisi terlihat',
        t.includes('function wordAtGuide') && fnSetMode.includes('clearWordMarks()') && fnSetMode.includes('wordAtGuide()')
      );
      check(
        'mode timer lanjut main dari posisi tampilan (tidak melompat)',
        fnPlay.includes("if (S.mode === 'voice') scrollToWord")
      );
    }
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
    // Regresi pratinjau kamera "tidak terlihat": getUserMedia gagal (izin ditolak /
    // kamera dipakai aplikasi lain / tanpa mikrofon) dulu hanya banner 5 detik
    // yang mudah terlewat — kini: fallback video-saja, pesan penyebab + solusi,
    // dan tombol kamera menyala merah persisten (clearCamError saat beres).
    check(
      'kamera: fallback video-saja saat mikrofon gagal',
      t.includes('async function getCameraStream') && t.includes('audio: false') && t.includes('Mikrofon tidak tersedia')
    );
    check(
      'kamera: pesan kegagalan menjelaskan penyebab + solusi',
      t.includes('function cameraErrMsg') && t.includes('bilah alamat') && t.includes('kamera sedang dipakai aplikasi lain') && t.includes('kamera tidak ditemukan')
    );
    check(
      'kamera: status error persisten di tombol (merah) + banner 8 dtk',
      t.includes('function setCamError') && t.includes('function clearCamError') && t.includes("classList.add('err')") && t.includes(', 8000)') && (css.text || '').includes('.p-ctrl.err')
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
    // Regresi UX: panel pengaturan kini punya tombol Tutup eksplisit di header
    // (sebelumnya hanya pintasan S / tombol gear HUD — kurang terlihat).
    check(
      'panel pengaturan: tombol Tutup (ps-close) di header panel',
      t.includes('id="ps-close"') && t.includes('ICON.close') && t.includes("querySelector('#ps-close')") && (css.text || '').includes('.p-set-head')
    );
    // Regresi skala & stabilitas (audit ratusan naskah):
    check(
      'prompter: delegasi klik kata — satu listener, bukan per kata',
      t.includes("elContent.addEventListener('click'") && t.includes('span.dataset.i') && !t.includes('w.el.addEventListener(\'click\')')
    );
    check(
      'editor: hitung kata di-debounce (naskah panjang tetap responsif)',
      jsText.includes('const updateStats = debounce(') && jsText.includes('updateStats.flush()')
    );
    check(
      'frontend: kartu pakai word_count server & editor fetch on-demand',
      jsText.includes('Number(s.word_count) || 0') && jsText.includes("api('/scripts/' + s.id)") && jsText.includes('scriptEditor(project, full)')
    );
    check(
      'skema & auth: kolom word_count + PBKDF2 di bawah batas CPU ganti sandi',
      SCHEMA_SQL.includes('word_count INTEGER') && PBKDF2_ITERATIONS <= 16000 && PBKDF2_ITERATIONS >= 10000
    );
  }
  const fav = await req(null, 'GET', '/favicon.svg');
  check('favicon tersaji', fav.status === 200);
  const nf = await req(null, 'GET', '/tidak-ada');
  check('jalur asing dialihkan ke /', nf.status === 302 || nf.status === 301);
}

console.log('— Mode luring (offline) —');
{
  const sw = await req(null, 'GET', '/sw.js');
  const swText = (await sw.res.text()) || '';
  check(
    'sw.js tersaji sebagai service worker (shell cache)',
    sw.status === 200 && (sw.res.headers.get('content-type') || '').includes('javascript') && swText.includes('basarang-shell') && swText.includes("addEventListener('fetch'")
  );
  const page2 = await req(null, 'GET', '/');
  const html2 = page2.text || '';
  check('index.html mendaftarkan service worker (aktif saat https/localhost)', html2.includes('serviceWorker') && html2.includes('/sw.js'));
  const js2 = await req(null, 'GET', '/app.js');
  const a = (await js2.res.text()) || '';
  const css2 = await req(null, 'GET', '/style.css');
  const c2 = css2.text || '';
  check(
    'app.js: modul luring (draf lokal + antrean sinkron + cache naskah)',
    a.includes('bsng.queue') && a.includes('Off.enqueue') && a.includes('async drain()') && a.includes('setInterval') && a.includes('bsng.draft.') && a.includes('bsng.script.')
  );
  check(
    'app.js: simpan saat luring → "Tersimpan di perangkat"',
    a.includes('Tersimpan di perangkat ✓') && a.includes('terkirim otomatis saat online')
  );
  check('app.js: pulihkan draf lokal saat editor dibuka lagi', a.includes('Draf lokal dipulihkan'));
  check('app.js: teleprompter luring memuat cache perangkat', a.includes('Mode luring — memuat naskah versi terakhir'));
  check('app.js: keluar menghapus semua data luring di perangkat', a.includes('Off.clearAll()'));
  check('css: banner luring & pil status topbar', c2.includes('.off-note') && c2.includes('.pill-warn'));
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

  // Regresi skala ratusan naskah: daftar proyek & respons simpan = metadata-saja
  // (tanpa kolom content — dulu puluhan MB JSON per buka halaman); jumlah kata
  // disimpan server-side di kolom word_count.
  check(
    'respons simpan naskah metadata-saja + word_count',
    put.status === 200 && put.data.data.script.content === undefined && put.data.data.script.word_count === 6
  );
  const putTitle = await req('manager', 'PUT', `/api/scripts/${sid}`, { body: { title: 'Sambutan Rektor (revisi 2)' } });
  check(
    'word_count tidak dihitung ulang saat isi tak berubah (hemat CPU isolate)',
    putTitle.status === 200 && putTitle.data.data.script.word_count === 6
  );
  const detailMgr = await req('manager', 'GET', `/api/projects/${pid}`);
  const sMeta = (detailMgr.data.data.scripts || []).find((x) => x.id === sid);
  check(
    'daftar naskah proyek metadata-saja (content tidak dikirim)',
    !!sMeta && sMeta.content === undefined && sMeta.title.includes('revisi 2') && sMeta.word_count === 6
  );
  const single = await req('manager', 'GET', `/api/scripts/${sid}`);
  check(
    'GET naskah tunggal tetap menyertakan isi (editor & teleprompter on-demand)',
    single.status === 200 && single.data.data.script.content.includes('Assalamualaikum') && single.data.data.script.word_count === 6
  );

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

  // Semantika hapus: naskah vs proyek — hapus naskah TIDAK menghapus proyeknya
  // (proyek = wadah banyak naskah); hapus proyek memusnahkan seluruh naskahnya.
  const mkProjSem = await req('admin', 'POST', '/api/projects', {
    body: { name: 'Proyek Semantik Hapus', description: 'uji naskah vs proyek' },
  });
  const pidSem = mkProjSem.data.data.project.id;
  const mkScrSem = await req('admin', 'POST', `/api/projects/${pidSem}/scripts`, {
    body: { title: 'Naskah Uji Hapus', content: 'isi naskah uji hapus' },
  });
  const sidSem = mkScrSem.data.data.script.id;
  const delScrSem = await req('admin', 'DELETE', '/api/scripts/' + sidSem);
  check('hapus naskah sukses', delScrSem.status === 200);
  const projAfter = await req('admin', 'GET', '/api/projects/' + pidSem);
  check(
    'proyek tetap ada setelah naskah terakhirnya dihapus (naskah bukan proyek)',
    projAfter.status === 200 && (projAfter.data.data.scripts || []).length === 0
  );
  const delProjSem = await req('admin', 'DELETE', '/api/projects/' + pidSem);
  check('hapus proyek sukses', delProjSem.status === 200);
  const projGone = await req('admin', 'GET', '/api/projects/' + pidSem);
  check('proyek benar-benar terhapus setelah DELETE proyek', projGone.status === 404);

  const notFound = await req('admin', 'GET', '/api/endpoint-tak-ada');
  check('endpoint tak dikenal → 404', notFound.status === 404);
}

console.log('— Kuota tulis D1 habis (insiden nyata 21 Okt 2026): 503 jelas, baca tetap hidup —');
{
  // Aplikasi lain di akun Cloudflare yang sama membakar kuota tulis harian D1
  // (100 rb baris/hari, level AKUN) → SEMUA tulisan gagal, termasuk pembuatan
  // sesi login. Basarang harus menjawab 503 db_write_limited dengan pesan pulih
  // yang jelas (bukan 500 samar) agar klien mengantre & mencoba ulang otomatis.
  const QUOTA_MSG =
    "Failed to execute 'run' on 'D1PreparedStatement': Your account has exceeded D1's free tier daily row write limit. Upgrade to a paid plan or wait until tomorrow (midnight UTC) to continue.";
  const quotaStub = {
    bind() {
      return this;
    },
    async run() {
      throw new Error(QUOTA_MSG);
    },
    async first() {
      throw new Error(QUOTA_MSG);
    },
    async all() {
      throw new Error(QUOTA_MSG);
    },
  };
  const quotaDb = {
    prepare(sql) {
      return /^\s*(select|pragma|explain)\b/i.test(sql) ? db.prepare(sql) : quotaStub;
    },
    async batch() {
      throw new Error(QUOTA_MSG);
    },
    async exec(sql) {
      return db.exec(sql);
    },
  };
  const qEnv = { DB: quotaDb };

  // Login kredensial BENAR saat kuota habis: sesi tak bisa dibuat → 503
  // (pesan menjelaskan pemulihan, bukan menyalahkan kata sandi pengguna).
  const r1 = await worker.fetch(
    new Request(ORIGIN + '/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'fajrianor', password: 'rahasia-kuat-2026' }),
    }),
    qEnv
  );
  const d1 = await r1.json();
  check('kuota habis: login ditolak 503 (bukan 500 samar)', r1.status === 503, 'status=' + r1.status);
  check(
    'kuota habis: kode db_write_limited + pesan pulih 07.00 WIB',
    d1.error === 'db_write_limited' && /07\.00\s*WIB/.test(d1.message || ''),
    d1.message || ''
  );
  check('kuota habis: header Retry-After terpasang', Number(r1.headers.get('retry-after') || 0) >= 60);

  // Endpoint baca tetap hidup — degradasi HANYA pada tulisan.
  const r2 = await worker.fetch(new Request(ORIGIN + '/api/projects', { headers: { cookie: jarCookies('admin') } }), qEnv);
  check('kuota habis: endpoint baca tetap 200 (degradasi hanya tulis)', r2.status === 200, 'status=' + r2.status);

  // Klien produksi memperlakukan 503/5xx sebagai gangguan sementara: antrean
  // sinkron TIDAK dibuang — draf & antrean menunggu server pulih.
  // (Catatan: helper req tak mengisi .text untuk aset JS — baca res.text() langsung.)
  const jsQ = await req(null, 'GET', '/app.js');
  const a = (await jsQ.res.text()) || '';
  check(
    'app.js: isTransientErr menganggap 5xx/429/db_write_limited sementara',
    a.includes('isTransientErr') &&
      a.includes("e.status === 429 || e.status >= 500 || e.code === 'db_write_limited' || e.code === 'rate_limited'") &&
      a.includes('if (this.isTransientErr(err)) break;')
  );
  check('app.js: doSave mengantre saat server sibuk (hint "server pulih")', a.includes('terkirim otomatis saat server pulih'));
}

console.log('— Aplikasi Android (APK full offline): marker, token Bearer, CORS —');
{
  // ---- Marker statis: mode perangkat (LocalApi) di app.js & index.html ----
  const jsQ = await req(null, 'GET', '/app.js');
  const a = (await jsQ.res.text()) || '';
  const htmlQ = await req(null, 'GET', '/');
  const html = htmlQ.text || '';

  check(
    'app.js: mode perangkat aktif di origin APK + escape pengujian localhost',
    a.includes("location.hostname === 'app.basarang.local'") && a.includes("new URLSearchParams(location.search).get('lokal') === '1'")
  );
  check(
    'app.js: api() mode perangkat dilayani LocalApi (tanpa fetch/jaringan)',
    a.includes('if (LOCAL) {') && a.includes("return LocalApi.call(opts.method || 'GET', path, opts.body);")
  );
  check(
    'app.js: LocalApi menyediakan setup/login/logout/password perangkat',
    a.includes("path === '/auth/setup'") && a.includes("path === '/auth/login'") && a.includes("path === '/auth/logout'") && a.includes("path === '/auth/password'")
  );
  check(
    'app.js: akun perangkat di namespace basarang.local.* (clearAll logout hanya menyentuh bsng.*)',
    a.includes("localStorage.getItem('basarang.local.' + k)") && a.includes("LS.keys('bsng.')")
  );
  check(
    'app.js: IndexedDB perangkat — store projects/scripts/members',
    a.includes("indexedDB.open('basarang-local', 1)") && a.includes("createObjectStore('projects'") && a.includes("createObjectStore('scripts'") && a.includes("createObjectStore('members'")
  );
  check(
    'app.js: PBKDF2 lokal 15 rb iterasi — format hash identik server',
    a.includes("'pbkdf2:15000:'") && a.includes("['deriveBits']")
  );
  check(
    'app.js: topbar mode perangkat — pil "Perangkat" + tombol Sinkron opsional',
    a.includes('id="btn-sync"') && a.includes('>Perangkat</span>')
  );
  check('app.js: login perangkat tanpa internet (hint tak menyesatkan)', a.includes('Mode perangkat — masuk tanpa internet'));
  check(
    'app.js: Off.init & flush jaringan hanya dijalankan mode web',
    a.includes('if (!LOCAL) Off.init();') && a.includes('if (!LOCAL && dirty && savedId)')
  );
  check(
    'app.js: sinkronisasi opsional dua arah + fallback origin lokal utk pengujian',
    a.includes('Unduh dari Server') && a.includes('Unggah ke Server') && a.includes("if (location.hostname === 'localhost' || location.hostname === '127.0.0.1') return location.origin;")
  );
  check(
    'index.html: service worker TIDAK didaftarkan di origin APK (aset sudah lokal)',
    html.includes("location.hostname !== 'app.basarang.local'")
  );

  // ---- Sistem lisensi ARAY (APK v1.3.0): gerbang + tanpa login ----
  const licQ = await req(null, 'GET', '/license.js');
  const lic = (licQ.res && (await licQ.res.text())) || '';
  check(
    'license.js: disajikan worker — port ARAY (kode aktivasi + HMAC + grace)',
    lic.includes('BASARANG-2026-HUMAS-UIN-ANTASARI-BANJARMASIN') &&
      lic.includes('generateFor') && lic.includes('EVENT_GRACE_HOURS') && lic.includes('crypto.subtle')
  );
  check(
    'index.html: license.js dimuat SEBELUM app.js (defer berurutan)',
    /license\.js[^]*?app\.js/.test(html) && html.includes('<script src="/license.js" defer></script>')
  );
  check(
    'app.js: gerbang lisensi mode perangkat — rute #/lisensi + viewLicense',
    a.includes("page === 'lisensi'") && a.includes('viewLicense(false)') && a.includes('viewLicense(true)') && a.includes("location.hash = '#/lisensi'")
  );
  check(
    'app.js: boot mode perangkat cek lisensi DULU + akun otomatis (tanpa form)',
    a.includes('state.license = await Lic().status();') && a.includes('await ensureLocalAccount();') && a.includes("display_name: 'Pengguna Basarang'")
  );
  check(
    'app.js: topbar mode perangkat — tombol Lisensi, TANPA tombol Keluar/Sandi',
    a.includes('id="btn-license"') && a.includes("${LOCAL ? '' : '<button class=\"btn btn-ghost btn-sm\" id=\"btn-logout\"") && a.includes("${LOCAL ? '' : '<button class=\"btn btn-ghost btn-sm\" id=\"btn-pass\"")
  );
  check(
    'app.js: gerbang menampilkan Machine ID + Mode Pengembang (port LicenseGate ARAY)',
    a.includes('id="lic-machine-id"') && a.includes('id="lic-dev-toggle"') && a.includes('id="lic-dev-go"') && a.includes('Salin Machine ID')
  );
  const swQ = await req(null, 'GET', '/sw.js');
  const swTxt = (swQ.res && (await swQ.res.text())) || '';
  check(
    'sw.js: license.js masuk shell cache + versi dinaikkan (v1.3.0)',
    swTxt.includes("'/license.js'") && swTxt.includes("'v1.3.0'")
  );
  const ROOT = '.';
  const genSrc = readFileSync(join(ROOT, 'tools/generate-license.mjs'), 'utf8');
  check(
    'tools/generate-license.mjs: secret sama + format kode sama (kode saling berlaku)',
    genSrc.includes('BASARANG-2026-HUMAS-UIN-ANTASARI-BANJARMASIN') &&
      genSrc.includes('code.slice(0, 4)}-${code.slice(4, 8)}-${code.slice(8, 12)}-${code.slice(12, 16)}') &&
      lic.includes("code.slice(0, 4) + '-' + code.slice(4, 8) + '-' + code.slice(8, 12) + '-' + code.slice(12, 16)")
  );
  const mainJava = readFileSync(join(ROOT, 'android/src/com/synclicen/basarang/MainActivity.java'), 'utf8');
  check(
    'MainActivity.java: jembatan NativeDevice (ANDROID_ID) utk Machine ID stabil',
    mainJava.includes('"NativeDevice"') && mainJava.includes('Settings.Secure.ANDROID_ID')
  );

  // ---- Perilaku server untuk APK: login lintas origin + Bearer + CORS ----
  const lg = await req(null, 'POST', '/api/auth/login', {
    body: { username: 'fajrianor', password: 'rahasia-kuat-2026' },
    origin: 'https://app.basarang.local',
  });
  const token = (lg.data && lg.data.data && lg.data.data.token) || '';
  check('APK: login lintas origin (Origin APK) diterima — guard CSRF dilewati utk APK', lg.status === 200 && !!(lg.data.data.user));
  check('APK: respons login menyertakan token sesi (klien non-cookie)', /^[0-9a-f]{64}$/.test(token));
  check(
    'APK: respons login ber-header CORS utk origin APK',
    (lg.res.headers.get('access-control-allow-origin') || '') === 'https://app.basarang.local'
  );

  const bp = await req(null, 'GET', '/api/projects', { headers: { authorization: 'Bearer ' + token } });
  check('APK: Bearer token menggantikan cookie (GET /projects 200)', bp.status === 200 && Array.isArray(bp.data.data.projects));
  const badTok = await req(null, 'GET', '/api/projects', { headers: { authorization: 'Bearer ' + 'f'.repeat(64) } });
  check('APK: Bearer token palsu ditolak 401', badTok.status === 401, 'status=' + badTok.status);
  const bs = await req(null, 'POST', '/api/projects', {
    body: { name: 'Proyek via Bearer' },
    headers: { authorization: 'Bearer ' + token },
  });
  check('APK: tulis via Bearer token berhasil (POST /projects 201)', bs.status === 201 && !!bs.data.data.project, 'status=' + bs.status);

  const pre = await worker.fetch(
    new Request(ORIGIN + '/api/auth/login', {
      method: 'OPTIONS',
      headers: {
        origin: 'https://app.basarang.local',
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'content-type, authorization',
      },
    }),
    env
  );
  check(
    'APK: preflight CORS dijawab (204 + allow-origin + metode)',
    pre.status === 204 && pre.headers.get('access-control-allow-origin') === 'https://app.basarang.local' && (pre.headers.get('access-control-allow-methods') || '').includes('POST')
  );
  const pre2 = await worker.fetch(
    new Request(ORIGIN + '/api/auth/login', {
      method: 'OPTIONS',
      headers: { origin: 'https://jahat.example', 'access-control-request-method': 'POST' },
    }),
    env
  );
  check('APK: preflight origin asing TIDAK mendapat allow-origin', pre2.status === 204 && !pre2.headers.get('access-control-allow-origin'));

  const lgw = await req('webtoko', 'POST', '/api/auth/login', { body: { username: 'fajrianor', password: 'rahasia-kuat-2026' } });
  check('web: login biasa tetap menyertakan token (kompatibel; klien cookie mengabaikannya)', lgw.status === 200 && /^[0-9a-f]{64}$/.test(((lgw.data || {}).data || {}).token || ''));
}

console.log('');
console.log(`Hasil: ${passed} lulus, ${failed} gagal`);
rmSync(tmp, { recursive: true, force: true });
if (failed > 0) process.exit(1);
