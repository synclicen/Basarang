// license.js — Sistem lisensi Basarang (port dari sistem lisensi ARAY,
// Level 1: Offline Activation — https://github.com/synclicen/ARAY).
//
// Cara kerja (identik dengan ARAY):
//   1. Saat pertama dibuka, aplikasi menghitung Machine ID dari identitas
//      perangkat dan menampilkannya kepada pengguna.
//   2. Pengguna mengirim Machine ID tersebut ke pengembang (WhatsApp/dll).
//   3. Pengembang menjalankan tools/generate-license.mjs → menghasilkan
//      Kode Aktivasi berbentuk XXXX-XXXX-XXXX-XXXX.
//   4. Pengguna memasukkan kode → aplikasi memverifikasi kecocokan kode
//      terhadap Machine ID perangkat ini (100% offline, tanpa server).
//   5. Bila valid, data lisensi ditandatangani HMAC dan disimpan di
//      perangkat; setiap kali dibuka, lisensi diverifikasi ulang.
//
// Lisensi bulanan: setiap kode berlaku 30 hari sejak tanggal dibuat,
// setelah itu pengguna meminta kode baru ke pengembang.
//
// Keamanan (Level 1 — obfuscation, sama seperti ARAY):
//   - Machine ID = SHA-256 identitas perangkat (APK: ANDROID_ID via
//     jembatan NativeDevice — stabil terhadap rotasi, bahasa, zona waktu,
//     dan pembaruan WebView; di luar APK: sidik jari peramban yang
//     dinormalisasi agar kebal rotasi layar).
//   - Kode Aktivasi = SHA-256(machineId : tipe : kedaluwarsa : SECRET)
//   - Data lisensi bertanda tangan HMAC-SHA256 (anti utak-atik localStorage)
//   - Event Session Lock: 72 jam sejak sesi pertama valid — teleprompter
//     TIDAK mati di tengah acara walau lisensi berakhir.
//
// Hanya aktif di mode perangkat (APK / ?lokal=1) — situs web tetap memakai
// akun username & kata sandi biasa.

(function (global) {
  'use strict';

  // PENTING: secret yang sama harus dipakai tools/generate-license.mjs.
  var SECRET = 'BASARANG-2026-HUMAS-UIN-ANTASARI-BANJARMASIN';

  var K_DATA = 'basarang.license.data';
  var K_FIRST = 'basarang.license.firstrun';
  var K_SESSION = 'basarang.license.session';

  var VALID_DAYS = 30;            // lisensi bulanan: 30 hari
  var VERIFY_WINDOW_DAYS = 45;    // jendeda verifikasi: hari ini s/d +45 hari
  var EVENT_GRACE_HOURS = 72;     // grace sesi acara (port ARAY v4.6.8)
  var CODE_LEN = 16;              // 16 karakter hex tanpa tanda hubung

  // Penyimpanan — localStorage di peramban; bisa disuntik untuk pengujian.
  var store = null;
  try {
    if (typeof localStorage !== 'undefined') store = localStorage;
  } catch (e) { /* kuota/blocked — status lisensi akan selalu "tidak ada" */ }

  // ---------- Web Crypto helpers ----------

  function toHex(buf) {
    var b = new Uint8Array(buf), out = '';
    for (var i = 0; i < b.length; i++) out += (b[i] < 16 ? '0' : '') + b[i].toString(16);
    return out;
  }

  function sha256Hex(input) {
    var buf = new TextEncoder().encode(input);
    return crypto.subtle.digest('SHA-256', buf).then(toHex);
  }

  function hmacSha256Hex(secret, input) {
    var keyBuf = new TextEncoder().encode(secret);
    return crypto.subtle
      .importKey('raw', keyBuf, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
      .then(function (key) {
        return crypto.subtle.sign('HMAC', key, new TextEncoder().encode(input));
      })
      .then(toHex);
  }

  // ---------- Machine ID ----------
  // APK: ANDROID_ID dari jembatan native (stabil: tidak berubah oleh rotasi,
  // ganti bahasa, zona waktu, atau pembaruan WebView; hanya reset pabrik).
  // Peramban: sidik jari lingkungan — memakai min×max resolusi agar kebal
  // rotasi layar, dan TIDAK memakai zona waktu/bahasa agar tak berubah saat
  // pengguna bepergian atau mengganti pengaturan sistem.

  function webFingerprintParts(nav, scr) {
    var n = nav || {};
    var s = scr || {};
    var w = Math.max(Number(s.width) || 0, Number(s.height) || 0);
    var h = Math.min(Number(s.width) || 0, Number(s.height) || 0);
    return [
      String(n.userAgent || 'unknown-ua'),
      String(n.platform || 'unknown-platform'),
      String(n.hardwareConcurrency || 0),
      String(n.deviceMemory || 0),
      w + 'x' + h,
    ].join('|');
  }

  function nativeDeviceRawId() {
    try {
      var nd = global.NativeDevice;
      if (nd && typeof nd.deviceId === 'function') {
        var id = nd.deviceId();
        if (id && /^[0-9a-f]{8,64}$/i.test(String(id))) return String(id).toLowerCase();
      }
    } catch (e) { /* jembatan tak tersedia */ }
    return null;
  }

  var _machineId = null;

  function machineId() {
    if (_machineId) return Promise.resolve(_machineId);
    var raw = nativeDeviceRawId();
    var p = raw
      ? sha256Hex('android:' + raw)
      : sha256Hex(webFingerprintParts(typeof navigator !== 'undefined' ? navigator : null,
          typeof screen !== 'undefined' ? screen : null));
    return p.then(function (id) {
      _machineId = id;
      return id;
    });
  }

  function displayMachineId(id) {
    var short = String(id || '').substring(0, 12).toUpperCase();
    return short.slice(0, 4) + '-' + short.slice(4, 8) + '-' + short.slice(8, 12);
  }

  // ---------- Kode aktivasi ----------
  // Kode = 16 karakter pertama SHA-256(machineId:tipe:kedaluwarsaHex:SECRET),
  // ditulis berkelompok 4 dengan tanda hubung: XXXX-XXXX-XXXX-XXXX.

  function expectedCode(mid, licenseType, expiresAt) {
    var expiryStr = expiresAt ? new Date(expiresAt).getTime().toString(16) : '0';
    return sha256Hex(mid + ':' + licenseType + ':' + expiryStr + ':' + SECRET).then(function (hash) {
      var code = hash.substring(0, CODE_LEN).toUpperCase();
      return code.slice(0, 4) + '-' + code.slice(4, 8) + '-' + code.slice(8, 12) + '-' + code.slice(12, 16);
    });
  }

  function normalizeCode(input) {
    var s = String(input || '').replace(/[-\s]/g, '').toUpperCase();
    if (s.length !== CODE_LEN || !/^[0-9A-F]+$/.test(s)) return null;
    return s.slice(0, 4) + '-' + s.slice(4, 8) + '-' + s.slice(8, 12) + '-' + s.slice(12, 16);
  }

  // Cek hari ini s/d 45 hari ke depan (tiap hari jam 23:59:59) — sama seperti
  // ARAY. Kode untuk tanggal kemarin (= kedaluwarsa) otomatis tak cocok.
  function verifyCode(mid, activationCode) {
    var formatted = normalizeCode(activationCode);
    if (!formatted) return Promise.resolve(null);
    var now = new Date();
    var chain = Promise.resolve(null);
    var _loop = function (dayOffset) {
      chain = chain.then(function (found) {
        if (found) return found;
        var date = new Date(now);
        date.setDate(date.getDate() + dayOffset);
        date.setHours(23, 59, 59, 0);
        return expectedCode(mid, 'monthly', date.toISOString()).then(function (code) {
          return formatted === code ? { licenseType: 'monthly', expiresAt: date.toISOString() } : null;
        });
      });
    };
    for (var dayOffset = 0; dayOffset <= VERIFY_WINDOW_DAYS; dayOffset++) _loop(dayOffset);
    return chain;
  }

  // ---------- Tanda tangan data lisensi (anti utak-atik) ----------

  function signData(d) {
    var payload = JSON.stringify({
      machineId: d.machineId,
      activationCode: d.activationCode,
      licenseType: d.licenseType,
      activatedAt: d.activatedAt,
      expiresAt: d.expiresAt,
    });
    return hmacSha256Hex(SECRET, payload);
  }

  function verifySig(d) {
    return signData(d).then(function (expected) {
      if (!d.signature || expected.length !== d.signature.length) return false;
      var diff = 0; // perbandingan waktu-konstan
      for (var i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ d.signature.charCodeAt(i);
      return diff === 0;
    });
  }

  function readData() {
    return Promise.resolve().then(function () {
      var raw = store ? store.getItem(K_DATA) : null;
      if (!raw) return null;
      var d;
      try { d = JSON.parse(raw); } catch (e) { return null; }
      if (!d || typeof d !== 'object') return null;
      return verifySig(d).then(function (ok) {
        if (!ok) return null; // signature tak cocok = data dipalsukan
        return d;
      });
    });
  }

  function writeData(d) {
    try {
      store.setItem(K_DATA, JSON.stringify(d));
      return true;
    } catch (e) {
      return false;
    }
  }

  function firstRunDate() {
    try {
      return store.getItem(K_FIRST) || null;
    } catch (e) {
      return null;
    }
  }

  function recordFirstRun() {
    var now = new Date().toISOString();
    try {
      store.setItem(K_FIRST, now);
    } catch (e) { /* abaikan */ }
    return now;
  }

  // ---------- Event Session Lock (port ARAY v4.6.8 + v4.7.1) ----------
  // Sesi acara dimulai saat lisensi pertama kali valid; selama 72 jam sejak
  // itu aplikasi TETAP terbuka walau lisensi berakhir — mencegah teleprompter
  // mati di tengah acara. Dipersist supaya bertahan restart aplikasi.

  function sessionLoad() {
    return Promise.resolve().then(function () {
      var raw = null;
      try { raw = store ? store.getItem(K_SESSION) : null; } catch (e) { raw = null; }
      if (!raw) return null;
      var elapsed = Date.now() - new Date(raw).getTime();
      if (elapsed < EVENT_GRACE_HOURS * 3600000) return raw;
      try { store.removeItem(K_SESSION); } catch (e) { /* abaikan */ }
      return null;
    });
  }

  function startEventSession() {
    return sessionLoad().then(function (existing) {
      if (existing) return existing;
      var now = new Date().toISOString();
      try { store.setItem(K_SESSION, now); } catch (e) { /* abaikan */ }
      return now;
    });
  }

  // Perbarui penanda sesi acara ke SEKARANG — dipanggil setiap kali lisensi
  // benar-benar valid (bukan grace). Dengan begitu "72 jam sejak sesi acara"
  // berarti 72 jam sejak BOOT VALID terakhir: lisensi yang berakhir tepat
  // sebelum/di tengah acara tetap membuka aplikasi selama 3 hari (perbaikan
  // atas implementasi ARAY yang penandanya hanya ditulis sekali sehingga
  // grace nyaris tak pernah aktif). Boot saat grace TIDAK memperpanjang apa pun.
  function refreshEventSession() {
    try { store.setItem(K_SESSION, new Date().toISOString()); } catch (e) { /* abaikan */ }
  }

  function eventSessionActive() {
    return sessionLoad().then(function (at) { return !!at; });
  }

  // ---------- Status ----------

  function status() {
    return Promise.all([machineId(), readData(), Promise.resolve(firstRunDate())]).then(function (r) {
      var mid = r[0], data = r[1], frd = r[2];
      var base = {
        machineId: mid,
        displayMachineId: displayMachineId(mid),
        firstRunDate: frd,
      };
      if (!data) {
        var fr = frd || recordFirstRun();
        return {
          isValid: false, isGracePeriod: false, isExpired: true,
          daysRemaining: 0, graceHoursRemaining: 0, licenseType: null,
          expiresAt: null, activatedAt: null,
          machineId: mid, displayMachineId: base.displayMachineId, firstRunDate: fr,
        };
      }
      return verifyCode(mid, data.activationCode).then(function (verification) {
        if (!verification) {
          // Kode tak lagi terverifikasi — tanggal kedaluwarsa sudah lewat.
          // Cek sesi acara: 72 jam sejak boot-valid terakhir masih membuka
          // aplikasi (mencegah teleprompter mati di tengah acara).
          return eventSessionActive().then(function (graceOn) {
            if (graceOn) {
              return sessionLoad().then(function (at) {
                var hours = Math.max(1, Math.ceil(
                  (EVENT_GRACE_HOURS * 3600000 - (Date.now() - new Date(at).getTime())) / 3600000
                ));
                return {
                  isValid: true, isGracePeriod: true, isExpired: true,
                  daysRemaining: 0, graceHoursRemaining: hours,
                  licenseType: data.licenseType || 'monthly',
                  expiresAt: data.expiresAt || null, activatedAt: data.activatedAt || null,
                  machineId: mid, displayMachineId: base.displayMachineId, firstRunDate: frd,
                };
              });
            }
            return {
              isValid: false, isGracePeriod: false, isExpired: true,
              daysRemaining: 0, graceHoursRemaining: 0, licenseType: null,
              expiresAt: data.expiresAt || null, activatedAt: data.activatedAt || null,
              machineId: mid, displayMachineId: base.displayMachineId, firstRunDate: frd,
            };
          });
        }
        var now = new Date();
        var isExpired = data.expiresAt ? new Date(data.expiresAt) < now : true;
        var daysRemaining = data.expiresAt
          ? Math.max(0, Math.ceil((new Date(data.expiresAt).getTime() - now.getTime()) / 86400000))
          : 0;
        if (!isExpired) refreshEventSession(); // boot valid → geser jendela sesi acara
        return eventSessionActive().then(function (graceOn) {
          var active = isExpired && graceOn;
          var graceHoursRemaining = 0;
          if (active) {
            return sessionLoad().then(function (at) {
              graceHoursRemaining = Math.ceil(
                (EVENT_GRACE_HOURS * 3600000 - (Date.now() - new Date(at).getTime())) / 3600000
              );
              return {
                isValid: !isExpired || active, isGracePeriod: active, isExpired: isExpired && !active,
                daysRemaining: daysRemaining, graceHoursRemaining: graceHoursRemaining,
                licenseType: data.licenseType, expiresAt: data.expiresAt, activatedAt: data.activatedAt,
                machineId: mid, displayMachineId: base.displayMachineId, firstRunDate: frd,
              };
            });
          }
          return {
            isValid: !isExpired, isGracePeriod: false, isExpired: isExpired,
            daysRemaining: daysRemaining, graceHoursRemaining: 0,
            licenseType: data.licenseType, expiresAt: data.expiresAt, activatedAt: data.activatedAt,
            machineId: mid, displayMachineId: base.displayMachineId, firstRunDate: frd,
          };
        });
      });
    });
  }

  // ---------- Aktivasi ----------

  function activate(activationCode) {
    return machineId().then(function (mid) {
      return verifyCode(mid, activationCode).then(function (verification) {
        if (!verification) {
          return { success: false, error: 'Kode aktivasi tidak valid untuk perangkat ini.' };
        }
        if (new Date(verification.expiresAt) < new Date()) {
          return { success: false, error: 'Kode aktivasi sudah kedaluwarsa. Hubungi pengembang untuk kode baru.' };
        }
        var formatted = normalizeCode(activationCode);
        var d = {
          machineId: mid,
          activationCode: formatted,
          licenseType: verification.licenseType,
          activatedAt: new Date().toISOString(),
          expiresAt: verification.expiresAt,
          signature: '',
        };
        return signData(d).then(function (sig) {
          d.signature = sig;
          if (!writeData(d)) {
            return { success: false, error: 'Gagal menyimpan data lisensi di perangkat.' };
          }
          // Sesi acara dimulai sekarang (grace 72 jam melindungi acara berjalan).
          return startEventSession().then(function () {
            return { success: true, licenseType: verification.licenseType, expiresAt: verification.expiresAt };
          });
        });
      });
    });
  }

  // ---------- Generator kode (mode pengembang) ----------
  // Dipakai pengembang untuk menerbitkan kode langsung dari perangkat mana
  // pun (port "Developer Mode" ARAY). Dilindungi Admin Key.

  function adminKeyHash() {
    return sha256Hex(SECRET + ':admin-api-key').then(function (h) {
      return h.substring(0, CODE_LEN).toUpperCase();
    });
  }

  function generateFor(mid, adminKey) {
    return adminKeyHash().then(function (expected) {
      if (String(adminKey || '').toUpperCase() !== expected) {
        return { success: false, error: 'Admin key tidak valid. Akses ditolak.' };
      }
      if (!mid || !/^[a-f0-9]{64}$/i.test(mid)) {
        return {
          success: false,
          error: 'Machine ID tidak valid. Harus 64 karakter heksadesimal (diterima: ' + (mid ? mid.length : 0) + ').',
        };
      }
      var expiresAt = new Date();
      expiresAt.setDate(expiresAt.getDate() + VALID_DAYS);
      expiresAt.setHours(23, 59, 59, 0);
      return expectedCode(mid, 'monthly', expiresAt.toISOString()).then(function (code) {
        return {
          success: true,
          data: {
            machineId: mid,
            displayMachineId: displayMachineId(mid),
            licenseType: 'monthly',
            activationCode: code,
            expiresAt: expiresAt.toISOString(),
            daysRemaining: VALID_DAYS,
          },
        };
      });
    });
  }

  // ---------- Ekspor ----------

  global.BasarangLicense = {
    version: '1.0',
    VALID_DAYS: VALID_DAYS,
    VERIFY_WINDOW_DAYS: VERIFY_WINDOW_DAYS,
    EVENT_GRACE_HOURS: EVENT_GRACE_HOURS,
    machineId: machineId,
    displayMachineId: displayMachineId,
    status: status,
    activate: activate,
    generateFor: generateFor,
    adminKeyHash: adminKeyHash,
    startEventSession: startEventSession,
    // Hook pengujian (Node — scripts/test-license.mjs). Bukan bagian dari
    // kontrak publik; hanya menyuntik penyimpanan/machineId palsu.
    _test: {
      setStorage: function (mock) { store = mock; },
      reset: function () { store = null; _machineId = null; },
      setMachineId: function (id) { _machineId = id || null; },
      expectedCode: expectedCode,
      verifyCode: verifyCode,
      normalizeCode: normalizeCode,
      webFingerprintParts: webFingerprintParts,
      keys: { data: K_DATA, first: K_FIRST, session: K_SESSION },
    },
  };
})(typeof window !== 'undefined' ? window : globalThis);
