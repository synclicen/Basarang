// scale-check.mjs — diagnostik skala: simulasi proyek berisi 300 naskah (±200 kata/naskah)
// untuk mengukur ukuran respons daftar & latensi pada volume "ratusan naskah".
// Diagnostik (bukan tes regresi) — jalankan manual: node scripts/scale-check.mjs

import { DatabaseSync } from 'node:sqlite';
import { rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import worker from '../src/index.js';

const ORIGIN = 'https://basarang.test';
const N = 300;

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
    const info = stmt.run(...this.params.map((p) => (typeof p === 'boolean' ? (p ? 1 : 0) : p)));
    return { success: true, meta: { changes: info.changes, last_row_id: Number(info.lastInsertRowid) } };
  }
  async run() {
    return this._run();
  }
  async first() {
    const stmt = this.db.prepare(this.sql);
    return stmt.get(...this.params.map((p) => (typeof p === 'boolean' ? (p ? 1 : 0) : p))) || null;
  }
  async all() {
    const stmt = this.db.prepare(this.sql);
    return { results: stmt.all(...this.params.map((p) => (typeof p === 'boolean' ? (p ? 1 : 0) : p))) || [] };
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
    for (const st of statements) {
      if (/^\s*select/i.test(st.sql)) {
        const stmt = this.db.prepare(st.sql);
        out.push({ success: true, results: stmt.all(...st.params) || [], meta: {} });
      } else {
        out.push({ ...(await st._run()), results: [] });
      }
    }
    return out;
  }
}

const tmp = mkdtempSync(join(tmpdir(), 'basarang-scale-'));
const db = new MockD1(join(tmp, 'scale.db'));
const env = { DB: db };
let cookies = '';

async function req(method, path, { body } = {}) {
  const headers = {};
  if (cookies) headers['cookie'] = cookies;
  let payload;
  if (body !== undefined) {
    headers['content-type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const r = new Request(ORIGIN + path, { method, headers, body: payload });
  const res = await worker.fetch(r, env);
  for (const c of res.headers.getSetCookie ? res.headers.getSetCookie() : []) cookies = c.split(';')[0];
  const text = await res.text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {}
  return { status: res.status, data, text };
}

// Setup super admin via API (skema termigrasi otomatis saat request pertama).
await req('POST', '/api/auth/setup', { body: { username: 'bench', password: 'password-bench-2026' } });
await req('POST', '/api/projects', { body: { name: 'Skala 300' } });

// 300 naskah × ±200 kata — sisipkan langsung ke DB (lebih cepat dari 300 POST).
const words = Array.from({ length: 200 }, (_, i) => 'kata' + (i + 1)).join(' ');
const now = new Date().toISOString();
const ins = db.db.prepare(
  'INSERT INTO scripts (project_id, title, content, words_per_minute, word_count, created_by, created_at, updated_at) VALUES (1, ?, ?, 140, 200, 1, ?, ?)'
);
const t0 = Date.now();
const tx = db.db.exec('BEGIN');
for (let i = 1; i <= N; i++) ins.run('Naskah Uji ' + i, words, now, now);
db.db.exec('COMMIT');
console.log(`Seed ${N} naskah × 200 kata: ${Date.now() - t0} ms`);

// Ukur daftar proyek (metadata-saja).
const t1 = Date.now();
const list = await req('GET', '/api/projects/1');
const ms = Date.now() - t1;
const bytes = new TextEncoder().encode(list.text).length;
const scripts = list.data.data.scripts;
console.log(`GET /api/projects/1 → ${scripts.length} naskah, ${(bytes / 1024).toFixed(1)} KB, ${ms} ms`);
console.log(`  contoh: ${JSON.stringify(scripts[0])}`);
console.log(`  semua metadata-saja: ${scripts.every((s) => s.content === undefined && s.word_count === 200)}`);

// Bandingkan: berapa byte seandainya masih SELECT * (isi ikut dikirim).
const fullBytes = bytes + N * words.length;
console.log(`  estimasi versi LAMA (SELECT *): ~${(fullBytes / 1024 / 1024).toFixed(1)} MB per buka halaman`);

// Ambil satu naskah penuh (jalur editor/teleprompter).
const t2 = Date.now();
const one = await req('GET', '/api/scripts/150');
console.log(`GET /api/scripts/150 (isi penuh): ${new TextEncoder().encode(one.text).length} B, ${Date.now() - t2} ms, akses=${one.status}`);

rmSync(tmp, { recursive: true, force: true });
console.log('\nSELESAI');
