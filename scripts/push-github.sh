#!/usr/bin/env bash
# push-github.sh — buat repo GitHub "Basarang" dan dorong kode.
# Token lama (ghp_…yRK6m) sudah tidak berlaku (GitHub memerogatif 401 Bad credentials,
# kemungkinan dicabut otomatis karena pernah terekspos). Buat token baru dengan scope
# "repo" di https://github.com/settings/tokens lalu jalankan:
#
#   GH_TOKEN=ghp_TOKEN_BARU_ANDA bash scripts/push-github.sh
#
# Token TIDAK disimpan dalam repo — hanya dipakai sekali untuk push.
set -euo pipefail

: "${GH_TOKEN:?Set GH_TOKEN dengan token GitHub baru (scope: repo). Lihat komentar di dalam skrip ini.}"

REPO_NAME="Basarang"
DESC="Basarang: Bagarak Saurang — AI Teleprompter yang mengikuti suara Anda. Cloudflare Workers + D1, 100% tier gratis."

echo "→ Memverifikasi token…"
GH_USER=$(curl -sS -f -H "Authorization: Bearer ${GH_TOKEN}" -H "Accept: application/vnd.github+json" \
  https://api.github.com/user | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).login))")
echo "  Masuk sebagai: ${GH_USER}"

echo "→ Membuat repo ${REPO_NAME} (public)…"
HTTP=$(curl -sS -o /tmp/gh_repo.json -w "%{http_code}" -X POST \
  -H "Authorization: Bearer ${GH_TOKEN}" -H "Accept: application/vnd.github+json" \
  https://api.github.com/user/repos \
  -d "{\"name\":\"${REPO_NAME}\",\"description\":\"${DESC}\",\"private\":false,\"has_wiki\":false}")
if [ "$HTTP" != "201" ] && ! grep -q '"full_name"' /tmp/gh_repo.json 2>/dev/null || [ "$HTTP" == "422" ]; then
  echo "  (mungkin repo sudah ada — lanjut push)"
fi

echo "→ Mendorong kode (main)…"
git push "https://x-access-token:${GH_TOKEN}@github.com/${GH_USER}/${REPO_NAME}.git" HEAD:main

echo ""
echo "✅ Selesai: https://github.com/${GH_USER}/${REPO_NAME}"
echo "   Token tidak tersimpan di mana pun dalam repositori."
