// verify-license.mjs — Verifikasi visual sistem lisensi (screenshot PNG ke download/).
// Menjalankan worker di 127.0.0.1:8801, membuka mode perangkat (?lokal=1),
// menangkap: (1) gerbang lisensi pertama, (2) dashboard pasca-aktivasi
// (tanpa login), (3) halaman info lisensi dari topbar.
//
// Jalankan: node scripts/verify-license.mjs

import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
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
const OUT = '/home/z/my-project/download';

const LIC_SECRET = 'BASARANG-2026-HUMAS-UIN-ANTASARI-BANJARMASIN';
function licCode(machineId, expiresAt) {
  const expiryStr = new Date(expiresAt).getTime().toString(16);
  const hash = createHash('sha256').update(`${machineId}:monthly:${expiryStr}:${LIC_SECRET}`).digest('hex');
  const c = hash.substring(0, 16).toUpperCase();
  return `${c.slice(0, 4)}-${c.slice(4, 8)}-${c.slice(8, 12)}-${c.slice(12, 16)}`;
}

class MockStatement {
  constructor(db, sql) { this.db = db; this.sql = sql; this.params = []; }
  bind(...params) { const s = new MockStatement(this.db, this.sql); s.params = params; return s; }
  async _run() { const stmt = this.db.prepare(this.sql); const info = stmt.run(...this.params); return { success: true, meta: { changes: info.changes, last_row_id: Number(info.lastInsertRowId) } }; }
  async run() { return this._run(); }
  async first() { const stmt = this.db.prepare(this.sql); return stmt.get(...this.params) || null; }
  async all() { const stmt = this.db.prepare(this.sql); return { results: stmt.all(...this.params) || [] }; }
}
class MockD1 {
  constructor(path) { this.db = new DatabaseSync(path); this.db.exec('PRAGMA journal_mode = WAL;'); }
  prepare(sql) { return new MockStatement(this.db, sql); }
  async batch(stmts) { const out = []; for (const s of stmts) out.push(await s.run()); return out; }
  async exec(sql) { this.db.exec(sql); }
}

const tmp = mkdtempSync(join(tmpdir(), 'basarang-lic-'));
const db = new MockD1(join(tmp, 'db.sqlite'));
db.exec(`CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, username TEXT UNIQUE NOT NULL, email TEXT, display_name TEXT, password_hash TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'editor', is_active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, last_login_at TEXT);
CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, user_id INTEGER NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS projects (id INTEGER PRIMARY KEY, name TEXT NOT NULL, description TEXT, owner_id INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS scripts (id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL, title TEXT NOT NULL, content TEXT NOT NULL DEFAULT '', words_per_minute INTEGER NOT NULL DEFAULT 160, word_count INTEGER NOT NULL DEFAULT 0, created_by INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS project_members (project_id INTEGER NOT NULL, user_id INTEGER NOT NULL, role TEXT NOT NULL DEFAULT 'member', created_at TEXT NOT NULL, PRIMARY KEY (project_id, user_id));`);

const server = http.createServer((req, res) => {
  worker.fetch(new Request('http://x' + req.url, { method: req.method, headers: { 'content-type': 'application/json' } }), { DB: db })
    .then(async (r) => {
      res.writeHead(r.status, Object.fromEntries(r.headers));
      res.end(await r.text());
    })
    .catch((e) => { res.writeHead(500); res.end(String(e)); });
});
await new Promise((r) => server.listen(PORT, '127.0.0.1', r));

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const page = await ctx.newPage();
page.on('pageerror', (e) => console.error('[pageerror]', e.message));

try {
  // 1. Gerbang lisensi (pertama setelah "instal").
  await page.goto(BASE + '/?lokal=1', { waitUntil: 'domcontentloaded', timeout: 15000 });
  await page.evaluate(async () => { if ('serviceWorker' in navigator) await navigator.serviceWorker.ready; });
  await page.waitForSelector('#lic-gate', { timeout: 15000 });
  await page.waitForFunction(() => ((document.getElementById('lic-machine-id') || {}).textContent || '').trim().length === 64, null, { timeout: 15000 });
  await page.screenshot({ path: OUT + '/lisensi-1-gerbang.png', fullPage: true });
  console.log('✓ lisensi-1-gerbang.png');

  // 2. Aktivasi → dashboard tanpa login.
  const mid = (await page.textContent('#lic-machine-id')).trim();
  const exp = new Date(); exp.setDate(exp.getDate() + 30); exp.setHours(23, 59, 59, 0);
  await page.fill('#lic-code', licCode(mid, exp.toISOString()));
  await page.click('#lic-activate');
  await page.waitForFunction(() => location.hash === '#/dashboard', null, { timeout: 15000 });
  await page.waitForSelector('.topbar', { timeout: 15000 });
  await page.screenshot({ path: OUT + '/lisensi-2-dashboard.png', fullPage: true });
  console.log('✓ lisensi-2-dashboard.png');

  // 3. Halaman info lisensi dari topbar.
  await page.click('#btn-license');
  await page.waitForSelector('#lic-info', { timeout: 15000 });
  await page.screenshot({ path: OUT + '/lisensi-3-info.png', fullPage: true });
  console.log('✓ lisensi-3-info.png');
} finally {
  await browser.close();
  server.close();
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* abaikan */ }
}
console.log('Selesai — 3 screenshot di ' + OUT);
