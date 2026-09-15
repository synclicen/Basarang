#!/usr/bin/env bash
# deploy.sh — deploy/update Basarang ke Cloudflare Workers + D1.
# Database D1 sudah dibuat & wrangler.toml sudah berisi database_id.
# Jalankan kapan saja setelah mengubah kode:
#
#   CLOUDFLARE_API_TOKEN=TOKEN_ANDA bash scripts/deploy.sh
#
# Token hanya dipakai via environment variable — tidak ditulis ke file mana pun.
set -euo pipefail

cd "$(dirname "$0")/.."

: "${CLOUDFLARE_API_TOKEN:?Set CLOUDFLARE_API_TOKEN. Buat di https://dash.cloudflare.com/profile/api-tokens (template: Edit Cloudflare Workers)}"

echo "→ Build aset SPA…"
node scripts/build-assets.mjs

echo "→ Uji (unit + e2e)…"
node scripts/test-align.mjs > /dev/null && echo "  ✓ unit test algoritma"
node scripts/test-local.mjs > /dev/null && echo "  ✓ e2e worker (106 asersi)"

echo "→ Deploy…"
npx -y wrangler@latest deploy

echo ""
echo "✅ Live: https://basarang.synclicen.workers.dev"
