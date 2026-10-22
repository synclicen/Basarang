#!/usr/bin/env node
// generate-license.mjs — Basarang License Generator (port tools/generate-license.ts ARAY)
//
// Cara pakai:
//   node tools/generate-license.mjs <machineId>          # kode aktivasi 30 hari
//   node tools/generate-license.mjs --admin-key          # cetak Admin Key (mode pengembang)
//
// <machineId> = 64 karakter heksadesimal yang tampil di halaman lisensi APK
// (pengguna menekan "Salin" lalu mengirinya ke pengembang).
//
// Algoritma identik dengan public/license.js:
//   activationCode = SHA256(machineId:monthly:expiryHex:SECRET)[0:16].toUpperCase()
//   → diformat XXXX-XXXX-XXXX-XXXX

import { createHash } from 'node:crypto';

const SECRET = 'BASARANG-2026-HUMAS-UIN-ANTASARI-BANJARMASIN';
const VALID_DAYS = 30;

function generateExpectedCode(machineId, licenseType, expiresAt) {
  const expiryStr = new Date(expiresAt).getTime().toString(16);
  const input = `${machineId}:${licenseType}:${expiryStr}:${SECRET}`;
  const hash = createHash('sha256').update(input).digest('hex');
  const code = hash.substring(0, 16).toUpperCase();
  return `${code.slice(0, 4)}-${code.slice(4, 8)}-${code.slice(8, 12)}-${code.slice(12, 16)}`;
}

function adminKey() {
  return createHash('sha256').update(`${SECRET}:admin-api-key`).digest('hex').substring(0, 16).toUpperCase();
}

function main() {
  const args = process.argv.slice(2);

  if (args[0] === '--admin-key') {
    console.log('\n========================================');
    console.log('   Basarang — Admin Key (Mode Pengembang)');
    console.log('========================================\n');
    console.log(`  ${adminKey()}\n`);
    console.log('Dipakai di halaman lisensi APK → "Mode Pengembang" untuk menerbitkan');
    console.log('kode aktivasi langsung dari perangkat. Jangan dibagikan ke pengguna.\n');
    return;
  }

  const machineId = (args[0] || '').trim().toLowerCase();
  if (!machineId) {
    console.error('Usage: node tools/generate-license.mjs <machineId>');
    console.error('       node tools/generate-license.mjs --admin-key');
    process.exit(1);
  }
  if (!/^[a-f0-9]{64}$/.test(machineId)) {
    console.error(`Machine ID tidak valid: harus 64 karakter heksadesimal (diterima ${machineId.length}).`);
    process.exit(1);
  }

  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + VALID_DAYS);
  expiresAt.setHours(23, 59, 59, 0);

  const code = generateExpectedCode(machineId, 'monthly', expiresAt.toISOString());

  console.log('\n========================================');
  console.log('       Basarang License Generator');
  console.log('========================================\n');
  console.log(`Machine ID:    ${machineId.substring(0, 24)}…`);
  console.log(`Lisensi:       Bulanan (30 hari)`);
  console.log(`Berlaku s/d:   ${expiresAt.toLocaleDateString('id-ID', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}`);
  console.log('\nKode Aktivasi:');
  console.log(`\n  >>>  ${code}  <<<\n`);
  console.log('Kirim kode ini ke pengguna untuk dimasukkan di halaman lisensi.\n');
}

main();
