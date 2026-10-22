// verify-fade.mjs — Verifikasi visual: mode Timer teks seragam (tanpa kata
// memudar), mode Suara tetap karaoke (redup + blok emas). Screenshot ke /tmp.
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
const PORT = 8801;
const BASE = `http://127.0.0.1:${PORT}`;
const tmp = mkdtempSync(join(tmpdir(), 'basarang-vfade-'));

class MockStatement {
  constructor(db, sql) { this.db = db; this.sql = sql; this.params = []; }
  bind(...p) { const s = new MockStatement(this.db, this.sql); s.params = p; return s; }
  async _run() { const st = this.db.prepare(this.sql); const i = st.run(...this.params); return { success: true, meta: { changes: i.changes, last_row_id: Number(i.lastInsertRowid) } }; }
  async run() { return this._run(); }
  async first() { const st = this.db.prepare(this.sql); return st.get(...this.params) || null; }
  async all() { const st = this.db.prepare(this.sql); return { results: st.all(...this.params) || [] }; }
}
class MockD1 {
  constructor(path) { this.db = new DatabaseSync(path); this.db.exec('PRAGMA journal_mode = WAL;'); }
  prepare(sql) { return new MockStatement(this.db, sql); }
  async batch(sts) { const out = []; this.db.exec('BEGIN'); try { for (const st of sts) { if (/^\s*select/i.test(st.sql)) { const s = this.db.prepare(st.sql); out.push({ success: true, results: s.all(...st.params) || [], meta: {} }); } else { out.push({ ...(await st._run()), results: [] }); } } this.db.exec('COMMIT'); } catch (e) { this.db.exec('ROLLBACK'); throw e; } return out; }
  async exec(sql) { this.db.exec(sql); }
}

const env = { DB: new MockD1(join(tmp, 'd.db')) };

const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, BASE);
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const hasBody = chunks.length > 0 && !['GET', 'HEAD'].includes(req.method);
    const r = await worker.fetch(new Request(BASE + req.url, {
      method: req.method,
      headers: req.headers,
      body: hasBody ? Buffer.concat(chunks) : undefined,
    }), env);
    const raw = [];
    for (const [k, v] of r.headers) raw.push(k, v);
    res.writeHead(r.status, raw);
    res.end(Buffer.from(await r.arrayBuffer()));
  } catch (e) {
    res.writeHead(500);
    res.end(String(e && e.stack || e));
  }
});
await new Promise((ok) => server.listen(PORT, '127.0.0.1', ok));

const ISI = Array.from({ length: 14 }, (_, i) =>
  'Kalimat uji nomor ' + (i + 1) + ' untuk memastikan mode gulir menampilkan teks yang seragam penuh tanpa kata yang memudar menjadi gelap saat telah melewati garis panduan pembacaan.'
).join('\n\n');

const api = async (method, path, body, cookie) => {
  const r = await fetch(BASE + path, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const sc = r.headers.getSetCookie ? r.headers.getSetCookie() : [];
  const data = await r.json().catch(() => null);
  return { status: r.status, data, cookie: sc.map((c) => c.split(';')[0]).join('; ') || cookie };
};
const st = await api('POST', '/api/auth/setup', { display_name: 'T', username: 'penguji', password: 'rahasia-kuat-2026' });
const lg = await api('POST', '/api/auth/login', { username: 'penguji', password: 'rahasia-kuat-2026' });
const ck = lg.cookie;
const pj = await api('POST', '/api/projects', { name: 'Pengujian Fade' }, ck);
const pid = pj.data?.data?.project?.id;
const sc = await api('POST', `/api/projects/${pid}/scripts`, { title: 'Naskah Uji Fade', content: ISI }, ck);
const SID = sc.data?.data?.script?.id;
if (!SID) { console.error('SEED GAGAL', st.status, lg.status, pj.status, sc.status, JSON.stringify(pj.data).slice(0, 200)); process.exit(1); }

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 480, height: 900 } });
await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
await page.fill('#login-form input[name=username]', 'penguji');
await page.fill('#login-form input[name=password]', 'rahasia-kuat-2026');
await page.click('#login-form button[type=submit]');
await page.waitForFunction(() => location.hash === '#/dashboard', null, { timeout: 15000 });

// Skenario 1: mode TIMER — gulir manual ke tengah → teks harus seragam.
await page.evaluate(() => localStorage.setItem('basarang.prompter', JSON.stringify({ mode: 'timer', fontSize: 1, theme: 'gold' })));
await page.evaluate((id) => { location.hash = '#/prompter/' + id; }, SID);
await page.waitForSelector('#p-play', { timeout: 15000 });
await page.evaluate(() => {
  const s = document.getElementById('p-scroll');
  s.scrollTop = s.scrollHeight * 0.35;
});
await page.waitForTimeout(400);
await page.screenshot({ path: '/home/z/my-project/download/verify-timer-seragam.png' });
const timerMarks = await page.evaluate(() => ({ done: document.querySelectorAll('.p-word.done').length, cur: document.querySelectorAll('.p-word.cur').length }));
console.log('TIMER marks (harus 0/0):', JSON.stringify(timerMarks));

// Skenario 2: ganti ke mode SUARA → karaoke: redup + blok emas di garis panduan.
await page.evaluate(() => document.querySelector('#p-mode [data-mode="voice"]').click());
await page.waitForTimeout(400);
await page.screenshot({ path: '/home/z/my-project/download/verify-suara-karaoke.png' });
const voiceMarks = await page.evaluate(() => ({ done: document.querySelectorAll('.p-word.done').length, cur: document.querySelectorAll('.p-word.cur').length }));
console.log('VOICE marks (cur harus 1):', JSON.stringify(voiceMarks));

await browser.close();
server.close();
try { rmSync(tmp, { recursive: true, force: true }); } catch { /* */ }
console.log('SELESAI');
