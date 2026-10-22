// index.js — entry point Worker Basarang: Bagarak Saurang
// Melayani: (1) API JSON di /api/*, (2) aset statis SPA dari assets.gen.js.

import { ensureSchema } from './db.js';
import { handleApi, HttpError, isAppOrigin } from './api.js';
import { ASSETS } from './assets.gen.js';

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' };
const IMMUTABLE = { 'cache-control': 'public, max-age=0, must-revalidate', 'x-content-type-options': 'nosniff' };

// ---------- CORS: aplikasi Android (APK) ----------
// APK menyajikan aset web dari origin lokal https://app.basarang.local dan
// memanggil API ini lintas origin hanya untuk sinkronisasi opsional. Hanya
// origin itu yang diizinkan; autentikasi memakai Bearer token (bukan cookie).
function corsHeaders(request) {
  if (!isAppOrigin(request)) return null;
  return {
    'access-control-allow-origin': 'https://app.basarang.local',
    'access-control-allow-headers': 'content-type, authorization',
    'access-control-allow-methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    'access-control-max-age': '86400',
  };
}

function withCors(request, res) {
  const ch = corsHeaders(request);
  if (!ch) return res;
  const headers = new Headers(res.headers);
  for (const [k, v] of Object.entries(ch)) headers.set(k, v);
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

function etagOf(content) {
  // FNV-1a 64-bit ringan (cukup untuk validasi cache 304, bukan keamanan)
  let h1 = 0xcbf29ce4 >>> 0;
  let h2 = 0x84222325 >>> 0;
  for (let i = 0; i < content.length; i++) {
    h1 ^= content.charCodeAt(i);
    h1 = Math.imul(h1, 0x01000193) >>> 0;
    h2 = (h2 + content.charCodeAt(i) * (i % 7 + 1)) >>> 0;
  }
  return `w-"${h1.toString(16)}-${h2.toString(16)}"`;
}

function serveAsset(request, url) {
  let path = url.pathname.replace(/\/+$/, '');
  if (path === '') path = '/';
  const asset = ASSETS[path];
  if (!asset) return null;
  const etag = etagOf(asset.body);
  const ifNoneMatch = request.headers.get('if-none-match');
  const headers = {
    ...IMMUTABLE,
    'content-type': asset.type,
    etag,
    'referrer-policy': 'same-origin',
  };
  if (ifNoneMatch && ifNoneMatch.includes(etag)) {
    return new Response(null, { status: 304, headers: { etag, 'cache-control': IMMUTABLE['cache-control'] } });
  }
  return new Response(asset.body, { status: 200, headers });
}

export default {
  async fetch(request, env) {
    try {
      await ensureSchema(env.DB);
      const url = new URL(request.url);

      if (url.pathname.startsWith('/api/')) {
        // Preflight CORS dari APK (fetch JSON + header Authorization lintas origin).
        if (request.method === 'OPTIONS') {
          return new Response(null, {
            status: 204,
            headers: {
              allow: 'OPTIONS, GET, HEAD, POST, PUT, PATCH, DELETE',
              ...corsHeaders(request),
            },
          });
        }
        return withCors(request, await handleApi(request, env, url));
      }

      if (request.method === 'GET' || request.method === 'HEAD') {
        const asset = serveAsset(request, url);
        if (asset) return asset;
        // Rute SPA memakai hash (#/...), jalur asing dialihkan ke root
        if (url.pathname !== '/') {
          return Response.redirect(new URL('/', url.origin).toString(), 302);
        }
        return serveAsset(request, new URL('/', url.origin));
      }

      return new Response(JSON.stringify({ ok: false, error: 'not_found', message: 'Tidak ditemukan.' }), {
        status: 404,
        headers: JSON_HEADERS,
      });
    } catch (e) {
      if (e instanceof HttpError) {
        return new Response(JSON.stringify({ ok: false, error: e.code, message: e.message }), {
          status: e.status,
          headers: JSON_HEADERS,
        });
      }
      // Batas kuota tulis harian D1 (paket gratis, level AKUN) tercapai — gangguan
      // SEMENTARA yang pulih otomatis tiap midnight UTC (07.00 WIB). Dipetakan ke
      // 503 + kode db_write_limited agar klien menyimpan perubahan di perangkat
      // dan mencoba ulang otomatis, bukan membuangnya.
      const emsg = String((e && e.message) || '');
      if (/exceeded D1/i.test(emsg) || /daily row write limit/i.test(emsg)) {
        const now = new Date();
        const reset = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
        const retrySec = Math.max(60, Math.ceil((reset - now.getTime()) / 1000));
        return new Response(
          JSON.stringify({
            ok: false,
            error: 'db_write_limited',
            message:
              'Kuota tulis basis data harian habis (batas paket gratis Cloudflare). Pulih otomatis pukul 07.00 WIB — silakan coba lagi nanti.',
          }),
          { status: 503, headers: { ...JSON_HEADERS, 'retry-after': String(retrySec) } }
        );
      }
      console.error('Unhandled error:', e && e.stack ? e.stack : String(e));
      return new Response(
        JSON.stringify({ ok: false, error: 'server_error', message: 'Terjadi kesalahan server. Coba lagi.' }),
        { status: 500, headers: JSON_HEADERS }
      );
    }
  },
};
