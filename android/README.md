# Basarang — Aplikasi Android (APK)

Cangkang Android native untuk Basarang: Bagarak Saurang — AI Teleprompter
(Pusat Humas dan Keterbukaan Informasi, UIN Antasari Banjarmasin).

Aplikasi **membundel seluruh aset web di dalam paket** (`assets/www`, disalin
dari `public/` saat build) dan menyajikannya dari origin virtual
`https://app.basarang.local` — 100% offline, tanpa memuat apa pun dari internet.
Sejak **v1.3.0**, APK memakai **sistem lisensi bulanan** (port dari
[ARAY](https://github.com/synclicen/ARAY)) dan **tanpa login** username/kata
sandi (lihat "Sistem Lisensi" di bawah).

## Sistem Lisensi (v1.3.0 — port dari ARAY)

Login username/kata sandi tidak cocok untuk APK; sebagai gantinya dipakai
**lisensi perangkat bulanan** dengan alur identik ARAY (Level 1: Offline
Activation):

1. Saat pertama dibuka setelah instal, aplikasi menampilkan **halaman
   lisensi** berisi **Machine ID** perangkat (64 heksadesimal) + tombol Salin.
2. Pengguna mengirim Machine ID ke pengembang (WhatsApp dsb.).
3. Pengembang menerbitkan **Kode Aktivasi** `XXXX-XXXX-XXXX-XXXX`:
   ```bash
   node tools/generate-license.mjs <machineId>   # berlaku 30 hari
   node tools/generate-license.mjs --admin-key   # Admin Key utk mode pengembang
   ```
4. Pengguna memasukkan kode → aplikasi memverifikasi **sepenuhnya offline**
   (SHA-256 machineId + tipe + kedaluwarsa + SECRET) → langsung masuk
   aplikasi **tanpa akun, tanpa login** (akun lokal dibuat otomatis).
5. Setiap pembukaan aplikasi memverifikasi ulang lisensi. **Lisensi berlaku
   30 hari**; setelah itu pengguna meminta kode baru.

Detail teknis:

- **Machine ID stabil**: `MainActivity` menyediakan jembatan `NativeDevice`
  yang membaca `ANDROID_ID` (stabil terhadap rotasi, bahasa, zona waktu, dan
  pembaruan WebView; hanya reset pabrik yang mengganti). Di luar APK
  (`localhost?lokal=1` untuk pengujian) memakai sidik jari peramban yang sudah
  dinormalisasi min×max agar kebal rotasi layar.
- **Anti utak-atik**: data lisensi di localStorage ditandatangani HMAC-SHA256;
  mengubah `expiresAt` tanpa re-sign membuat lisensi tidak valid.
- **Grace sesi acara 72 jam**: penanda sesi diperbarui setiap boot dengan
   lisensi valid — bila lisensi berakhir tepat sebelum/saat acara, aplikasi
   tetap terbuka selama 72 jam sejak boot valid terakhir (teleprompter tidak
   mati di tengah acara; perbaikan kecil atas ARAY yang penandanya hanya
   ditulis sekali).
- **Mode Pengembang** di halaman lisensi: pengembang bisa menerbitkan kode
   langsung dari perangkat mana pun dengan Admin Key
   (`node tools/generate-license.mjs --admin-key` mencetak nilainya).
- Situs web (tanpa `?lokal=1`) **tidak terpengaruh** — tetap login biasa.
- Tingkat keamanan sama seperti ARAY (Level 1 — offline activation): secret
  ikut terbundel di klien, cukup untuk lisensi komersial ringan, bukan
   anti-pembajakan militer.

## Mengapa perlu cangkang native?

WebView Android **tidak menyediakan Web Speech API** (`window.SpeechRecognition`),
padahal inti Basarang adalah "naskah mengikuti suara". Solusinya:

1. `MainActivity.java` menyediakan objek **`NativeSpeech`** (via
   `addJavascriptInterface`) yang membungkus `android.speech.SpeechRecognizer`.
2. `assets/speech_shim.js` (disuntikkan setiap kali halaman selesai dimuat,
   idempoten) memasang `window.SpeechRecognition` yang berbicara lewat bridge —
   bentuk eventnya sama persis dengan Web Speech API yang dibaca
   `public/prompter.js`.
3. Bila perangkat tak punya layanan pengenalan suara (mis. tanpa Google app),
   shim diam → prompter otomatis jatuh ke mode Timer, seperti di peramban tanpa
   dukungan suara.

Fitur stabilitas lain:

- **Izin**: RECORD_AUDIO + CAMERA diminta saat aplikasi mulai; permintaan
  `getUserMedia` dari web disetujui otomatis bila izin OS sudah dipegang
  (pratinjau kamera + rekaman tetap berfungsi, termasuk fallback video-saja).
- **Rotasi aman**: `configChanges` mencegah WebView dimuat ulang saat perangkat
  diputar — sesi teleprompter/rekaman tidak terputus.
- **Offline**: kegagalan jaringan utama menampilkan `assets/offline.html`
  (tombol coba lagi + percobaan ulang otomatis tiap 15 detik).
- **Tombol kembali** menelusuri riwayat SPA; keluar aplikasi perlu tekan dua
  kali (mencegah keluar tak sengaja saat merekam).
- **Layar tetap menyala** hanya selama teleprompter terbuka (dari shim, ikut
  hash routing), hemat baterai di tampilan lain.
- **Saat aplikasi di-background**: mikrofon dilepas (privasi + baterai);
  jangan pindah aplikasi di tengah perekaman.
- localStorage aktif → login dan pengaturan prompter tersimpan.

## Kebutuhan perangkat

- Android 7.0+ (API 24)
- **Android System WebView terbaru** (auto-update dari Play Store; aplikasi
  memakai JS modern). Perangkat tanpa layanan Google hanya mendapat mode Timer.

## Build lokal (tanpa Android Studio / Gradle)

```bash
# sekali saja: pasang SDK (platform-34 + build-tools 35) + JDK dengan javac
export ANDROID_SDK_ROOT=/path/ke/android-sdk
export JAVAC=javac   # atau wrapper khusus

cd android
keytool -genkeypair -v -keystore basarang.keystore -storetype PKCS12 \
  -alias basarang -keyalg RSA -keysize 2048 -validity 9125 \
  -storepass <pass-anda> -keypass <pass-anda> \
  -dname 'CN=Basarang, OU=Humas dan Keterbukaan Informasi, O=UIN Antasari Banjarmasin, L=Banjarmasin, ST=Kalimantan Selatan, C=ID'
printf 'STORE_FILE=basarang.keystore\nSTORE_PASS=<pass-anda>\nKEY_ALIAS=basarang\nKEY_PASS=<pass-anda>\n' > keystore.properties
bash build-apk.sh      # → out/Basarang-v<versi>.apk
```

## Workflow GitHub Actions — "Basarang APK"

`.github/workflows/basarang-apk.yml` membangun APK pada setiap push ke `main`
yang menyentuh `android/**`, atau manual (tab Actions → *Basarang APK* →
*Run workflow*). Artefak bisa diunduh dari halaman run.

**Penandatanganan di CI**: secara default CI memakai kunci dev sementara.
Agar APK CI bertanda tangan sama dengan build resmi (agar bisa di-update tanpa
uninstall), tambahkan 4 *repository secrets*:

| Secret | Isi |
|---|---|
| `ANDROID_KEYSTORE_B64` | `base64 -w0 basarang.keystore` dari file resmi |
| `ANDROID_STORE_PASS` | sandi keystore |
| `ANDROID_KEY_ALIAS` | `basarang` |
| `ANDROID_KEY_PASS` | sandi kunci |

**Kunci resmi TIDAK dikomit ke repo** (repo ini publik!). Simpan salinan
`basarang.keystore` + sandinya di tempat aman tim Humas — kehilangan kunci
berarti pembaruan harus di-install ulang manual oleh semua pengguna.

## Naik versi

Edit `android/AndroidManifest.xml`: `android:versionCode` (naikkan +1 setiap
rilis) dan `android:versionName` (mis. `1.1.0`). Nama file APK mengikuti
versionName.

## Uji otomatis

- `node android/test-shim.mjs` — kontrak bentuk event shim ↔ `prompter.js`.
- `node scripts/test-bridge.mjs` — e2e penuh di Chromium headless: login UI,
  buka prompter, mode Suara via bridge (interim+final+restart tiap ujaran),
  guliran/persentase bergerak sampai akhir, exit melepas mikrofon, mode Timer
  tetap normal.

## Instal

- Kirim `Basarang-v1.0.0.apk` ke HP → buka → izinkan "instal dari sumber
  tidak dikenal" untuk aplikasi pembuka file itu.
- Atau: `adb install -r Basarang-v1.0.0.apk`.
- Pembaruan: install APK baru dengan **tanda tangan yang sama** di atas versi
  lama (tanpa uninstall).
