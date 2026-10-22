#!/usr/bin/env bash
# build-apk.sh — pipeline APK offline Basarang (Task 27)
# Toolchain Android ASLI (build-tools 34 dari dl.google.com):
#   aapt2 → javac → d8 → paket ulang (resources.arsc STORED) → zipalign → apksigner (v1+v2+v3)
# + verifikasi ketat otomatis di akhir (apksigner verify + aapt2 badging).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"          # .../basarang/android
APP="$(cd "$ROOT/.." && pwd)"                  # .../basarang
SDK="/home/z/my-project/android-sdk"
BT="$SDK/android-14"                           # build-tools 34.0.0
PLATFORM="$SDK/android-34/android.jar"
BUILD="$ROOT/build"
ASSETS="$BUILD/assets/www"
OUT_DIR="/home/z/my-project/download"
APK_NAME="Basarang-offline-1.0.apk"
SECRETS="/home/z/my-project/.secrets"
KS="$SECRETS/basarang-release.keystore"
KSPASS_FILE="$SECRETS/basarang-keystore.pass"

echo "==> [0/8] bersih-bersih"
rm -rf "$BUILD"
mkdir -p "$ASSETS" "$BUILD/gen" "$BUILD/obj" "$BUILD/dex" "$OUT_DIR" "$SECRETS"

echo "==> [1/8] sinkron aset web dari public/ + injeksi offline.js"
cp "$APP/public/app.js" "$APP/public/align.js" "$APP/public/prompter.js" \
   "$APP/public/style.css" "$APP/public/favicon.svg" "$ASSETS/"
cp "$ROOT/www/offline.js" "$ASSETS/offline.js"
python3 - "$APP/public/index.html" "$ASSETS/index.html" <<'PY'
import sys
src, dst = sys.argv[1], sys.argv[2]
html = open(src, encoding='utf-8').read()
inject = ('<script src="/_seed.js"></script>\n'
          '<script src="/offline.js"></script>\n')
marker = '<link rel="stylesheet" href="/style.css">'
if marker not in html:
    raise SystemExit('marker index.html tidak ditemukan')
html = html.replace(marker, inject + marker, 1)
open(dst, 'w', encoding='utf-8').write(html)
print('   index.html diinjeksi (_seed.js + offline.js)')
PY

echo "==> [2/8] ikon peluncur"
python3 "$ROOT/make-icons.py"

echo "==> [3/8] aapt2 compile + link (manifest biner resmi)"
"$BT/aapt2" compile --dir "$ROOT/res" -o "$BUILD/res.zip"
"$BT/aapt2" link \
  -o "$BUILD/base.apk" \
  -I "$PLATFORM" \
  --manifest "$ROOT/AndroidManifest.xml" \
  --min-sdk-version 23 --target-sdk-version 34 \
  --version-code 1 --version-name 1.0 \
  --java "$BUILD/gen" \
  -A "$BUILD/assets" \
  "$BUILD/res.zip"
test -f "$BUILD/base.apk" || { echo "GAGAL: base.apk tidak dibuat"; exit 1; }

echo "==> [4/8] ecj (javac) + d8 (classes.dex)"
find "$ROOT/src" -name '*.java' > "$BUILD/sources.txt"
ECJ="/home/z/my-project/android-sdk/ecj.jar"
java -jar "$ECJ" -source 1.8 -target 1.8 -nowarn -encoding UTF-8 \
  -bootclasspath "$PLATFORM" \
  -d "$BUILD/obj" \
  @"$BUILD/sources.txt" || { echo "GAGAL: ecj"; exit 1; }
find "$BUILD/obj" -name '*.class' > "$BUILD/classes.txt"
"$BT/d8" --release --lib "$PLATFORM" --min-api 23 \
  --output "$BUILD/dex" $(cat "$BUILD/classes.txt")
test -f "$BUILD/dex/classes.dex" || { echo "GAGAL: classes.dex tidak dibuat"; exit 1; }

echo "==> [5/8] paket ulang: resources.arsc STORED (syarat targetSdk 30+) + classes.dex"
python3 - "$BUILD/base.apk" "$BUILD/dex/classes.dex" "$BUILD/unsigned.apk" <<'PY'
import sys, zipfile
base, dex, out = sys.argv[1], sys.argv[2], sys.argv[3]
zin = zipfile.ZipFile(base, 'r')
zout = zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED)
for item in zin.infolist():
    data = zin.read(item.filename)
    if item.filename == 'resources.arsc':
        # WAJIB: tidak terkompresi agar lolos pemeriksaan instalasi Android 11+
        zout.writestr(zipfile.ZipInfo(item.filename), data, compress_type=zipfile.ZIP_STORED)
    else:
        zout.writestr(item.filename, data, compress_type=zipfile.ZIP_DEFLATED)
zout.writestr('classes.dex', open(dex, 'rb').read(), compress_type=zipfile.ZIP_DEFLATED)
zout.close(); zin.close()
print('   unsigned.apk dirakit')
PY

echo "==> [6/8] zipalign 4 byte"
"$BT/zipalign" -f -p 4 "$BUILD/unsigned.apk" "$BUILD/aligned.apk"

echo "==> [7/8] keystore + apksigner (v1 + v2 + v3)"
if [ ! -f "$KS" ]; then
  PASS="$(python3 -c 'import secrets; print(secrets.token_hex(16))')"
  echo "$PASS" > "$KSPASS_FILE"
  chmod 600 "$KSPASS_FILE" "$KS" 2>/dev/null || true
  keytool -genkeypair -v -keystore "$KS" -alias basarang \
    -keyalg RSA -keysize 2048 -validity 10000 \
    -storepass "$PASS" -keypass "$PASS" \
    -dname "CN=Basarang Offline, OU=Humas, O=UIN Antasari Banjarmasin, L=Banjarmasin, C=ID" \
    >/dev/null 2>&1
  chmod 600 "$KS"
  echo "   keystore baru dibuat: $KS (SIMPAN BAIK-BAIK — wajib untuk pembaruan berikutnya)"
fi
KSPASS="$(cat "$KSPASS_FILE")"
"$BT/apksigner" sign \
  --ks "$KS" --ks-key-alias basarang \
  --ks-pass "pass:$KSPASS" --key-pass "pass:$KSPASS" \
  --v1-signing-enabled true --v2-signing-enabled true --v3-signing-enabled true \
  --out "$OUT_DIR/$APK_NAME" \
  "$BUILD/aligned.apk"

echo "==> [8/8] VERIFIKASI KETAT (anti 'paket invalid')"
"$BT/apksigner" verify --print-certs "$OUT_DIR/$APK_NAME" | tee "$BUILD/verify.log"
"$BT/apksigner" verify --verbose "$OUT_DIR/$APK_NAME" | tee -a "$BUILD/verify.log" | head -20
echo "--- badging ---"
"$BT/aapt2" dump badging "$OUT_DIR/$APK_NAME" | head -12
echo "--- pemeriksaan resources.arsc (harus Stored) ---"
unzip -v "$OUT_DIR/$APK_NAME" | grep -E "resources\.arsc|classes\.dex|AndroidManifest\.xml" || true
echo ""
echo "SELESAI: $OUT_DIR/$APK_NAME ($(du -h "$OUT_DIR/$APK_NAME" | cut -f1))"
