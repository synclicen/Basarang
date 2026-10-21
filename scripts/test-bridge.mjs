// test-bridge.mjs — Uji e2e jembatan NativeSpeech (APK Android) terhadap
// prompter.js PRODUKSI yang berjalan penuh di Chromium headless.
//
// Memverifikasi kontrak yang dijamin android/assets/speech_shim.js + MainActivity:
//   1. Mode Suara: prompter memanggil start('id-ID'), status "Mendengarkan…"
//   2. Hasil interim & final menggerakkan blok emas, guliran, dan persentase
//   3. Sesi restart otomatis setelah tiap 'end' (kontinuitas antar-ujaran —
//      inilah yang membuat teks TIDAK berhenti di tengah)
//   4. Exit prompter → stop() dipanggil (mikrofon dilepas)
//   5. keepAwake(true) saat prompter terbuka, false setelah keluar
//   6. Mode Timer tetap normal (regresi)
//
// Jalankan: node scripts/test-bridge.mjs
// (butuh modul playwright global + worker + mock D1 — tanpa jaringan luar)

import { DatabaseSync } from 'node:sqlite';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import worker from '../src/index.js';
import { chromium } from 'playwright';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const PORT = 8799;
const BASE = `http://127.0.0.1:${PORT}`;
const SHIM_SRC = readFileSync(join(ROOT, 'android/assets/speech_shim.js'), 'utf8');

// ---------- Mock D1 (identik scripts/test-local.mjs) ----------

class MockStatement {
  constructor(db, sql) {
    this.db = db; this.sql = sql; this.params = [];
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
  async run() { return this._run(); }
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
  prepare(sql) { return new MockStatement(this.db, sql); }
  async batch(statements) {
    const out = [];
    this.db.exec('BEGIN');
    try {
      for (const st of statements) {
        if (!(st instanceof MockStatement)) throw new Error('batch: bukan prepared statement');
        if (/^\s*select/i.test(st.sql)) {
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
  async exec(sql) { this.db.exec(sql); }
}

// ---------- Skenario ----------

const SENTENCES = [
  'Assalamualaikum warahmatullahi wabarakatuh.',
  'Bapak dan Ibu yang saya hormati, selamat datang di Pusat Humas dan Keterbukaan Informasi UIN Antasari Banjarmasin.',
  'Hari ini kita merilis aplikasi teleprompter Basarang untuk mendukung produksi konten kampus.',
  'Aplikasi ini memungkinkan naskah mengikuti suara pembicara secara otomatis tanpa batas karakter.',
  'Tim humas dapat mengelola ratusan naskah dalam berbagai proyek dengan mudah dan cepat.',
  'Mari kita mulai babak baru kreativitas konten digital kampus bersama Basarang.',
  'Wassalamualaikum warahmatullahi wabarakatuh.',
];

let passed = 0, failed = 0;
const check = (name, cond, extra = '') => {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.error('  ✗ ' + name + (extra ? ' — ' + extra : '')); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- Seed data lewat API worker (sama dengan produksi) ----------

const tmp = mkdtempSync(join(tmpdir(), 'basarang-bridge-'));
const env = { DB: new MockD1(join(tmp, 't.db')) };

async function api(method, path, body, cookie) {
  const r = await worker.fetch(new Request(BASE + path, {
    method,
    headers: { ...(cookie ? { cookie } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  }), env);
  const sc = r.headers.getSetCookie ? r.headers.getSetCookie() : [];
  const data = await r.json().catch(() => null);
  return { status: r.status, data, cookie: sc.map((c) => c.split(';')[0]).join('; ') || cookie };
}

console.log('— Seed —');
{
  const s = await api('POST', '/api/auth/setup', { username: 'fajrianor', display_name: 'Fajrianor', password: 'rahasia-kuat-2026' });
  const cookie = s.cookie;
  const p = await api('POST', '/api/projects', { name: 'Uji APK', description: 'uji bridge' }, cookie);
  const pid = p.data?.data?.project?.id;
  const sc = await api('POST', `/api/projects/${pid}/scripts`, { title: 'Naskah Uji Bridge', content: SENTENCES.join(' ') }, cookie);
  globalThis.__SID = sc.data?.data?.script?.id;
  globalThis.__COOKIE = cookie;
  check('seed setup+proyek+naskah', s.status < 400 && !!pid && !!globalThis.__SID, `sid=${globalThis.__SID}`);
}

// ---------- Server HTTP pembungkus worker (HTML+API asli) ----------

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, BASE);
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const hasBody = chunks.length > 0 && !['GET', 'HEAD'].includes(req.method);
    const r = await worker.fetch(new Request(url, {
      method: req.method,
      headers: req.headers,
      body: hasBody ? Buffer.concat(chunks) : undefined,
    }), env);
    const raw = [];
    for (const [k, v] of r.headers) raw.push(k, v);
    res.writeHead(r.status, raw);
    res.end(Buffer.from(await r.arrayBuffer()));
  } catch (e) {
    res.writeHead(500); res.end(String(e && e.stack || e));
  }
});
await new Promise((r) => server.listen(PORT, '127.0.0.1', r));

// ---------- Browser ----------

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const page = await context.newPage();
page.on('pageerror', (e) => console.error('  [pageerror]', e.message));

const $eval = (fn, arg) => page.evaluate(fn, arg);

console.log('— Login & buka prompter —');
await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
await page.waitForSelector('#login-form input[name=username]', { timeout: 15000 });
await page.fill('#login-form input[name=username]', 'fajrianor');
await page.fill('#login-form input[name=password]', 'rahasia-kuat-2026');
await page.click('#login-form button[type=submit]');
await page.waitForFunction(() => location.hash === '#/dashboard', null, { timeout: 15000 });
check('login via UI sampai dashboard', true);

// pengaturan prompter: mode suara (default) + huruf besar agar konten meluap
await page.evaluate(() => localStorage.setItem('basarang.prompter', JSON.stringify({ mode: 'voice', fontSize: 1.6 })));
await page.evaluate((sid) => { location.hash = '#/prompter/' + sid; }, globalThis.__SID);
await page.waitForSelector('#p-play', { timeout: 15000 });
check('prompter terbuka', true);

// suntik mock NativeSpeech + SHIM ASLI dari APK
await page.evaluate(() => {
  window.NativeSpeech = {
    available: () => true,
    start: (l) => { window.__nsLang = l; window.__nsStarted = (window.__nsStarted || 0) + 1; },
    stop: () => { window.__nsStopped = (window.__nsStopped || 0) + 1; },
    keepAwake: (b) => { window.__awake = b; },
  };
});
await page.evaluate(SHIM_SRC);
const shimInstalled = await page.evaluate(() => typeof window.SpeechRecognition === 'function');
check('shim APK memasang SpeechRecognition di halaman produksi', shimInstalled);

const scroll0 = await $eval(() => document.getElementById('p-scroll').scrollTop);
await page.evaluate(() => document.getElementById('p-play').click());
await sleep(4300); // hitung mundur 3-2-1-Mulai

console.log('— Mode Suara via bridge —');
{
  const st = await page.evaluate(() => ({ started: window.__nsStarted || 0, lang: window.__nsLang, awake: window.__awake }));
  check('prompter memanggil start() bridge', st.started >= 1, JSON.stringify(st));
  check('lang diteruskan: id-ID', st.lang === 'id-ID');
  check('keepAwake(true) saat prompter aktif', st.awake === true);
  const statusTxt = await $eval(() => document.getElementById('p-status-txt').textContent);
  check('status "Mendengarkan…"', statusTxt.includes('Mendengarkan'), statusTxt);
}

console.log('— Suara mengalir: interim → final → end (7 ujaran) —');
{
  let pctAfter2 = 0;
  for (let i = 0; i < SENTENCES.length; i++) {
    const s = SENTENCES[i];
    await page.evaluate((t) => window.__basarangCb({ type: 'result', text: t, isFinal: false }), s);
    await sleep(90);
    await page.evaluate((t) => window.__basarangCb({ type: 'result', text: t, isFinal: true }), s);
    await sleep(90);
    await page.evaluate(() => window.__basarangCb({ type: 'end' }));
    await sleep(560); // prompter restart sesi 300 ms kemudian
    if (i === 1) pctAfter2 = await $eval(() => parseInt(document.getElementById('p-pct').textContent, 10) || 0);
  }
  const mid = await page.evaluate(() => ({
    pct: parseInt(document.getElementById('p-pct').textContent, 10) || 0,
    scrollTop: document.getElementById('p-scroll').scrollTop,
    cur: !!document.querySelector('.p-word.cur'),
    restarts: window.__nsStarted || 0,
  }));
  check('teks BERGERAK sejak awal (pct naik setelah 2 ujaran)', pctAfter2 > 0, 'pct=' + pctAfter2);
  check('sesi direstart tiap ujaran (kontinuitas, tidak berhenti)', mid.restarts >= SENTENCES.length, 'restarts=' + mid.restarts);
  check('blok emas aktif (.p-word.cur)', mid.cur);
  check('guliran maju', mid.scrollTop > scroll0, `scrollTop ${scroll0} → ${mid.scrollTop}`);
  check('persentase akhir tinggi (>=90%)', mid.pct >= 90, 'pct=' + mid.pct);
}

console.log('— Keluar prompter —');
{
  await page.evaluate(() => document.getElementById('p-exit').click());
  await sleep(600);
  const out = await page.evaluate(() => ({
    stopped: window.__nsStopped || 0,
    awake: window.__awake,
    prompterGone: !document.getElementById('p-play'),
  }));
  check('exit → stop() bridge (mikrofon dilepas)', out.stopped >= 1);
  check('exit → keepAwake(false)', out.awake === false);
  check('prompter ditutup dari DOM', out.prompterGone);
}

console.log('— Regresi: mode Timer tanpa suara —');
{
  await page.evaluate(() => localStorage.setItem('basarang.prompter', JSON.stringify({ mode: 'timer', fontSize: 1.6, wpm: 200, speed: 2 })));
  await page.evaluate((sid) => { location.hash = '#/prompter/' + sid; }, globalThis.__SID);
  await page.waitForSelector('#p-play', { timeout: 15000 });
  // pastikan mock & shim masih terpasang (konteks halaman sama, SPA)
  const shimOk = await page.evaluate(() => typeof window.SpeechRecognition === 'function' && !!window.NativeSpeech);
  check('shim tetap terpasang di sesi kedua (SPA)', shimOk);
  const s0 = await $eval(() => document.getElementById('p-scroll').scrollTop);
  await page.evaluate(() => document.getElementById('p-play').click());
  await sleep(4600); // hitung mundur 3-2-1-Mulai + gulir
  const s1 = await $eval(() => document.getElementById('p-scroll').scrollTop);
  check('mode Timer menggulir sendiri', s1 > s0, `${s0} → ${s1}`);
  await page.evaluate(() => document.getElementById('p-exit').click());
  await sleep(300);
}

console.log('— Mode luring: offline penuh di Chromium —');
{
  // Online dulu: buka halaman proyek agar ikut tersimpan di perangkat.
  await page.evaluate(() => { location.hash = '#/dashboard'; });
  await page.waitForSelector('#dash-projects .proj-card', { timeout: 15000 });
  await page.click('#dash-projects .proj-card');
  await page.waitForSelector('[data-edit]', { timeout: 15000 });

  const swReady = await page.evaluate(async () => {
    if (!('serviceWorker' in navigator)) return false;
    const reg = await navigator.serviceWorker.ready;
    return !!reg.active;
  });
  check('service worker aktif (app shell ter-cache)', swReady);

  // PUTUS JARINGAN SEPENUHNYA, lalu muat ulang halaman.
  await context.setOffline(true);
  let shellOk = false;
  try {
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.waitForSelector('.topbar', { timeout: 8000 });
    shellOk = !!(await page.$('.topbar'));
  } catch (e) {
    console.error('  [reload offline]', String(e.message).split('\n')[0]);
  }
  check('offline total: app shell tetap termuat dari service worker', shellOk);

  const tb = await page.textContent('.topbar').catch(() => '');
  check('offline: pil "Luring" tampil di topbar', tb.includes('Luring'), tb.slice(0, 90).trim());

  const note = await page.textContent('.off-note').catch(() => '');
  check('offline: banner mode luring di halaman proyek', note.includes('Mode luring'), note.slice(0, 60));

  // Editor membuka isi dari cache perangkat (tanpa jaringan).
  await page.click('[data-edit]');
  await page.waitForSelector('#content-ta', { timeout: 15000 });
  const taBefore = await page.inputValue('#content-ta');
  check('offline: editor membuka isi dari cache perangkat', taBefore.includes('teleprompter Basarang'), taBefore.slice(0, 40));

  // Edit + simpan saat offline → masuk antrean di perangkat.
  const ISI_OFFLINE =
    'Uji luring: paragraf ini diedit tanpa koneksi internet, tersimpan di perangkat, dan terkirim otomatis saat online kembali.';
  await page.fill('#content-ta', ISI_OFFLINE);
  await page.click('#script-form button[type=submit]');
  await sleep(1200);
  const q = await page.evaluate(() => JSON.parse(localStorage.getItem('bsng.queue') || '[]'));
  check(
    'offline: simpan masuk antrean perangkat (PUT tertunda)',
    q.length === 1 && q[0].method === 'PUT' && q[0].body && q[0].body.content === ISI_OFFLINE,
    JSON.stringify(q.map((x) => x.key))
  );
  const draftLeft = await page.evaluate((sid) => !!localStorage.getItem('bsng.draft.edit:' + sid), globalThis.__SID);
  check('offline: draf lokal dibersihkan setelah masuk antrean', !draftLeft);

  // Teleprompter dari cache saat offline — mode Timer menggulir tanpa jaringan.
  await page.evaluate((sid) => { location.hash = '#/prompter/' + sid; }, globalThis.__SID);
  await page.waitForSelector('#p-play', { timeout: 15000 });
  const s0 = await $eval(() => document.getElementById('p-scroll').scrollTop);
  await page.evaluate(() => document.getElementById('p-play').click());
  await sleep(4600);
  const s1 = await $eval(() => document.getElementById('p-scroll').scrollTop);
  check('offline: teleprompter dari cache & mode Timer menggulir', s1 > s0, `${s0} → ${s1}`);
  await page.evaluate(() => document.getElementById('p-exit').click());
  await sleep(400);

  // ONLINE KEMBALI → antrean harus terkirim otomatis.
  await context.setOffline(false);
  await sleep(1800);
  const q2 = await page.evaluate(() => JSON.parse(localStorage.getItem('bsng.queue') || '[]'));
  check('online kembali: antrean terkirim otomatis (kosong)', q2.length === 0, JSON.stringify(q2));
  const d = await api('GET', '/api/scripts/' + globalThis.__SID, null, globalThis.__COOKIE);
  check('server menerima hasil edit offline (isi cocok)', d.data?.data?.script?.content === ISI_OFFLINE);
}

console.log('— Server "sakit" (kuota tulis D1 habis): antrean tak dibuang —');
{
  // Insiden nyata 21 Okt 2026: kuota tulis D1 (level akun, 100 rb baris/hari)
  // terbakar aplikasi lain → semua PUT gagal 503 db_write_limited. Perilaku lama:
  // error non-jaringan = antrean DIBUANG (naskah hilang!). Perilaku baru: 503 =
  // gangguan sementara → antrean menunggu, terkirim otomatis saat pulih.
  const realDb = env.DB;
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
  env.DB = {
    prepare(sql) {
      return /^\s*(select|pragma|explain)\b/i.test(sql) ? realDb.prepare(sql) : quotaStub;
    },
    async batch() {
      throw new Error(QUOTA_MSG);
    },
    async exec(sql) {
      return realDb.exec(sql);
    },
  };

  // Buka editor naskah — endpoint baca tetap hidup saat kuota tulis habis.
  await page.evaluate(() => {
    location.hash = '#/dashboard';
  });
  await page.waitForSelector('#dash-projects .proj-card', { timeout: 15000 });
  await page.click('#dash-projects .proj-card');
  await page.waitForSelector('[data-edit]', { timeout: 15000 });
  await page.click('[data-edit]');
  await page.waitForSelector('#content-ta', { timeout: 15000 });
  const taOpen = await page.inputValue('#content-ta');
  check('server sakit: editor tetap bisa membuka naskah (baca hidup)', taOpen.length > 0, taOpen.slice(0, 40));

  // Edit + simpan saat server sakit → harus masuk antrean perangkat (503 sementara).
  const ISI_SAKIT =
    'Naskah ini disimpan saat server mencapai batas kuota basis data harian — harus tetap aman di perangkat dan terkirim otomatis saat pulih.';
  await page.fill('#content-ta', ISI_SAKIT);
  await page.click('#script-form button[type=submit]');
  await sleep(1200);

  const q1 = await page.evaluate(() => JSON.parse(localStorage.getItem('bsng.queue') || '[]'));
  check(
    'server sakit: simpan masuk antrean perangkat (PUT tertunda)',
    q1.length === 1 && q1[0].method === 'PUT' && q1[0].body && q1[0].body.content === ISI_SAKIT,
    JSON.stringify(q1.map((x) => x.key))
  );
  // Modal editor tertutup setelah simpan (termasuk via antrean) → pesan lewat toast.
  const toastTxt = await page.textContent('#toast-root').catch(() => '');
  check(
    'server sakit: toast "dikirim otomatis saat server pulih" (bukan menyesatkan "saat online")',
    toastTxt.includes('server pulih') && !toastTxt.includes('saat online'),
    toastTxt.slice(0, 90)
  );

  // Coba kirim ulang (event online) saat server MASIH sakit → antrean HARUS utuh.
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await sleep(1500);
  const q2 = await page.evaluate(() => JSON.parse(localStorage.getItem('bsng.queue') || '[]'));
  check('server masih sakit: antrean TIDAK dibuang (menunggu pulih)', q2.length === 1, JSON.stringify(q2));

  // Server pulih → antrean terkirim otomatis.
  env.DB = realDb;
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await sleep(1800);
  const q3 = await page.evaluate(() => JSON.parse(localStorage.getItem('bsng.queue') || '[]'));
  check('server pulih: antrean terkirim otomatis (kosong)', q3.length === 0, JSON.stringify(q3));
  const d2 = await api('GET', '/api/scripts/' + globalThis.__SID, null, globalThis.__COOKIE);
  check('server pulih: isi hasil edit saat server sakit diterima (cocok)', d2.data?.data?.script?.content === ISI_SAKIT);
}

// ---------- Rapikan ----------

await browser.close();
server.close();
try { rmSync(tmp, { recursive: true, force: true }); } catch { /* abaikan */ }

console.log(`\n${passed} lulus, ${failed} gagal`);
process.exit(failed ? 1 : 0);
