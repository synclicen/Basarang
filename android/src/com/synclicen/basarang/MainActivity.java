package com.synclicen.basarang;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Bitmap;
import android.net.Uri;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;
import android.speech.RecognitionListener;
import android.speech.RecognizerIntent;
import android.speech.SpeechRecognizer;
import android.webkit.JavascriptInterface;
import android.webkit.PermissionRequest;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;

/**
 * Basarang: Bagarak Saurang — aplikasi Android FULL OFFLINE.
 *
 * Seluruh aplikasi web (HTML/JS/CSS dari public/) dibundel di dalam paket
 * (assets/www, disalin saat build) dan disajikan WebView dari origin virtual
 * https://app.basarang.local lewat shouldInterceptRequest — TIDAK ADA
 * pemuatan dari internet. Origin https agar localStorage, IndexedDB,
 * crypto.subtle (PBKDF2 akun perangkat), dan getUserMedia berjalan sebagai
 * secure context. Akun, proyek, dan naskah tersimpan di perangkat;
 * sinkronisasi ke server basarang.synclicen.workers.dev bersifat opsional
 * (tombol Sinkron di dalam aplikasi, autentikasi Bearer token).
 *
 * Poin penting stabilitas:
 *  - WebView Android TIDAK punya Web Speech API. Kelas ini menyediakan
 *    jembatan "NativeSpeech" ke SpeechRecognizer native; halaman web menerima
 *    window.SpeechRecognition lewat assets/speech_shim.js yang disuntikkan
 *    setiap kali halaman selesai dimuat (idempoten). Tanpa perubahan kode web.
 *  - Izin RECORD_AUDIO + CAMERA diminta saat mulai; permintaan
 *    getUserMedia dari web (onPermissionRequest) disetujui otomatis bila izin
 *    OS sudah dipegang, sehingga pratinjau kamera & rekaman tetap jalan.
 *  - configChanges mencegah WebView dimuat ulang saat perangkat diputar
 *    (sesi teleprompter dan rekaman tidak terputus).
 *  - Aset selalu tersedia dari paket (tanpa jaringan); bila aset gagal
 *    disajikan (kasus ekstrem), assets/offline.html tampil dengan tombol
 *    coba lagi + percobaan ulang otomatis tiap 15 detik.
 *  - Tombol kembali: menelusuri riwayat hash SPA; keluar perlu tekan dua kali.
 *  - Layar dijaga tetap menyala hanya saat teleprompter terbuka (dari shim).
 *  - LISENSI (v1.3.0, port sistem ARAY): jembatan NativeDevice menyediakan
 *    ANDROID_ID sebagai identitas perangkat yang stabil (tidak berubah oleh
 *    rotasi, bahasa, zona waktu, atau pembaruan WebView — hanya reset pabrik;
 *    di Android 8+ unik per kunci tanda tangan). Halaman web
 *    (public/license.js) mengubahnya menjadi Machine ID SHA-256 untuk
 *    sistem lisensi bulanan 30 hari tanpa login.
 */
public class MainActivity extends Activity {

    // Origin virtual aplikasi — "host" ini tidak pernah di-resolve DNS karena
    // SEMUA permintaannya dicegat shouldInterceptRequest dan disajikan dari
    // assets/www di dalam APK.
    private static final String START_URL = "https://app.basarang.local/";
    private static final String LOCAL_HOST = "app.basarang.local";
    private static final String LEGACY_HOST = "basarang.synclicen.workers.dev"; // versi <= 1.1.0
    private static final String OFFLINE_URL = "file:///android_asset/offline.html";
    private static final int REQ_APP_PERMS = 7001;
    private static final int REQ_WEB_PERM = 7002;

    private WebView web;
    private SpeechRecognizer recognizer;
    private final Handler main = new Handler(Looper.getMainLooper());
    private PermissionRequest pendingWebPerm;
    private boolean offlineShown = false;
    private long lastBackAt = 0L;

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        web = new WebView(this);
        web.setBackgroundColor(0xFF0C0716); // hindari kilat putih sebelum CSS termuat
        setContentView(web);

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);       // localStorage: token + pengaturan prompter
        s.setDatabaseEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false); // pratinjau kamera autoplay
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        s.setSupportZoom(false);
        s.setDisplayZoomControls(false);

        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest req) {
                Uri u = req.getUrl();
                String url = u.toString();
                if (url.startsWith("file:///android_asset/")) return false;
                String scheme = u.getScheme() == null ? "" : u.getScheme();
                String host = u.getHost() == null ? "" : u.getHost();
                if (("https".equals(scheme) || "http".equals(scheme))
                        && (LOCAL_HOST.equals(host) || LEGACY_HOST.equals(host))) {
                    return false; // muat di dalam aplikasi
                }
                try {
                    startActivity(new Intent(Intent.ACTION_VIEW, u)); // tautan luar → peramban
                } catch (Exception ignored) { }
                return true;
            }

            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest req) {
                // FULL OFFLINE: semua aset aplikasi disajikan dari dalam paket.
                Uri u = req.getUrl();
                if ("https".equals(u.getScheme()) && LOCAL_HOST.equals(u.getHost())) {
                    return serveLocalAsset(u);
                }
                return super.shouldInterceptRequest(view, req);
            }

            @Override
            public void onPageStarted(WebView view, String url, Bitmap favicon) {
                offlineShown = false;
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                injectShim(view);
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest req, WebResourceError err) {
                if (req.isForMainFrame() && !offlineShown) {
                    offlineShown = true;
                    view.loadUrl(OFFLINE_URL);
                }
            }
        });

        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onPermissionRequest(final PermissionRequest request) {
                grantWebPermission(request);
            }
        });

        web.addJavascriptInterface(new NativeSpeechBridge(), "NativeSpeech");
        // Identitas perangkat untuk sistem lisensi (lihat komentar kelas) —
        // dibaca public/license.js saat mode perangkat menghitung Machine ID.
        web.addJavascriptInterface(new NativeDeviceBridge(), "NativeDevice");

        if (savedInstanceState == null) {
            web.loadUrl(START_URL);
        } else if (web.restoreState(savedInstanceState) == null || !isAppUrl(web.getUrl())) {
            // Status tersimpan berasal dari versi lama (workers.dev) → mulai dari aset lokal.
            web.loadUrl(START_URL);
        }

        requestAppPermissions();
    }

    /* ---------- penyaji aset web dari dalam paket (full offline) ---------- */

    private WebResourceResponse serveLocalAsset(Uri u) {
        String path = u.getPath();
        if (path == null || path.isEmpty() || "/".equals(path)) path = "/index.html";
        // Sanitasi: tolak traversal direktori.
        if (path.indexOf("..") >= 0 || path.indexOf('\\') >= 0) return localAsset404();
        try {
            InputStream in = getAssets().open("www" + path);
            WebResourceResponse res = new WebResourceResponse(mimeOf(path), "utf-8", in);
            res.setStatusCodeAndReasonPhrase(200, "OK");
            Map<String, String> headers = new HashMap<>();
            headers.put("cache-control", "no-store"); // satu versi aset per APK — selalu segar
            res.setResponseHeaders(headers);
            return res;
        } catch (IOException e) {
            return localAsset404();
        }
    }

    private static WebResourceResponse localAsset404() {
        WebResourceResponse res = new WebResourceResponse(
                "text/plain", "utf-8", new ByteArrayInputStream(new byte[0]));
        res.setStatusCodeAndReasonPhrase(404, "Not Found");
        return res;
    }

    private static String mimeOf(String path) {
        int dot = path.lastIndexOf('.');
        String ext = dot < 0 ? "" : path.substring(dot + 1).toLowerCase(Locale.ROOT);
        switch (ext) {
            case "html": case "htm": return "text/html";
            case "css": return "text/css";
            case "js": case "mjs": return "application/javascript";
            case "svg": return "image/svg+xml";
            case "png": return "image/png";
            case "jpg": case "jpeg": return "image/jpeg";
            case "webp": return "image/webp";
            case "ico": return "image/x-icon";
            case "json": return "application/json";
            case "webmanifest": return "application/manifest+json";
            case "woff": return "font/woff";
            case "woff2": return "font/woff2";
            case "txt": return "text/plain";
            default: return "application/octet-stream";
        }
    }

    private static boolean isAppUrl(String url) {
        try {
            Uri u = Uri.parse(url == null ? "" : url);
            return u != null && "https".equals(u.getScheme()) && LOCAL_HOST.equals(u.getHost());
        } catch (Exception e) {
            return false;
        }
    }

    /* ---------- siklus hidup ---------- */

    @Override
    protected void onSaveInstanceState(Bundle out) {
        super.onSaveInstanceState(out);
        web.saveState(out);
    }

    @Override
    protected void onPause() {
        stopNative();  // mikrofon dilepas saat aplikasi di belakang (privasi + baterai)
        web.onPause();
        super.onPause();
    }

    @Override
    protected void onResume() {
        super.onResume();
        web.onResume();
    }

    @Override
    protected void onDestroy() {
        stopNative();
        super.onDestroy();
    }

    /* ---------- tombol kembali ---------- */

    @Override
    public void onBackPressed() {
        String url = web.getUrl() == null ? "" : web.getUrl();
        boolean atRoot = !url.contains("#") || url.contains("#/dashboard")
                || url.contains("#/login") || url.contains("#/setup");
        if (web.canGoBack() && !atRoot) {
            web.goBack(); // menutup prompter dsb. lewat riwayat hash SPA
            return;
        }
        long now = System.currentTimeMillis();
        if (now - lastBackAt < 2200) {
            super.onBackPressed();
        } else {
            lastBackAt = now;
            Toast.makeText(this, "Tekan sekali lagi untuk keluar", Toast.LENGTH_SHORT).show();
        }
    }

    /* ---------- izin (OS & web) ---------- */

    private void requestAppPermissions() {
        ArrayList<String> want = new ArrayList<>();
        if (checkSelfPermission(android.Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED)
            want.add(android.Manifest.permission.RECORD_AUDIO);
        if (checkSelfPermission(android.Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED)
            want.add(android.Manifest.permission.CAMERA);
        if (!want.isEmpty()) requestPermissions(want.toArray(new String[0]), REQ_APP_PERMS);
    }

    private static String osPermissionFor(String webRes) {
        if (PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(webRes)) return android.Manifest.permission.RECORD_AUDIO;
        if (PermissionRequest.RESOURCE_VIDEO_CAPTURE.equals(webRes)) return android.Manifest.permission.CAMERA;
        return null;
    }

    private void grantWebPermission(PermissionRequest request) {
        for (String res : request.getResources()) {
            String os = osPermissionFor(res);
            if (os == null) continue;
            if (checkSelfPermission(os) != PackageManager.PERMISSION_GRANTED) {
                pendingWebPerm = request;
                requestPermissions(new String[]{ os }, REQ_WEB_PERM);
                return;
            }
        }
        request.grant(request.getResources());
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode == REQ_WEB_PERM && pendingWebPerm != null) {
            PermissionRequest req = pendingWebPerm;
            pendingWebPerm = null;
            boolean all = true;
            for (String res : req.getResources()) {
                String os = osPermissionFor(res);
                if (os != null && checkSelfPermission(os) != PackageManager.PERMISSION_GRANTED) all = false;
            }
            try {
                if (all) req.grant(req.getResources());
                else req.deny();
            } catch (Exception ignored) { }
        }
    }

    /* ---------- suntik shim SpeechRecognition ---------- */

    private void injectShim(WebView view) {
        try {
            InputStream is = getAssets().open("speech_shim.js");
            ByteArrayOutputStream bo = new ByteArrayOutputStream();
            byte[] buf = new byte[8192];
            int n;
            while ((n = is.read(buf)) > 0) bo.write(buf, 0, n);
            is.close();
            view.evaluateJavascript(bo.toString("UTF-8"), null);
        } catch (Exception ignored) { }
    }

    /* ---------- jembatan identitas perangkat (lisensi) ---------- */

    // ANDROID_ID: heksadesimal 16 karakter, stabil sepanjang umur perangkat
    // (di Android 8+ di-scope per kunci tanda tangan aplikasi — pemasangan
    // ulang tidak mengubahnya; hanya reset pabrik yang mengganti). Tanpa izin.
    // Sengaja TIDAK memakai sidik jari peramban (userAgent/layar) agar Machine
    // ID tidak berubah akibat rotasi, ganti bahasa, atau update WebView.
    private class NativeDeviceBridge {
        @JavascriptInterface
        public String deviceId() {
            try {
                String id = Settings.Secure.getString(getContentResolver(), Settings.Secure.ANDROID_ID);
                return id == null ? "" : id.toLowerCase(Locale.ROOT);
            } catch (Exception e) {
                return "";
            }
        }
    }

    /* ---------- jembatan pengenalan suara native ---------- */

    private class NativeSpeechBridge {

        @JavascriptInterface
        public boolean available() {
            try {
                return SpeechRecognizer.isRecognitionAvailable(MainActivity.this);
            } catch (Exception e) {
                return false;
            }
        }

        @JavascriptInterface
        public void start(final String lang) {
            final String l = (lang == null || lang.trim().isEmpty()) ? "id-ID" : lang.trim();
            main.post(new Runnable() {
                public void run() { startNative(l); }
            });
        }

        @JavascriptInterface
        public void stop() {
            main.post(new Runnable() {
                public void run() { stopNative(); }
            });
        }

        @JavascriptInterface
        public void keepAwake(final boolean on) {
            web.post(new Runnable() {
                public void run() { web.setKeepScreenOn(on); }
            });
        }
    }

    private void startNative(String lang) {
        stopNative();
        if (!SpeechRecognizer.isRecognitionAvailable(this)) {
            speechCallback("{type:\"error\",code:\"service-not-allowed\"}");
            speechCallback("{type:\"end\"}");
            return;
        }
        try {
            recognizer = SpeechRecognizer.createSpeechRecognizer(this);
        } catch (Exception e) {
            speechCallback("{type:\"error\",code:\"audio-capture\"}");
            speechCallback("{type:\"end\"}");
            return;
        }
        recognizer.setRecognitionListener(new RecognitionListener() {
            public void onReadyForSpeech(Bundle params) { }
            public void onBeginningOfSpeech() { }
            public void onRmsChanged(float rmsdB) { }
            public void onBufferReceived(byte[] buffer) { }
            public void onEndOfSpeech() { }
            public void onError(int error) {
                speechCallback("{type:\"error\",code:\"" + mapSpeechError(error) + "\"}");
                speechCallback("{type:\"end\"}");
            }
            public void onResults(Bundle results) {
                deliverSpeech(results, true);
                speechCallback("{type:\"end\"}");
            }
            public void onPartialResults(Bundle partialResults) {
                deliverSpeech(partialResults, false);
            }
            public void onEvent(int eventType, Bundle params) { }
        });
        Intent intent = new Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH);
        intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM);
        intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE, lang);
        intent.putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true);
        try {
            recognizer.startListening(intent);
        } catch (SecurityException se) {
            speechCallback("{type:\"error\",code:\"not-allowed\"}");
            speechCallback("{type:\"end\"}");
            stopNative();
        } catch (Exception e) {
            speechCallback("{type:\"error\",code:\"audio-capture\"}");
            speechCallback("{type:\"end\"}");
            stopNative();
        }
    }

    private void stopNative() {
        if (recognizer != null) {
            try { recognizer.destroy(); } catch (Exception ignored) { }
            recognizer = null;
        }
    }

    private void deliverSpeech(Bundle bundle, boolean isFinal) {
        ArrayList<String> list = bundle.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION);
        if (list == null || list.isEmpty()) return;
        String text = list.get(0);
        if (text == null || text.trim().isEmpty()) return;
        speechCallback("{type:\"result\",text:" + jsonString(text)
                + ",isFinal:" + (isFinal ? "true" : "false") + "}");
    }

    private void speechCallback(final String objLiteral) {
        final String call = "(window.__basarangCb?window.__basarangCb(" + objLiteral + "):0)";
        web.post(new Runnable() {
            public void run() { web.evaluateJavascript(call, null); }
        });
    }

    private static String mapSpeechError(int err) {
        switch (err) {
            case SpeechRecognizer.ERROR_AUDIO: return "audio-capture";
            case SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS: return "not-allowed";
            case SpeechRecognizer.ERROR_SPEECH_TIMEOUT:
            case SpeechRecognizer.ERROR_NO_MATCH: return "no-speech";
            case SpeechRecognizer.ERROR_RECOGNIZER_BUSY: return "aborted";
            default: return "network";
        }
    }

    private static String jsonString(String s) {
        StringBuilder sb = new StringBuilder("\"");
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            switch (c) {
                case '"': sb.append("\\\""); break;
                case '\\': sb.append("\\\\"); break;
                case '\n': sb.append("\\n"); break;
                case '\r': sb.append("\\r"); break;
                case '\t': sb.append("\\t"); break;
                default:
                    if (c < 0x20) sb.append(String.format("\\u%04x", (int) c));
                    else sb.append(c);
            }
        }
        return sb.append('"').toString();
    }
}
