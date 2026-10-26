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
//   7. MODE PERANGKAT (APK v1.2.0 full offline): konteks bersih + jaringan
//      diputus total → inisialisasi akun, proyek, naskah, teleprompter, keluar,
//      masuk kembali — semuanya TANPA satu pun permintaan /api ke server;
//      lalu sinkronisasi opsional dua arah (Unduh/Unggah) saat online.
//
// Jalankan: node scripts/test-bridge.mjs
// (butuh modul playwright global + worker + mock D1 — tanpa jaringan luar)

import { DatabaseSync } from 'node:sqlite';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { createHash, createHmac } from 'node:crypto';
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

// Algoritma lisensi — identik public/license.js & tools/generate-license.mjs
// (dipakai untuk menghitung kode aktivasi dari Machine ID yang tampil di UI).
const LIC_SECRET = 'BASARANG-2026-HUMAS-UIN-ANTASARI-BANJARMASIN';
function licCode(machineId, expiresAt) {
  const expiryStr = new Date(expiresAt).getTime().toString(16);
  const hash = createHash('sha256').update(`${machineId}:monthly:${expiryStr}:${LIC_SECRET}`).digest('hex');
  const c = hash.substring(0, 16).toUpperCase();
  return `${c.slice(0, 4)}-${c.slice(4, 8)}-${c.slice(8, 12)}-${c.slice(12, 16)}`;
}
function licExpiryIn30d() {
  const d = new Date();
  d.setDate(d.getDate() + 30);
  d.setHours(23, 59, 59, 0);
  return d.toISOString();
}
function licSignedData(machineId, code, expiresAt) {
  const d = {
    machineId, activationCode: code, licenseType: 'monthly',
    activatedAt: new Date().toISOString(), expiresAt, signature: '',
  };
  const payload = JSON.stringify({
    machineId: d.machineId, activationCode: d.activationCode, licenseType: d.licenseType,
    activatedAt: d.activatedAt, expiresAt: d.expiresAt,
  });
  d.signature = createHmac('sha256', LIC_SECRET).update(payload).digest('hex');
  return d;
}

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
  // Regresi 22 Okt 2026: mode gulir dulu meredupkan kata terlewati (kelas done,
  // abu 42% → "menghitam") + blok emas mengikuti posisi proporsional — efek
  // karaoke mengganggu pembacaan; kini teks mode Timer seragam.
  const marks = await $eval(() => ({
    done: document.querySelectorAll('.p-word.done').length,
    cur: document.querySelectorAll('.p-word.cur').length,
  }));
  check('mode Timer: kata terlewati TIDAK memudar (teks seragam)', marks.done === 0, JSON.stringify(marks));
  check('mode Timer: tanpa blok emas', marks.cur === 0, JSON.stringify(marks));
  // Klik kata di mode Timer: lompat tanpa menandai kata apa pun.
  await page.evaluate(() => {
    const ws = document.querySelectorAll('.p-word');
    ws[Math.min(10, ws.length - 1)].click();
  });
  const marksClick = await $eval(() => ({
    done: document.querySelectorAll('.p-word.done').length,
    cur: document.querySelectorAll('.p-word.cur').length,
  }));
  check('mode Timer: klik kata melompat tanpa penanda', marksClick.done === 0 && marksClick.cur === 0, JSON.stringify(marksClick));
  // Ganti ke mode Suara: blok emas muncul di posisi terlihat (garis panduan).
  await page.evaluate(() => document.querySelector('#p-mode [data-mode="voice"]').click());
  await sleep(200);
  const vm = await $eval(() => ({
    done: document.querySelectorAll('.p-word.done').length,
    cur: document.querySelectorAll('.p-word.cur').length,
  }));
  check('ganti ke Suara: blok emas muncul di posisi terlihat', vm.cur === 1, JSON.stringify(vm));
  // Kembali ke mode Timer: seluruh penanda dibersihkan — teks kembali seragam.
  await page.evaluate(() => document.querySelector('#p-mode [data-mode="timer"]').click());
  await sleep(200);
  const tm = await $eval(() => ({
    done: document.querySelectorAll('.p-word.done').length,
    cur: document.querySelectorAll('.p-word.cur').length,
  }));
  check('kembali ke Timer: penanda kata bersih (teks seragam)', tm.done === 0 && tm.cur === 0, JSON.stringify(tm));
  await page.evaluate(() => document.getElementById('p-exit').click());
  await sleep(300);
}

console.log('— Posisi garis panduan: pengaturan + seret langsung —');
{
  // Buka ulang prompter (mode suara) — guidePos belum pernah diatur → default 42%.
  await page.evaluate(() => localStorage.setItem('basarang.prompter', JSON.stringify({ mode: 'voice', fontSize: 1.6 })));
  await page.evaluate((sid) => { location.hash = '#/prompter/' + sid; }, globalThis.__SID);
  await page.waitForSelector('#p-play', { timeout: 15000 });
  const g0 = await $eval(() => {
    const g = document.getElementById('p-guide').getBoundingClientRect();
    const r = document.getElementById('p-scroll').getBoundingClientRect();
    return Math.round(((g.top - r.top) / r.height) * 100);
  });
  check('garis panduan default di 42% tinggi layar', g0 === 42, 'pct=' + g0);

  // Slider "Posisi panduan" di panel pengaturan → 60%.
  await page.evaluate(() => document.getElementById('p-set').click());
  await page.waitForSelector('#ps-gpos', { timeout: 5000 });
  await page.evaluate(() => {
    const r = document.getElementById('ps-gpos');
    r.value = '60';
    r.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await sleep(150);
  const g1 = await $eval(() => {
    const g = document.getElementById('p-guide').getBoundingClientRect();
    const r = document.getElementById('p-scroll').getBoundingClientRect();
    return Math.round(((g.top - r.top) / r.height) * 100);
  });
  check('slider pengaturan memindahkan garis ke 60%', g1 === 60, 'pct=' + g1);
  const saved1 = await page.evaluate(() => JSON.parse(localStorage.getItem('basarang.prompter') || '{}').guidePos);
  check('posisi panduan tersimpan di pengaturan (guidePos=60)', saved1 === 60, 'saved=' + saved1);
  await page.evaluate(() => document.getElementById('ps-close').click());

  // Gulir mode suara mengikuti garis baru: klik kata ke-30 → kata mendarat di ~60%.
  await page.evaluate(() => {
    const ws = document.querySelectorAll('.p-word');
    ws[Math.min(30, ws.length - 1)].click();
  });
  await sleep(450);
  const align = await $eval(() => {
    const ws = document.querySelectorAll('.p-word');
    const w = ws[Math.min(30, ws.length - 1)].getBoundingClientRect();
    const r = document.getElementById('p-scroll').getBoundingClientRect();
    return Math.round(((w.top - r.top) / r.height) * 100);
  });
  check('klik kata melandaskan kata tepat di garis panduan 60% (±4%)', Math.abs(align - 60) <= 4, 'align=' + align);

  // Seret garis langsung: pointer di strip grab, tarik 10% tinggi ke bawah.
  const box = await page.evaluate(() => {
    const g = document.getElementById('p-guide-grab').getBoundingClientRect();
    const r = document.getElementById('p-scroll').getBoundingClientRect();
    return { x: g.left + g.width / 2, y: g.top + g.height / 2, h: r.height };
  });
  await page.mouse.move(box.x, box.y);
  await page.mouse.down();
  await page.mouse.move(box.x, box.y + box.h * 0.1, { steps: 10 });
  await page.mouse.up();
  await sleep(150);
  const g2 = await $eval(() => {
    const g = document.getElementById('p-guide').getBoundingClientRect();
    const r = document.getElementById('p-scroll').getBoundingClientRect();
    return {
      pct: Math.round(((g.top - r.top) / r.height) * 100),
      saved: JSON.parse(localStorage.getItem('basarang.prompter') || '{}').guidePos,
    };
  });
  check('seret garis 10% ke bawah → posisi 70% + tersimpan', g2.pct === 70 && g2.saved === 70, JSON.stringify(g2));

  // Klik singkat pada strip garis TIDAK menelan klik — diteruskan ke kata di bawahnya.
  // Probe dan klik HARUS di titik yang sama (rect grab live, bukan box lama
  // sebelum seret — garis sudah pindah ke 70%).
  const hit = await page.evaluate(() => {
    const g = document.getElementById('p-guide-grab').getBoundingClientRect();
    const r = document.getElementById('p-scroll').getBoundingClientRect();
    const y = g.top + g.height / 2;
    const grab = document.getElementById('p-guide-grab');
    for (const fx of [0.5, 0.25, 0.75]) {
      const x = r.left + r.width * fx;
      grab.style.pointerEvents = 'none';
      const el = document.elementFromPoint(x, y);
      grab.style.pointerEvents = '';
      const w = el instanceof Element ? el.closest('.p-word') : null;
      if (w) return { x, y, word: w.textContent, i: Number(w.dataset.i) };
    }
    return null;
  });
  if (hit) {
    await page.mouse.click(hit.x, hit.y);
    await sleep(400);
    const curInfo = await $eval(() => {
      const els = document.querySelectorAll('.p-word.cur');
      return { n: els.length, i: els.length === 1 ? Number(els[0].dataset.i) : -1, txt: els.length ? els[0].textContent : null };
    });
    // Semantik klik kata yang sudah ada: jumpTo(i) → blok emas di kata i-1
    // (i=0 → kata itu sendiri). Yang DIJAMIN: blok emas TUNGGAL + tepat di
    // slot kata yang diklik (bukan sisa blok kata pertama dari highlight(0)).
    const wantI = Math.max(0, hit.i - 1);
    check(
      'klik singkat pada garis diteruskan ke kata di bawahnya (blok emas tunggal)',
      curInfo.n === 1 && curInfo.i === wantI,
      `cur=${curInfo.txt}(${curInfo.i}) n=${curInfo.n} vs want=${wantI} (klik kata ${hit.i}="${hit.word}")`
    );
  } else {
    check('klik singkat pada garis diteruskan ke kata di bawahnya (lewat — tak ada kata di titik uji)', true, 'skip');
  }

  // Bertahan antar sesi: keluar lalu buka ulang prompter.
  await page.evaluate(() => document.getElementById('p-exit').click());
  await sleep(300);
  await page.evaluate((sid) => { location.hash = '#/prompter/' + sid; }, globalThis.__SID);
  await page.waitForSelector('#p-play', { timeout: 15000 });
  const g3 = await $eval(() => {
    const g = document.getElementById('p-guide').getBoundingClientRect();
    const r = document.getElementById('p-scroll').getBoundingClientRect();
    return Math.round(((g.top - r.top) / r.height) * 100);
  });
  check('posisi panduan bertahan setelah buka ulang prompter (70%)', g3 === 70, 'pct=' + g3);
  await page.evaluate(() => document.getElementById('p-exit').click());
  await sleep(300);
  // Kembalikan pengaturan prompter persis seperti yang ditinggalkan seksi
  // "mode Timer" — seksi offline berikutnya mewarisi mode timer (regresi luring).
  await page.evaluate(() => localStorage.setItem('basarang.prompter', JSON.stringify({ mode: 'timer', fontSize: 1.6, wpm: 200, speed: 2 })));
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

console.log('— Mode perangkat (APK full offline): gerbang lisensi ARAY + tanpa login —');
{
  // Simulasi APK v1.3.0 pada HP tanpa internet: konteks penyimpanan BERSIH,
  // ?lokal=1 mengaktifkan mode perangkat (di APK: origin app.basarang.local).
  // Service worker berperan sebagai pengganti "aset yang dibundel di dalam APK".
  const ctx2 = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const p2 = await ctx2.newPage();
  let apiHits = 0;
  p2.on('request', (r) => {
    if (r.url().includes('/api/')) apiHits++;
  });
  p2.on('pageerror', (e) => console.error('  [pageerror-lokal]', e.message));

  await p2.goto(BASE + '/?lokal=1', { waitUntil: 'domcontentloaded', timeout: 15000 });
  const swReady = await p2.evaluate(async () => {
    if (!('serviceWorker' in navigator)) return false;
    const reg = await navigator.serviceWorker.ready;
    return !!reg.active;
  });
  check('mode perangkat: shell termuat & service worker siap (pengganti aset APK)', swReady);

  // PUTUS JARINGAN SEPENUHNYA — persis HP tanpa sinyal sejak awal.
  await ctx2.setOffline(true);
  await p2.reload({ waitUntil: 'domcontentloaded', timeout: 15000 });

  // Gerbang lisensi tampil PERTAMA setelah "instal" — bukan setup/login.
  await p2.waitForSelector('#lic-gate', { timeout: 15000 });
  check('APK: halaman LISENSI tampil pertama (bukan inisialisasi akun / login)', true);
  const noAuthForms = !(await p2.$('#setup-form')) && !(await p2.$('#login-form'));
  check('APK: tidak ada form username/kata sandi di gerbang', noAuthForms);
  const mid = (await p2.textContent('#lic-machine-id')).trim();
  check('APK: Machine ID 64 heksadesimal tampil & bisa dikirim ke pengembang', /^[a-f0-9]{64}$/.test(mid), mid.slice(0, 16) + '…');

  // Kode salah → ditolak dengan pesan jelas.
  await p2.fill('#lic-code', 'AAAA-BBBB-CCCC-DDDD');
  await p2.click('#lic-activate');
  await p2.waitForFunction(
    () => ((document.getElementById('lic-err') || {}).textContent || '').length > 0,
    null,
    { timeout: 15000 }
  );
  const errTxt = await p2.textContent('#lic-err');
  check('APK: kode aktivasi salah ditolak dengan pesan', /tidak valid/i.test(errTxt), errTxt.trim());

  // Kode benar (dihitung Node dari Machine ID yang tampil — algoritma identik).
  const kode = licCode(mid, licExpiryIn30d());
  await p2.fill('#lic-code', kode);
  await p2.click('#lic-activate');
  await p2.waitForFunction(() => location.hash === '#/dashboard', null, { timeout: 15000 });
  check('APK: aktivasi sukses → LANGSUNG dashboard (tanpa akun, tanpa login)', true);

  const tbL = await p2.textContent('.topbar').catch(() => '');
  check('APK: pil "Perangkat" tampil di topbar', tbL.includes('Perangkat'), tbL.slice(0, 80).trim());
  check('APK: tombol Sinkron opsional tampil di topbar', !!(await p2.$('#btn-sync')));
  check('APK: tombol Lisensi tampil di topbar', !!(await p2.$('#btn-license')));
  check('APK: tombol Keluar & Ubah Sandi TIDAK ada (tanpa login)', !(await p2.$('#btn-logout')) && !(await p2.$('#btn-pass')));
  const nmChip = await p2.textContent('.userchip .nm').catch(() => '');
  check('APK: akun otomatis "Pengguna Basarang" dibuat tanpa form', nmChip.trim() === 'Pengguna Basarang', nmChip.trim());

  // Buat proyek + naskah sepenuhnya offline.
  await p2.click('#btn-new-proj');
  await p2.waitForSelector('#proj-form input[name=name]', { timeout: 15000 });
  await p2.fill('#proj-form input[name=name]', 'Proyek Luring');
  await p2.fill('#proj-form textarea[name=description]', 'dibuat tanpa internet');
  await p2.click('#proj-form button[type=submit]');
  await p2.waitForSelector('#dash-projects .proj-card', { timeout: 15000 });
  check('APK offline: proyek dibuat di penyimpanan perangkat (IndexedDB)', true);

  await p2.click('#dash-projects .proj-card');
  await p2.waitForSelector('#btn-new-script', { timeout: 15000 });
  await p2.click('#btn-new-script');
  await p2.waitForSelector('#content-ta', { timeout: 15000 });
  await p2.fill('#script-form input[name=title]', 'Naskah Tanpa Internet');
  const ISI_LOKAL =
    'Naskah ini ditulis sepenuhnya tanpa koneksi internet di mode perangkat Basarang. Setiap kata tersimpan aman di penyimpanan perangkat dan teleprompter tetap berjalan penuh meski jaringan mati total.';
  await p2.fill('#content-ta', ISI_LOKAL);
  await p2.click('#script-form button[type=submit]');
  await p2.waitForSelector('[data-edit]', { timeout: 15000 });
  check('APK offline: naskah tersimpan & muncul di daftar proyek', true);

  // Isi naskah utuh di IndexedDB perangkat.
  const inDb = await p2.evaluate(async () => {
    return await new Promise((resolve) => {
      const rq = indexedDB.open('basarang-local');
      rq.onsuccess = () => {
        try {
          const db = rq.result;
          const tx = db.transaction('scripts', 'readonly');
          const req = tx.objectStore('scripts').getAll();
          req.onsuccess = () => resolve(req.result || []);
          req.onerror = () => resolve(null);
        } catch {
          resolve(null);
        }
      };
      rq.onerror = () => resolve(null);
    });
  });
  check(
    'APK offline: isi naskah utuh byte-per-byte di IndexedDB perangkat',
    Array.isArray(inDb) && inDb.length === 1 && inDb[0].content === ISI_LOKAL,
    JSON.stringify((inDb || []).map((s) => s && s.title))
  );

  // Teleprompter mode Timer menggulir tanpa internet.
  await p2.evaluate(() =>
    localStorage.setItem('basarang.prompter', JSON.stringify({ mode: 'timer', fontSize: 1.6, wpm: 200, speed: 2 }))
  );
  const sidLokal = Array.isArray(inDb) && inDb[0] ? inDb[0].id : null;
  await p2.evaluate((id) => {
    location.hash = '#/prompter/' + id;
  }, sidLokal);
  await p2.waitForSelector('#p-play', { timeout: 15000 });
  const t0 = await p2.evaluate(() => document.getElementById('p-scroll').scrollTop);
  await p2.evaluate(() => document.getElementById('p-play').click());
  await sleep(4600);
  const t1 = await p2.evaluate(() => document.getElementById('p-scroll').scrollTop);
  check('APK offline: teleprompter mode Timer menggulir tanpa internet', t1 > t0, `${t0} → ${t1}`);
  await p2.evaluate(() => document.getElementById('p-exit').click());
  await sleep(400);

  // "Buka ulang aplikasi": lisensi + akun otomatis bertahan — TANPA gerbang
  // lisensi dan TANPA login (dulu: keluar → form login → masuk lagi).
  await p2.evaluate(() => {
    location.hash = '#/dashboard';
  });
  await p2.reload({ waitUntil: 'domcontentloaded', timeout: 15000 });
  await p2.waitForSelector('#btn-license', { timeout: 15000 });
  const masihMasuk = (await p2.evaluate(() => location.hash)) === '#/dashboard' && !(await p2.$('#lic-gate'));
  const kartu = await p2.$$eval('#dash-projects .proj-card h3', (ns) => ns.map((n) => n.textContent));
  check('APK: buka ulang → langsung masuk (lisensi & sesi bertahan, tanpa login)', masihMasuk);
  check('APK: buka ulang → data perangkat utuh (proyek tampil)', kartu.includes('Proyek Luring'), JSON.stringify(kartu));

  // Halaman info lisensi dari topbar: status, sisa hari, Machine ID.
  await p2.click('#btn-license');
  await p2.waitForSelector('#lic-info', { timeout: 15000 });
  const infoTxt = await p2.textContent('#lic-info');
  check('APK: halaman info lisensi (status + sisa waktu + Machine ID)', infoTxt.includes('Lisensi Perangkat') && infoTxt.includes('hari') && infoTxt.includes(mid), infoTxt.slice(0, 80).trim());
  await p2.click('#lic-info a[href="#/dashboard"]');
  await p2.waitForSelector('#dash-projects', { timeout: 15000 });

  check(
    'APK offline: TIDAK ADA satu pun permintaan /api ke server sepanjang alur',
    apiHits === 0,
    'apiHits=' + apiHits
  );

  // Sinkronisasi opsional: online kembali → hubungkan akun server → Unduh & Unggah.
  await ctx2.setOffline(false);
  await sleep(400);
  await p2.click('#btn-sync');
  await p2.waitForSelector('#sync-form', { timeout: 15000 });
  await p2.fill('#sync-form input[name=username]', 'fajrianor');
  await p2.fill('#sync-form input[name=password]', 'rahasia-kuat-2026');
  await p2.click('#sync-form button[type=submit]');
  await p2.waitForSelector('#sync-dl', { timeout: 15000 });
  check('APK: akun server terhubung utk sinkronisasi opsional', true);

  // Unduh: proyek server tersalin ke penyimpanan perangkat.
  await p2.click('#sync-dl');
  await p2.waitForFunction(
    () => ((document.getElementById('sync-out') || {}).textContent || '').includes('Selesai'),
    null,
    { timeout: 30000 }
  );
  const kartu2 = await p2.$$eval('#dash-projects .proj-card h3', (ns) => ns.map((n) => n.textContent));
  check('APK sinkron Unduh: proyek server muncul di perangkat', kartu2.includes('Uji APK'), JSON.stringify(kartu2));

  // Unggah: proyek & naskah perangkat terkirim ke server.
  await p2.click('#sync-ul');
  await p2.waitForFunction(
    () => ((document.getElementById('sync-out') || {}).textContent || '').includes('Selesai'),
    null,
    { timeout: 30000 }
  );
  const plist = await api('GET', '/api/projects', null, globalThis.__COOKIE);
  const projectsServer = ((plist.data || {}).data || {}).projects || [];
  check(
    'APK sinkron Unggah: proyek perangkat sampai ke server',
    projectsServer.some((p) => p.name === 'Proyek Luring'),
    JSON.stringify(projectsServer.map((p) => p.name))
  );
  const pLuring = projectsServer.find((p) => p.name === 'Proyek Luring');
  if (pLuring) {
    const det = await api('GET', '/api/projects/' + pLuring.id, null, globalThis.__COOKIE);
    const scripts = ((det.data || {}).data || {}).scripts || [];
    const sk = scripts.find((s) => s.title === 'Naskah Tanpa Internet');
    check('APK sinkron Unggah: naskah perangkat ikut terkirim', !!sk, JSON.stringify(scripts.map((s) => s.title)));
    if (sk) {
      const sd = await api('GET', '/api/scripts/' + sk.id, null, globalThis.__COOKIE);
      const isi = ((sd.data || {}).data || {}).script || {};
      check('APK sinkron Unggah: isi naskah cocok byte-per-byte di server', isi.content === ISI_LOKAL);
    } else {
      check('APK sinkron Unggah: isi naskah cocok byte-per-byte di server', false, 'naskah tak ditemukan');
    }
  } else {
    check('APK sinkron Unggah: naskah perangkat ikut terkirim', false, 'proyek tak ditemukan');
    check('APK sinkron Unggah: isi naskah cocok byte-per-byte di server', false, 'proyek tak ditemukan');
  }

  await ctx2.close();
}

console.log('— Lisensi: kedaluwarsa mengunci & web tanpa gerbang —');
{
  // Lisensi kedaluwarsa (kode utk kemarin, ditandatangani benar, tanpa sesi
  // acara) → aplikasi terkunci kembali ke gerbang lisensi.
  const ctx3 = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const p3 = await ctx3.newPage();
  p3.on('pageerror', (e) => console.error('  [pageerror-exp]', e.message));
  await p3.goto(BASE + '/?lokal=1', { waitUntil: 'domcontentloaded', timeout: 15000 });
  const mid3 = await p3.evaluate(async () => {
    await window.BasarangLicense.machineId();
    return (await window.BasarangLicense.machineId());
  });
  const kemarin = new Date();
  kemarin.setDate(kemarin.getDate() - 1);
  kemarin.setHours(23, 59, 59, 0);
  await p3.evaluate((raw) => {
    localStorage.setItem('basarang.license.data', raw);
    localStorage.removeItem('basarang.license.session');
  }, JSON.stringify(licSignedData(mid3, licCode(mid3, kemarin.toISOString()), kemarin.toISOString())));
  await p3.reload({ waitUntil: 'domcontentloaded', timeout: 15000 });
  await p3.waitForSelector('#lic-gate', { timeout: 15000 });
  const kunci = (await p3.evaluate(() => location.hash)) === '#/lisensi' && !(await p3.$('.topbar'));
  check('lisensi kedaluwarsa: terkunci kembali ke gerbang (alamat #/lisensi)', kunci);
  const gateTxt = await p3.textContent('#lic-gate');
  check('lisensi kedaluwarsa: pesan kedaluwarsa + informasi perpanjangan tampil', /kedaluwarsa/i.test(gateTxt) && /pengembang/i.test(gateTxt));
  await ctx3.close();

  // Situs web (tanpa ?lokal=1): TIDAK ada gerbang lisensi — tetap login biasa.
  const ctx4 = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const p4 = await ctx4.newPage();
  p4.on('pageerror', (e) => console.error('  [pageerror-web]', e.message));
  await p4.goto(BASE + '/', { waitUntil: 'domcontentloaded', timeout: 15000 });
  await p4.waitForSelector('#login-form', { timeout: 15000 });
  check('web (tanpa ?lokal=1): login biasa — TIDAK ada gerbang lisensi', !(await p4.$('#lic-gate')));
  await ctx4.close();
}

// ---------- Rapikan ----------

await browser.close();
server.close();
try { rmSync(tmp, { recursive: true, force: true }); } catch { /* abaikan */ }

console.log(`\n${passed} lulus, ${failed} gagal`);
process.exit(failed ? 1 : 0);
