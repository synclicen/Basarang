#!/usr/bin/env bash
# Build APK Basarang TANPA Gradle: aapt + javac + d8 + zipalign + apksigner.
# Dipakai di sandbox lokal maupun oleh workflow GitHub Actions "Basarang APK".
# Kebutuhan: JDK 8+ (javac; d8 butuh JDK 17+ bila build-tools 35), Android SDK
# dengan build-tools 35.x & platforms;android-34.
#   export ANDROID_SDK_ROOT=<sdk>   (atau ANDROID_HOME, atau ~/android-sdk)
#   export JAVAC=<javac>            (opsional; default: javac di PATH)
# Hasil: android/out/Basarang-v<versi>.apk
set -euo pipefail
cd "$(dirname "$0")"

# ---- temukan SDK ----
SDK="${ANDROID_SDK_ROOT:-${ANDROID_HOME:-}}"
if [ -z "$SDK" ]; then
  for c in "$HOME/android-sdk" "/home/z/my-project/android-tools/sdk" "/usr/local/lib/android/sdk"; do
    [ -d "$c" ] && SDK="$c" && break
  done
fi
if [ -z "$SDK" ] || [ ! -d "$SDK" ]; then
  echo "ERROR: Android SDK tidak ditemukan. Set ANDROID_SDK_ROOT." >&2
  exit 1
fi
BT="$(ls -d "$SDK"/build-tools/* 2>/dev/null | sort -V | tail -n1)"
PLAT="$(ls -d "$SDK"/platforms/android-* 2>/dev/null | sort -V | tail -n1)/android.jar"
[ -n "$BT" ] && [ -f "$PLAT" ] || { echo "ERROR: build-tools / platforms tidak lengkap di $SDK" >&2; exit 1; }
JAVAC_BIN="${JAVAC:-javac}"

VN="$(sed -n 's/.*android:versionName="\([^"]*\)".*/\1/p' AndroidManifest.xml | head -n1)"
APK_OUT="out/Basarang-v${VN:-0}.apk"

echo "== SDK   : $SDK"
echo "== Tools : $BT"
echo "== Java  : $JAVAC_BIN ($($JAVAC_BIN -version 2>&1))"

OUT=build
rm -rf "$OUT" out
mkdir -p "$OUT/classes" "$OUT/dex" "$OUT/stage/assets" out

echo "== 1/7 javac =="
find src -name '*.java' > "$OUT/sources.txt"
if ! "$JAVAC_BIN" -source 8 -target 8 -Xlint:-options -encoding UTF-8 \
      -classpath "$PLAT" -d "$OUT/classes" @"$OUT/sources.txt" > "$OUT/javac.log" 2>&1; then
  cat "$OUT/javac.log" >&2
  exit 1
fi
[ -s "$OUT/javac.log" ] && cat "$OUT/javac.log"

echo "== 2/7 d8 (dex) =="
find "$OUT/classes" -name '*.class' > "$OUT/classes.txt"
( xargs "$BT/d8" --release --lib "$PLAT" --min-api 24 --output "$OUT/dex" ) < "$OUT/classes.txt"

echo "== 3/7 aapt (paket resource) =="
"$BT/aapt" package -f -M AndroidManifest.xml -S res -I "$PLAT" -F "$OUT/unsigned.apk"

echo "== 4/7 masukkan dex + assets (termasuk aplikasi web www/) =="
cp "$OUT/dex/classes.dex" "$OUT/stage/"
# FULL OFFLINE: seluruh aplikasi web dari public/ dibundel sebagai assets/www/ —
# WebView menyajikannya dari origin https://app.basarang.local (MainActivity).
mkdir -p "$OUT/stage/assets/www"
[ -f ../public/index.html ] || { echo "ERROR: ../public/index.html tidak ditemukan — jalankan dari dalam folder android/ repo." >&2; exit 1; }
cp ../public/* "$OUT/stage/assets/www/"
[ -f "$OUT/stage/assets/www/app.js" ] || { echo "ERROR: aset web app.js tidak tersalin." >&2; exit 1; }
cp assets/* "$OUT/stage/assets/"
(
  cd "$OUT/stage"
  find assets -type f | LC_ALL=C sort > ../files.txt
  xargs "$BT/aapt" add ../unsigned.apk < ../files.txt > /dev/null
)

echo "== 5/7 zipalign =="
"$BT/zipalign" -f 4 "$OUT/unsigned.apk" "$OUT/aligned.apk"

echo "== 6/7 apksigner =="
[ -f keystore.properties ] || { echo "ERROR: keystore.properties tidak ada" >&2; exit 1; }
. ./keystore.properties
"$BT/apksigner" sign \
  --ks "$STORE_FILE" \
  --ks-key-alias "$KEY_ALIAS" \
  --ks-pass "pass:$STORE_PASS" \
  --key-pass "pass:$KEY_PASS" \
  --out "$APK_OUT" "$OUT/aligned.apk"
"$BT/apksigner" verify "$APK_OUT"

echo ""
echo "== SELESAI: $APK_OUT (full offline) =="
ls -l "$APK_OUT"
"$BT/aapt" dump badging "$APK_OUT" | head -4
unzip -l "$APK_OUT" 'assets/*' | tail -15
