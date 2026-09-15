# Basarang: Bagarak Saurang

**The AI Teleprompter that scrolls as you speak** — naskah Anda otomatis mengikuti suara, sehingga Anda bisa bicara natural, menjaga kontak mata, dan sekali take langsung jadi. Untuk rekaman maupun live.

> @2026 - Made by Fajrianor
> Pusat Humas dan Keterbukaan Informasi
> UIN Antasari Banjarmasin
>
> UNDER MY RESPONSIBILITY!

## Fitur

### AI Teleprompter (inti)
- **Mode Ikut Suara** — Web Speech API (bawaan browser, gratis) menyelaraskan naskah dengan ucapan Anda secara kata-per-kata; kata yang terucap memudar, teks menggulir menjaga posisi baca tetap di garis panduan.
- **Toleransi improvisasi** — kata di luar naskah tidak menggeser posisi; lompat kalimat ditangkap jendela lookahead; improvisasi panjang ditangani auto-resync; klik kata apa pun untuk melompat; tombol R untuk sinkron ulang dari kata yang terlihat.
- **60+ bahasa** — pengenal suara mengikuti bahasa yang dipilih peramban Anda (Indonesia, Inggris, Arab, Jawa, Sunda, dll).
- **Mode Timer** — gulir otomatis dengan kecepatan baca (KPM) yang dapat diatur, cocok untuk peramban tanpa dukungan pengenalan suara.
- **Rekam video bawaan** — MediaRecorder merekam kamera + suara sambil mempromosi, hasil .webm terunduh otomatis.
- **Kontrol presenter lengkap** — mirror horizontal/vertikal (untuk hood/pantulan), ukuran & tinggi baris teks, 3 tema (Emas Klasik / Kontras Tinggi / Perak Berpendar), panduan baris baca, hitung mundur 3-2-1, fullscreen, wake-lock, pintasan keyboard, HUD otomatis sembunyi.
- **Tanpa batas panjang naskah** — tidak ada batas demo 700 karakter; naskah hingga 100.000 karakter (~1,5 jam pidato) per naskah.

### Kolaborasi & organisasi
- **Autentikasi backend D1** — sesi disimpan di database Cloudflare D1 (cookie HttpOnly, PBKDF2-SHA256), sehingga **login dan data tersinkron lintas perangkat**: tulis naskah di laptop, presentasi dari ponsel.
- **Peran**: `super_admin` (kelola semua pengguna & melihat seluruh proyek), `manager` (membuat/mengelola proyek & anggota), `member` (presenter/penulis dalam proyek).
- **Proyek → naskah → anggota** — manager menginisiasi proyek, mengundang anggota via username, anggota menulis dan menyunting naskahnya sendiri.
- **Editor dengan autosave** — perubahan tersimpan otomatis (debounce) dengan indikator status, statistik kata & estimasi durasi.

### Keamanan
- Password PBKDF2-SHA256 25.000 iterasi + rate-limit login (10 percobaan gagal / 15 menit per username).
- Sesi token 256-bit di D1, cookie `HttpOnly; Secure; SameSite=Lax`, kedaluwarsa 30 hari.
- Anti-CSRF (origin + sec-fetch-site), semua query SQL memakai prepared statement, seluruh render klien di-escape (XSS-safe), otorisasi objek per endpoint.

## 100% Tier Gratis

| Komponen | Paket gratis | Catatan pemakaian Basarang |
|---|---|---|
| Cloudflare Workers | 100.000 permintaan/hari | 1 muat halaman ≈ 4–5 permintaan; autosave 1 tulisan per ~1,3 dtk jeda |
| Cloudflare D1 | 5 GB / 5 juta row-read/hari / 100 rb row-write/hari | 1–3 row-read per permintaan API; write hanya saat login/autosave |
| Web Speech API | Gratis, bawaan peramban | Tanpa kunci API, tanpa kuota berbayar (Chrome/Edge) |
| MediaRecorder, Fullscreen, Wake Lock | Bawaan peramban | Gratis |

Tidak ada layanan pihak ketiga berbayar sama sekali. Mode Suara membutuhkan Chrome/Edge (di Firefox/Safari otomatis beralih ke Mode Timer).

## Deploy (Cloudflare Workers + D1)

```bash
# 1. Login
npx wrangler login          # atau ekspor CLOUDFLARE_API_TOKEN

# 2. Buat database D1
npx wrangler d1 create basarang
#    salin database_id ke wrangler.toml

# 3. (Opsional) uji lokal
npm install                 # tidak diperlukan dependensi runtime
npm run build && npx wrangler dev

# 4. Deploy
npm run deploy              # = build aset + wrangler deploy
```

Skema database dibuat otomatis (self-migrate idempoten) saat Worker pertama kali menerima permintaan. Kunjungi URL `https://basarang.<subdomain>.workers.dev`, buat **Super Admin** pertama melalui layar inisialisasi, lalu tambahkan manager/member dari menu Pengguna.

## Pengembangan lokal tanpa Cloudflare

```bash
npm test
```

Menjalankan dua rangkaian uji: unit test algoritma penyelarasan ucapan↔naskah (`scripts/test-align.mjs`) dan uji end-to-end seluruh API Worker memakai mock D1 SQLite (`scripts/test-local.mjs`, 72 asersi).

## Struktur

```
├── wrangler.toml          # konfigurasi Worker + binding D1
├── schema.sql             # referensi skema (runtime self-migrate)
├── src/
│   ├── index.js           # entry: routing, aset statis (ETag/304), error mapping
│   ├── api.js             # seluruh endpoint API + validasi + RBAC
│   ├── auth.js            # PBKDF2, sesi D1, cookie, rate-limit login
│   ├── db.js              # skema idempoten + util waktu
│   └── assets.gen.js      # (dihasilkan) bundle SPA dalam satu Worker
├── public/                # SPA: index.html, style.css, app.js, prompter.js, align.js
└── scripts/               # build-assets, test-align, test-local
```

## Catatan desain

- PBKDF2 25.000 iterasi dipilih agar verifikasi tetap ~5 ms — di bawah batas CPU 10 ms/request Workers Free — dikompensasi rate-limit login. Format hash menyimpan jumlah iterasi sehingga dapat dinaikkan nanti tanpa migrasi.
- Seluruh aset frontend di-bundle sebagai modul JS tunggal: satu Worker, satu permintaan DNS, tanpa CDN eksternal (bebas limit & bebas biaya).
- Tema visual: **gold + purple haze + silver glow**; densitas compact; responsif fluid (clamp + grid auto-fill) dari ponsel kecil hingga desktop, termasuk mode lanskap pendek untuk teleprompter.
