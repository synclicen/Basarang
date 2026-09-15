// db.js — skema & util D1 untuk Basarang: Bagarak Saurang
// Self-migration idempoten: dijalankan sekali per isolate saat cold start.

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS app_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS users (
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
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  user_agent TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
CREATE TABLE IF NOT EXISTS login_attempts (
  username TEXT PRIMARY KEY,
  count INTEGER NOT NULL DEFAULT 0,
  window_start TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS projects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  owner_id INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_projects_owner ON projects(owner_id);
CREATE TABLE IF NOT EXISTS scripts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL,
  title TEXT NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  words_per_minute INTEGER NOT NULL DEFAULT 140,
  word_count INTEGER,
  created_by INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_scripts_project ON scripts(project_id);
CREATE TABLE IF NOT EXISTS project_members (
  project_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  role TEXT NOT NULL DEFAULT 'member',
  added_at TEXT NOT NULL,
  PRIMARY KEY (project_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_members_user ON project_members(user_id);
`;

let schemaReady = false;

// Hitung kata di sisi server — regex sama persis dengan wordCount() di app.js
// agar statistik kartu naskah konsisten dengan editor. Dipakai juga backfill migrasi.
export function countWords(text) {
  const m = String(text || '').trim().match(/[\p{L}\p{N}'’-]+/gu);
  return m ? m.length : 0;
}

export async function ensureSchema(db) {
  if (schemaReady) return;
  const statements = SCHEMA_SQL.match(/[^;]+;/g) || [SCHEMA_SQL];
  await db.batch(statements.map((sql) => db.prepare(sql)));
  // Migrasi v2 — kolom word_count: daftar naskah kini metadata-saja (tanpa memuat
  // isi puluhan MB saat sebuah proyek memiliki ratusan naskah); jumlah kata disimpan
  // saat simpan, bukan dihitung ulang tiap halaman.
  try {
    await db.prepare('ALTER TABLE scripts ADD COLUMN word_count INTEGER').run();
  } catch (e) {
    if (!/duplicate column/i.test(String(e && e.message))) throw e;
  }
  // Backfill baris lama secara bertahap (chunk 100) agar CPU isolate tetap kecil;
  // isolate berikutnya melanjutkan sampai habis, lalu bendera app_meta dipasang
  // sehingga cold start selanjutnya hanya membaca 1 baris (bukan memindai tabel).
  const flag = await db.prepare("SELECT value FROM app_meta WHERE key = 'wordcount_backfill'").first();
  if (!flag) {
    for (let i = 0; i < 20; i++) {
      const rows = await db.prepare('SELECT id, content FROM scripts WHERE word_count IS NULL LIMIT 100').all();
      const list = rows.results || [];
      if (!list.length) {
        await db
          .prepare("INSERT OR REPLACE INTO app_meta (key, value) VALUES ('wordcount_backfill', ?)")
          .bind(nowIso())
          .run();
        break;
      }
      await db.batch(
        list.map((r) => db.prepare('UPDATE scripts SET word_count = ? WHERE id = ?').bind(countWords(r.content), r.id))
      );
    }
  }
  schemaReady = true;
}

export function nowIso() {
  return new Date().toISOString();
}
