// test-migrate.mjs — uji jalur migrasi database LAMA (pra-word_count) dalam proses baru.
// test-local.mjs memakai DB segar (CREATE TABLE sudah memuat word_count), sehingga
// jalur ALTER + backfill pada DB produksi yang sudah berisi data tidak tercakup di sana
// (flag schemaReady modul db.js hanya boleh di-set sekali per proses).
// Skrip ini wajib dijalankan sebagai PROSES TERPISAH — persis seperti isolate Worker
// baru yang menemukan database lama saat cold start.

import { DatabaseSync } from 'node:sqlite';
import { rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import worker from '../src/index.js';
import * as auth from '../src/auth.js';

const ORIGIN = 'https://basarang.test';
let passed = 0;
let failed = 0;
function check(name, cond, extra = '') {
  if (cond) {
    passed++;
    console.log('  ✓ ' + name);
  } else {
    failed++;
    console.error('  ✗ ' + name + (extra ? ' — ' + extra : ''));
  }
}

// ---------- Skema LAMA (persis pra-migrasi: tanpa kolom word_count) ----------
const OLD_SCHEMA = `
CREATE TABLE app_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  email TEXT UNIQUE,
  display_name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('super_admin','manager','member')),
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  last_login_at TEXT
);
CREATE TABLE sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  user_agent TEXT
);
CREATE INDEX idx_sessions_user ON sessions(user_id);
CREATE INDEX idx_sessions_expires ON sessions(expires_at);
CREATE TABLE login_attempts (
  username TEXT PRIMARY KEY,
  count INTEGER NOT NULL DEFAULT 0,
  window_start TEXT NOT NULL
);
CREATE TABLE projects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  owner_id INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_projects_owner ON projects(owner_id);
CREATE TABLE scripts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL,
  title TEXT NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  words_per_minute INTEGER NOT NULL DEFAULT 140,
  created_by INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_scripts_project ON scripts(project_id);
CREATE TABLE project_members (
  project_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  role TEXT NOT NULL DEFAULT 'member',
  added_at TEXT NOT NULL,
  PRIMARY KEY (project_id, user_id)
);
CREATE INDEX idx_members_user ON project_members(user_id);
`;

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
    this.db.exec('BEGIN');
    try {
      for (const st of statements) {
        if (/^\s*select/i.test(st.sql)) {
          const stmt = this.db.prepare(st.sql);
          out.push({ success: true, results: stmt.all(...st.params) || [], meta: {} });
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
}

// ---------- Skenario: DB produksi lama berisi 2 pengguna & 3 naskah ----------
const tmp = mkdtempSync(join(tmpdir(), 'basarang-migrate-'));
const db = new MockD1(join(tmp, 'old.db'));
db.db.exec(OLD_SCHEMA);
const now = new Date().toISOString();

// Hash gaya LAMA: 25.000 iterasi — verifikasi login harus tetap menerima ini.
const OLD_ITER = 25000;
const enc = new TextEncoder();
function toHex(bytes) {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}
async function deriveOld(password, salt, iterations) {
  const baseKey = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, baseKey, 256);
  return new Uint8Array(bits);
}
const salt = crypto.getRandomValues(new Uint8Array(16));
const oldHash = `pbkdf2:${OLD_ITER}:${toHex(salt)}:${toHex(await deriveOld('rahasia-lama-2026', salt, OLD_ITER))}`;

db.db
  .prepare('INSERT INTO users (username, display_name, password_hash, role, is_active, created_at) VALUES (?, ?, ?, ?, 1, ?)')
  .run('fajrianor', 'Fajrianor', oldHash, 'super_admin', now);
db.db.prepare('INSERT INTO projects (name, description, owner_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run(
  'Humas Lama',
  'proyek pra-migrasi',
  1,
  now,
  now
);
const contents = [
  ['Naskah Satu', 'satu dua tiga empat lima'], // 5 kata
  ['Naskah Dua', 'enam tujuh delapan'], // 3 kata
  ['Naskah Tiga', 'sembilan sepuluh sebelas dua belas tiga'], // 6 kata
];
for (const [title, content] of contents) {
  db.db
    .prepare('INSERT INTO scripts (project_id, title, content, words_per_minute, created_by, created_at, updated_at) VALUES (?, ?, ?, 140, 1, ?, ?)')
    .run(1, title, content, now, now);
}

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
  const sc = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  for (const c of sc || []) cookies = c.split(';')[0];
  const text = await res.text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {}
  return { status: res.status, data };
}

console.log('— Migrasi DB lama (ALTER word_count + backfill) —');
{
  // Cold start: request pertama memicu ensureSchema → ALTER + backfill + bendera.
  const health = await req('GET', '/api/health');
  check('cold start pada DB lama sehat', health.status === 200 && health.data.ok === true);

  const login = await req('POST', '/api/auth/login', { body: { username: 'fajrianor', password: 'rahasia-lama-2026' } });
  check('login dengan hash iterasi LAMA (25.000) tetap sah', login.status === 200, 'status=' + login.status);

  const detail = await req('GET', '/api/projects/1');
  const scripts = (detail.data && detail.data.data && detail.data.data.scripts) || [];
  check('ALTER + backfill: 3 naskah lama kini ber-word_count', scripts.length === 3 && scripts.every((s) => Number.isInteger(s.word_count)), JSON.stringify(scripts.map((s) => s.word_count)));
  const byTitle = Object.fromEntries(scripts.map((s) => [s.title, s.word_count]));
  check(
    'backfill menghitung kata dengan benar',
    byTitle['Naskah Satu'] === 5 && byTitle['Naskah Dua'] === 3 && byTitle['Naskah Tiga'] === 6,
    JSON.stringify(byTitle)
  );
  check('daftar hasil backfill metadata-saja (tanpa content)', scripts.every((s) => s.content === undefined));

  const flag = db.db.prepare("SELECT value FROM app_meta WHERE key = 'wordcount_backfill'").get();
  check('bendera backfill terpasang (cold start berikut hanya 1 baris baca)', !!flag);

  // Idempoten: request berikutnya (schemaReady) tetap sehat & data tak berubah.
  const detail2 = await req('GET', '/api/projects/1');
  const scripts2 = (detail2.data && detail2.data.data && detail2.data.data.scripts) || [];
  check('request kedua stabil (migrasi idempoten)', scripts2.length === 3 && scripts2.every((s) => Number.isInteger(s.word_count)));

  // Ganti sandi → hash baru (15.000 iter) → login ulang tetap berhasil.
  const chpw = await req('POST', '/api/auth/password', { body: { current: 'rahasia-lama-2026', next: 'rahasia-baru-2026' } });
  check('ganti sandi pada DB lama berhasil (2 derivasi PBKDF2 ≤ 15k iter)', chpw.status === 200, 'status=' + chpw.status);
  const row = db.db.prepare('SELECT password_hash FROM users WHERE id = 1').get();
  check('hash baru memakai iterasi baru (15.000)', String(row.password_hash).startsWith('pbkdf2:15000:'), String(row.password_hash).slice(0, 20));
  cookies = '';
  const relogin = await req('POST', '/api/auth/login', { body: { username: 'fajrianor', password: 'rahasia-baru-2026' } });
  check('login ulang dengan sandi baru berhasil', relogin.status === 200, 'status=' + relogin.status);
}

rmSync(tmp, { recursive: true, force: true });
console.log(`\nHasil: ${passed} lulus, ${failed} gagal`);
process.exit(failed ? 1 : 0);
