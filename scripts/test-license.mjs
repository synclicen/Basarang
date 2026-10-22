// test-license.mjs — Uji unit sistem lisensi Basarang (public/license.js,
// port sistem ARAY) di Node: pembuatan & verifikasi kode, aktivasi, tamper
// signature, kedaluwarsa, grace sesi acara 72 jam, admin key, dan
// kestabilan machineId terhadap rotasi layar.
//
// Jalankan: node scripts/test-license.mjs

import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

let passed = 0;
let failed = 0;
function check(name, cond, detail) {
  if (cond) {
    passed++;
    console.log('  ok - ' + name);
  } else {
    failed++;
    console.log('  GAGAL - ' + name + (detail ? ' — ' + detail : ''));
  }
}

// ---------- Muat license.js di Node (IIFE menempel ke globalThis) ----------
// Node >= 18 punya crypto.subtle (WebCrypto) & TextEncoder global.
const src = readFileSync(join(ROOT, 'public/license.js'), 'utf8');
(0, eval)(src);
const L = globalThis.BasarangLicense;
check('license.js termuat & API lengkap (status/activate/generateFor)', !!(L && L.status && L.activate && L.generateFor));

// Penyimpanan palsu (localStorage di peramban).
function mockStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
    _map: m,
  };
}

const SECRET = 'BASARANG-2026-HUMAS-UIN-ANTASARI-BANJARMASIN';
const MID = 'a'.repeat(64); // machineId uji (64 heks)

// Implementasi acuan independen (persis tools/generate-license.mjs).
function refCode(machineId, expiresAt) {
  const expiryStr = new Date(expiresAt).getTime().toString(16);
  const hash = createHash('sha256').update(`${machineId}:monthly:${expiryStr}:${SECRET}`).digest('hex');
  const c = hash.substring(0, 16).toUpperCase();
  return `${c.slice(0, 4)}-${c.slice(4, 8)}-${c.slice(8, 12)}-${c.slice(12, 16)}`;
}
function expiryIn(days, offsetDays = 0) {
  const d = new Date();
  d.setDate(d.getDate() + (days + offsetDays));
  d.setHours(23, 59, 59, 0);
  return d;
}

// ---------- 1. Pembuatan & format kode ----------
console.log('— Pembuatan & format kode aktivasi —');
{
  const code = await L._test.expectedCode(MID, 'monthly', expiryIn(30).toISOString());
  check('format kode XXXX-XXXX-XXXX-XXXX (16 heks)', /^[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}$/.test(code), code);
  const code2 = await L._test.expectedCode(MID, 'monthly', expiryIn(30).toISOString());
  check('deterministik (input sama → kode sama)', code === code2);
  check('identik dengan implementasi acuan (tools/generate-license.mjs)', code === refCode(MID, expiryIn(30).toISOString()));
  check('machineId berbeda → kode berbeda', code !== (await L._test.expectedCode('b'.repeat(64), 'monthly', expiryIn(30).toISOString())));
}

// ---------- 2. Verifikasi kode ----------
console.log('— Verifikasi kode (jendela 45 hari) —');
{
  const exp = expiryIn(0); // hari ini 23:59:59
  const code = await L._test.expectedCode(MID, 'monthly', exp.toISOString());
  const v = await L._test.verifyCode(MID, code);
  check('kode hari-ini diterima → tipe monthly + kedaluwarsa tepat', !!(v && v.licenseType === 'monthly' && v.expiresAt === exp.toISOString()), JSON.stringify(v));

  const exp30 = expiryIn(30);
  const v30 = await L._test.verifyCode(MID, refCode(MID, exp30.toISOString()));
  check('kode +30 hari diterima', !!v30 && v30.expiresAt === exp30.toISOString());

  const exp45 = expiryIn(45);
  check('kode +45 hari (batas jendela) diterima', !!(await L._test.verifyCode(MID, refCode(MID, exp45.toISOString()))));

  const exp46 = expiryIn(46);
  check('kode +46 hari (di luar jendela) DITOLAK', (await L._test.verifyCode(MID, refCode(MID, exp46.toISOString()))) === null);

  check('kode kemarin (kedaluwarsa) DITOLAK', (await L._test.verifyCode(MID, refCode(MID, expiryIn(-1).toISOString()))) === null);
  check('machineId lain DITOLAK', (await L._test.verifyCode('c'.repeat(64), code)) === null);
  check('format pendek DITOLAK', L._test.normalizeCode('ABCD-EFGH-IJKL') === null);
  check('karakter non-heks DITOLAK', L._test.normalizeCode('GGGG-EEEE-AAAA-BBBB') === null);
  check('normalisasi tanpa tanda hubung OK', L._test.normalizeCode('abcd1234ef015678') === 'ABCD-1234-EF01-5678');
}

// ---------- 3. Status & aktivasi ----------
console.log('— Status & aktivasi (penyimpanan palsu) —');
{
  const st = mockStorage();
  L._test.setStorage(st);
  L._test.setMachineId(MID);

  const s0 = await L.status();
  check('tanpa lisensi: isValid=false, isExpired=true', s0.isValid === false && s0.isExpired === true);
  check('tanpa lisensi: firstRun tercatat (ISO)', typeof s0.firstRunDate === 'string' && s0.firstRunDate.includes('T'));
  check('tanpa lisensi: machineId & display 12-heks tampil', s0.machineId === MID && /^[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}$/.test(s0.displayMachineId));

  const bad = await L.activate('ZZZZ-YYYY-XXXX-WWWW');
  check('aktivasi kode salah → gagal + pesan jelas', bad.success === false && /tidak valid/i.test(bad.error || ''));

  const code = refCode(MID, expiryIn(30).toISOString());
  const act = await L.activate(code.replace(/-/g, '')); // tanpa tanda hubung pun harus jalan
  check('aktivasi sukses (kode tanpa tanda hubung)', act.success === true && act.licenseType === 'monthly');
  check('kedaluwarsa aktivasi = 30 hari (23:59:59)', act.expiresAt === expiryIn(30).toISOString());

  const s1 = await L.status();
  check('status pasca-aktivasi: valid, ~30 hari, tipe monthly', s1.isValid === true && s1.daysRemaining >= 30 && s1.daysRemaining <= 31 && s1.licenseType === 'monthly', 'days=' + s1.daysRemaining);
  check('status pasca-aktivasi: bukan grace', s1.isGracePeriod === false);

  const raw = JSON.parse(st.getItem('basarang.license.data'));
  check('data lisensi tersimpan dengan signature HMAC 64-heks', /^[a-f0-9]{64}$/.test(raw.signature));
  check('data tersimpan memuat machineId + kode terformat', raw.machineId === MID && raw.activationCode === code);

  // "Reload" — penyimpanan sama, machineId dihitung ulang dari ANDROID_ID.
  L._test.setMachineId(null);
  globalThis.NativeDevice = { deviceId: () => 'cafebabedeadbeef' };
  const s2 = await L.status();
  check('reload: machineId SHA-256 dari ANDROID_ID jembatan native', s2.machineId === createHash('sha256').update('android:cafebabedeadbeef').digest('hex'));
  delete globalThis.NativeDevice;
}

// ---------- 4. Anti utak-atik ----------
console.log('— Anti utak-atik data lisensi —');
{
  const st = mockStorage();
  L._test.setStorage(st);
  L._test.setMachineId(MID);
  await L.activate(refCode(MID, expiryIn(30).toISOString()));

  const raw = JSON.parse(st.getItem('basarang.license.data'));
  raw.expiresAt = expiryIn(365).toISOString(); // coba perpanjang sendiri
  st.setItem('basarang.license.data', JSON.stringify(raw));
  const s = await L.status();
  check('expiresAt diubah tanpa re-sign → lisensi DITOLAK', s.isValid === false && s.isExpired === true);

  st.setItem('basarang.license.data', 'bukan json');
  check('data rusak → tidak melempar, status invalid', (await L.status()).isValid === false);
}

// ---------- 5. Kedaluwarsa + grace sesi acara ----------
console.log('— Kedaluwarsa & grace sesi acara 72 jam —');
{
  // Lisensi valid hari ini → sesi acara dicatat (status() memanggil refresh).
  const st = mockStorage();
  L._test.setStorage(st);
  L._test.setMachineId(MID);
  await L.activate(refCode(MID, expiryIn(0).toISOString())); // berlaku s/d malam ini
  const sToday = await L.status();
  check('kode hari-ini: valid hari ini (bukan grace)', sToday.isValid === true && sToday.isGracePeriod === false);

  // "Besok pagi": kode kemarin tak lagi terverifikasi — grace aktif
  // (sesi acara dicatat saat boot valid hari ini).
  const tomorrow = expiryIn(-1).toISOString(); // kode utk kemarin = tak terverifikasi besok
  const raw = JSON.parse(st.getItem('basarang.license.data'));
  raw.activationCode = refCode(MID, tomorrow);
  raw.expiresAt = tomorrow;
  // Tanda tangani ulang dengan algoritma modul (signature valid — murni uji logika kedaluwarsa).
  const payload = JSON.stringify({
    machineId: raw.machineId, activationCode: raw.activationCode, licenseType: raw.licenseType,
    activatedAt: raw.activatedAt, expiresAt: raw.expiresAt,
  });
  const { createHmac } = await import('node:crypto');
  raw.signature = createHmac('sha256', SECRET).update(payload).digest('hex');
  st.setItem('basarang.license.data', JSON.stringify(raw));

  const sGrace = await L.status();
  check('kedaluwarsa + sesi acara baru → isValid via grace', sGrace.isValid === true && sGrace.isGracePeriod === true);
  check('grace: sisa jam dilaporkan (1..72)', sGrace.graceHoursRemaining >= 1 && sGrace.graceHoursRemaining <= 72, String(sGrace.graceHoursRemaining));

  // Sesi acara sudah 80 jam lama → grace habis → terkunci.
  const old = new Date(Date.now() - 80 * 3600000).toISOString();
  st.setItem('basarang.license.session', old);
  const sLock = await L.status();
  check('sesi acara >72 jam → terkunci penuh', sLock.isValid === false && sLock.isExpired === true);
  check('sesi acara kedaluwarsa dibersihkan dari penyimpanan', st.getItem('basarang.license.session') === null);
}

// ---------- 6. Mode pengembang (admin key) ----------
console.log('— Mode pengembang (generateFor + admin key) —');
{
  const adminKey = createHash('sha256').update(`${SECRET}:admin-api-key`).digest('hex').substring(0, 16).toUpperCase();
  check('adminKeyHash cocok implementasi acuan', (await L.adminKeyHash()) === adminKey);

  const wrong = await L.generateFor(MID, 'kunci-salah');
  check('admin key salah → ditolak', wrong.success === false && /tidak valid/i.test(wrong.error || ''));

  const badMid = await L.generateFor('xyz', adminKey);
  check('machineId bukan 64-heks → ditolak', badMid.success === false);

  const g = await L.generateFor(MID, adminKey.toLowerCase()); // case-insensitive
  check('generateFor sukses (admin key huruf kecil pun jalan)', g.success === true && g.data.licenseType === 'monthly');
  check('kode hasil generate terverifikasi ulang', !!(await L._test.verifyCode(MID, g.data.activationCode)));
  const v = await L._test.verifyCode(MID, g.data.activationCode);
  check('kedaluwarsa kode generate = 30 hari', v && v.expiresAt === expiryIn(30).toISOString());
}

// ---------- 7. Sidik jari web (fallback) ----------
console.log('— Sidik jari web (fallback tanpa APK) —');
{
  const nav = { userAgent: 'Mozilla/5.0 Test', platform: 'Linux armv8', hardwareConcurrency: 8, deviceMemory: 4 };
  const a = L._test.webFingerprintParts(nav, { width: 1080, height: 2400 }); // portrait
  const b = L._test.webFingerprintParts(nav, { width: 2400, height: 1080 }); // landscape
  check('rotasi layar TIDAK mengubah sidik jari (min×max)', a === b, a + ' vs ' + b);
  const c = L._test.webFingerprintParts({ ...nav, hardwareConcurrency: 6 }, { width: 1080, height: 2400 });
  check('perangkat berbeda (core beda) → sidik jari beda', a !== c);
}

L._test.reset();
console.log(`\nHasil: ${passed} lulus, ${failed} gagal`);
process.exit(failed ? 1 : 0);
