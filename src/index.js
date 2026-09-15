// index.js — entry point Worker Basarang: Bagarak Saurang
// Melayani: (1) API JSON di /api/*, (2) aset statis SPA dari assets.gen.js.

import { ensureSchema } from './db.js';
import { handleApi, HttpError } from './api.js';
import { ASSETS } from './assets.gen.js';

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' };
const IMMUTABLE = { 'cache-control': 'public, max-age=0, must-revalidate', 'x-content-type-options': 'nosniff' };

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
        return await handleApi(request, env, url);
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
      console.error('Unhandled error:', e && e.stack ? e.stack : String(e));
      return new Response(
        JSON.stringify({ ok: false, error: 'server_error', message: 'Terjadi kesalahan server. Coba lagi.' }),
        { status: 500, headers: JSON_HEADERS }
      );
    }
  },
};
