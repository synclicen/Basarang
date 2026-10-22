// sw.js — Service Worker Basarang: membuat aplikasi tetap BISA DIBUKA saat offline.
// Prinsip:
//   - App shell (index.html, JS, CSS, ikon) di-precache saat install → layar
//     aplikasi selalu bisa dimuat walau tanpa jaringan.
//   - Dokumen: network-first (pembaruan langsung saat online), fallback cache.
//   - Aset statis: stale-while-revalidate (instan dari cache, disegarkan di latar).
//   - /api/* dan semua tulisan (POST/PUT/…): selalu jaringan — data luring
//     ditangani app.js lewat localStorage (draf + antrean sinkron + cache naskah),
//     bukan lewat cache service worker.
// Naikkan VERSION saat rilis agar cache shell lama dibuang dan diganti.
const VERSION = 'v1.3.0';
const SHELL_CACHE = 'basarang-shell-' + VERSION;
const SHELL_FILES = ['/', '/style.css', '/app.js', '/align.js', '/license.js', '/prompter.js', '/favicon.svg'];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches
      .open(SHELL_CACHE)
      .then((c) => c.addAll(SHELL_FILES))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((k) => k.indexOf('basarang-shell-') === 0 && k !== SHELL_CACHE)
            .map((k) => caches.delete(k))
        )
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return; // tulisan: jaringan saja (antrean di app.js)
  const url = new URL(req.url);
  if (url.origin !== location.origin) return; // lintas origin: biarkan peramban
  if (url.pathname.indexOf('/api/') === 0) return; // API: jaringan saja

  if (req.mode === 'navigate') {
    // Dokumen: network-first; saat luring jatuh ke shell tersimpan.
    e.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches
            .open(SHELL_CACHE)
            .then((c) => c.put('/', copy))
            .catch(() => {});
          return res;
        })
        .catch(() =>
          caches
            .open(SHELL_CACHE)
            .then((c) => c.match('/'))
            .then((r) => r || new Response('<h1>Offline</h1>', { headers: { 'content-type': 'text/html; charset=utf-8' }, status: 200 }))
        )
    );
    return;
  }

  // Aset statis: stale-while-revalidate.
  e.respondWith(
    caches.open(SHELL_CACHE).then((c) =>
      c.match(req).then((hit) => {
        const net = fetch(req)
          .then((res) => {
            if (res && res.ok) c.put(req, res.clone());
            return res;
          })
          .catch(() => null);
        return hit
          ? hit
          : net.then((r) => r || new Response('', { status: 504, statusText: 'Offline' }));
      })
    )
  );
});
