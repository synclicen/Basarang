# Basarang — APK Offline (Android)

APK Android **sepenuhnya offline** dari aplikasi web Basarang: Bagarak Saurang.
Tidak ada koneksi internet sama sekali — seluruh aset web dibundel di dalam APK
dan backend API digantikan oleh `www/offline.js` yang berjalan di dalam WebView.

## Arsitektur singkat

- `src/com/fajrianor/basarang/MainActivity.java` — WebView yang melayani aset
  dari `assets/www/` melalui interceptor permintaan pada domain virtual
  `https://appassets.androidplatform.net` (diperlakukan Chromium sebagai asal
  yang aman, sehingga localStorage, WebCrypto/PBKDF2, dan getUserMedia bekerja).
- `www/offline.js` — port seluruh endpoint API (dari `src/api.js` + `auth.js`)
  ke sisi klien: data di localStorage, sandi PBKDF2-SHA256 15.000 iterasi
  (format identik dengan server), sesi 30 hari, rate-limit login, dsb.
  Juga: cermin localStorage ke file internal (`/_seed.js` + `AndroidBridge`)
  agar data selamat bila profil WebView dibersihkan sistem; penyimpanan hasil
  rekaman `blob:` ke folder Unduhan (berpotongan 256 KB, aman untuk video
  besar); layar tetap menyala saat teleprompter terbuka.
- Izin: `CAMERA`, `RECORD_AUDIO` (pratinjau + rekaman teleprompter) — keduanya
  opsional (`uses-feature required=false`).

## Build

Prasyarat: Java 11+ (hanya JRE + ECJ), build-tools Android 34, platform
android-34, zip, python3 (PIL untuk ikon).

```bash
# 1) Toolchain (di luar repo, cukup sekali):
#    https://dl.google.com/android/repository/build-tools_r34-linux.zip  -> ekstrak ke android-sdk/android-14
#    https://dl.google.com/android/repository/platform-34-ext7_r03.zip   -> ekstrak ke android-sdk/android-34
#    ECJ (pengganti javac, cukup JRE):
#    https://repo1.maven.org/maven2/org/eclipse/jdt/ecj/3.36.0/ecj.jar  -> android-sdk/ecj.jar

# 2) Build (sinkron public/ -> assets, aapt2 -> ECJ -> d8 -> zip -> zipalign -> apksigner):
cd android && ./build-apk.sh
# Hasil: /home/z/my-project/download/Basarang-offline-1.0.apk
```

Skrip memverifikasi otomatis di akhir: `apksigner verify` (wajib v1+v2+v3
`true`), `aapt2 dump badging`, dan `resources.arsc` harus **Stored**
(syarat targetSdk 30+ — inilah penyebab umum error "paket invalid").

## Keystore — PENTING

`basarang-release.keystore` berada di luar repo (folder rahasia sandbox).
**Pembaruan APK berikutnya wajib ditandatangani kunci yang sama** — jika kunci
hilang, pengguna harus meng-uninstall sebelum memasang versi baru (data hilang).
Simpan baik-baik: keystore + sandinya.

## Keterbatasan yang disengaja

- Mode "Ikut Suara" butuh SpeechRecognition yang hanya ada di Chrome/Edge —
  di WebView tidak tersedia; aplikasi otomatis jatuh ke mode Timer dengan
  pemberitahuan (perilaku sama seperti Firefox/Safari).
- Data bersifat lokal per perangkat; tidak sinkron dengan situs produksi
  (https://basarang.synclicen.workers.dev) karena memang tanpa jaringan.
