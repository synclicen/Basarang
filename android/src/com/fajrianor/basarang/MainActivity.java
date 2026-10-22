package com.fajrianor.basarang;

import android.annotation.SuppressLint;
import android.Manifest;
import android.app.Activity;
import android.content.ContentValues;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.os.Handler;
import android.os.Looper;
import android.provider.MediaStore;
import android.util.Base64;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
import android.webkit.PermissionRequest;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

import org.json.JSONObject;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.Iterator;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Basarang: Bagarak Saurang — versi offline (APK).
 *
 * Seluruh aplikasi web (aset statis di assets/www) dilayani dari dalam APK
 * lewat interceptor permintaan pada domain virtual appassets.androidplatform.net.
 * Domain tersebut diperlakukan Chromium sebagai asal yang aman (secure context),
 * sehingga localStorage, WebCrypto (PBKDF2), dan getUserMedia (kamera) berfungsi.
 * Backend API digantikan oleh offline.js yang berjalan di dalam WebView —
 * tidak ada permintaan jaringan sama sekali.
 */
public class MainActivity extends Activity {

    private static final String VIRTUAL_HOST = "appassets.androidplatform.net";
    private static final String VIRTUAL_HOME = "https://appassets.androidplatform.net/index.html";
    private static final int REQ_PERM = 7001;

    private WebView web;
    private PermissionRequest pendingPerm;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final ExecutorService io = Executors.newSingleThreadExecutor();
    private final Object dataLock = new Object();
    private final Object blobLock = new Object();
    private JSONObject lsCache = new JSONObject();

    @Override
    @SuppressLint("SetJavaScriptEnabled")
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        loadLsCache();
        cleanStaleBlobParts();

        web = new WebView(this);
        web.setBackgroundColor(0xFF120C22);
        setContentView(web);

        WebSettings ws = web.getSettings();
        ws.setJavaScriptEnabled(true);
        ws.setDomStorageEnabled(true);
        ws.setMediaPlaybackRequiresUserGesture(false);
        ws.setAllowFileAccess(false);
        ws.setAllowContentAccess(false);
        ws.setCacheMode(WebSettings.LOAD_NO_CACHE);

        web.setWebViewClient(new LocalClient());
        web.setWebChromeClient(new Chrome());
        web.addJavascriptInterface(new Bridge(), "AndroidBridge");
        web.loadUrl(VIRTUAL_HOME);
    }

    // ---------------------------------------------------------------- klien WebView

    private class LocalClient extends WebViewClient {
        @Override
        public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
            Uri u = request.getUrl();
            if (u == null) return null;
            if (!"https".equals(u.getScheme()) || !VIRTUAL_HOST.equals(u.getHost())) return null;
            return serve(u);
        }

        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            Uri u = request.getUrl();
            if (u != null && "https".equals(u.getScheme()) && VIRTUAL_HOST.equals(u.getHost())) {
                return false; // dilayani interceptor lokal
            }
            try {
                startActivity(new Intent(Intent.ACTION_VIEW, u));
            } catch (Exception ignored) {
            }
            return true;
        }
    }

    private class Chrome extends WebChromeClient {
        @Override
        public void onPermissionRequest(final PermissionRequest request) {
            main.post(new Runnable() {
                @Override
                public void run() {
                    handleWebPermission(request);
                }
            });
        }

        @Override
        public void onPermissionRequestCanceled(final PermissionRequest request) {
            main.post(new Runnable() {
                @Override
                public void run() {
                    if (pendingPerm == request) pendingPerm = null;
                }
            });
        }
    }

    private void handleWebPermission(PermissionRequest request) {
        String[] res = request.getResources();
        if (res == null || res.length == 0) {
            request.deny();
            return;
        }
        boolean cam = false, mic = false;
        for (String r : res) {
            if (PermissionRequest.RESOURCE_VIDEO_CAPTURE.equals(r)) cam = true;
            if (PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(r)) mic = true;
        }
        List<String> need = new ArrayList<>();
        if (cam && !hasPermission(Manifest.permission.CAMERA)) need.add(Manifest.permission.CAMERA);
        if (mic && !hasPermission(Manifest.permission.RECORD_AUDIO)) need.add(Manifest.permission.RECORD_AUDIO);
        if (need.isEmpty()) {
            request.grant(res);
            return;
        }
        pendingPerm = request;
        requestPermissions(need.toArray(new String[0]), REQ_PERM);
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode != REQ_PERM || pendingPerm == null) return;
        PermissionRequest pr = pendingPerm;
        pendingPerm = null;
        List<String> grantable = new ArrayList<>();
        for (String r : pr.getResources()) {
            boolean ok;
            if (PermissionRequest.RESOURCE_VIDEO_CAPTURE.equals(r)) {
                ok = hasPermission(Manifest.permission.CAMERA);
            } else if (PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(r)) {
                ok = hasPermission(Manifest.permission.RECORD_AUDIO);
            } else {
                ok = false;
            }
            if (ok) grantable.add(r);
        }
        if (grantable.isEmpty()) pr.deny();
        else pr.grant(grantable.toArray(new String[0]));
    }

    private boolean hasPermission(String perm) {
        return checkSelfPermission(perm) == PackageManager.PERMISSION_GRANTED;
    }

    @Override
    public void onBackPressed() {
        if (web != null && web.canGoBack()) web.goBack();
        else super.onBackPressed();
    }

    // ---------------------------------------------------------------- penyaji aset

    private WebResourceResponse serve(Uri u) {
        String path = u.getPath();
        if (path == null || path.isEmpty() || path.equals("/")) path = "/index.html";
        if (path.contains("..")) return notFound();

        if (path.equals("/_seed.js")) {
            String json;
            synchronized (dataLock) {
                json = lsCache.toString();
            }
            String js = "window.__BSR_SEED_LS=" + json + ";\n";
            Map<String, String> headers = new HashMap<>();
            headers.put("Cache-Control", "no-store");
            return new WebResourceResponse("text/javascript", "utf-8", 200, "OK", headers,
                    new ByteArrayInputStream(js.getBytes(StandardCharsets.UTF_8)));
        }
        if (path.startsWith("/api/")) {
            // Normalnya tidak pernah sampai sini (offline.js mengoverride fetch),
            // disediakan hanya sebagai pengaman.
            return notFound();
        }
        try {
            InputStream in = getAssets().open("www" + path);
            String mime = mimeFor(path);
            return new WebResourceResponse(mime, isTextLike(mime) ? "utf-8" : null, in);
        } catch (IOException e) {
            return notFound();
        }
    }

    private static String mimeFor(String path) {
        String p = path.toLowerCase();
        if (p.endsWith(".html")) return "text/html";
        if (p.endsWith(".js")) return "text/javascript";
        if (p.endsWith(".css")) return "text/css";
        if (p.endsWith(".svg")) return "image/svg+xml";
        if (p.endsWith(".png")) return "image/png";
        if (p.endsWith(".jpg") || p.endsWith(".jpeg")) return "image/jpeg";
        if (p.endsWith(".ico")) return "image/x-icon";
        if (p.endsWith(".json")) return "application/json";
        if (p.endsWith(".webm")) return "video/webm";
        if (p.endsWith(".woff2")) return "font/woff2";
        return "application/octet-stream";
    }

    private static boolean isTextLike(String mime) {
        return mime.startsWith("text/") || "image/svg+xml".equals(mime) || "application/json".equals(mime);
    }

    private WebResourceResponse notFound() {
        Map<String, String> headers = new HashMap<>();
        headers.put("Cache-Control", "no-store");
        return new WebResourceResponse("text/plain", "utf-8", 404, "Not Found", headers,
                new ByteArrayInputStream("tidak ditemukan".getBytes(StandardCharsets.UTF_8)));
    }

    // ---------------------------------------------------------------- bridge JS ↔ Java

    private class Bridge {

        /** Cermin localStorage ke file internal (durabilitas). */
        @JavascriptInterface
        public void persistKeys(String json) {
            if (json == null) return;
            try {
                JSONObject patch = new JSONObject(json);
                synchronized (dataLock) {
                    Iterator<String> it = patch.keys();
                    while (it.hasNext()) {
                        String k = it.next();
                        lsCache.put(k, patch.opt(k));
                    }
                }
                final String out;
                synchronized (dataLock) {
                    out = lsCache.toString();
                }
                io.execute(new Runnable() {
                    @Override
                    public void run() {
                        writeAtomic(lsFile(), out);
                    }
                });
            } catch (Exception ignored) {
            }
        }

        /** Terima potongan base64 hasil rekaman (aman untuk video besar). */
        @JavascriptInterface
        public void blobChunk(String id, long index, long total, String b64) {
            try {
                byte[] part = Base64.decode(b64, Base64.DEFAULT);
                synchronized (blobLock) {
                    File f = partFile(id);
                    FileOutputStream fo = new FileOutputStream(f, true);
                    try {
                        fo.write(part);
                    } finally {
                        fo.close();
                    }
                }
            } catch (Exception ignored) {
            }
        }

        /** Rakit potongan lalu simpan ke Unduhan. */
        @JavascriptInterface
        public void blobCommit(String id, String name, String mime) {
            final File src;
            synchronized (blobLock) {
                src = partFile(id);
            }
            final String fname = sanitizeName(name);
            final String fmime = (mime == null || mime.isEmpty()) ? "video/webm" : mime;
            io.execute(new Runnable() {
                @Override
                public void run() {
                    saveVideoFile(src, fname, fmime);
                }
            });
        }

        /** Layar tetap menyala saat teleprompter terbuka. */
        @JavascriptInterface
        public void keepScreenOn(final boolean on) {
            main.post(new Runnable() {
                @Override
                public void run() {
                    if (on) getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
                    else getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
                }
            });
        }
    }

    // ---------------------------------------------------------------- penyimpanan file

    private File lsFile() {
        return new File(getFilesDir(), "localstorage.json");
    }

    private File partFile(String id) {
        File dir = new File(getFilesDir(), "blobparts");
        if (!dir.exists()) dir.mkdirs();
        return new File(dir, id + ".part");
    }

    private void cleanStaleBlobParts() {
        File dir = new File(getFilesDir(), "blobparts");
        File[] files = dir.listFiles();
        if (files != null) {
            for (File f : files) f.delete();
        }
    }

    private void loadLsCache() {
        try {
            File f = lsFile();
            if (f.exists()) {
                byte[] all = readAll(new FileInputStream(f));
                lsCache = new JSONObject(new String(all, StandardCharsets.UTF_8));
            }
        } catch (Exception e) {
            lsCache = new JSONObject();
        }
    }

    private static String sanitizeName(String name) {
        String n = (name == null ? "" : name).replace("/", "_").replace("\\", "_").replace("\0", "");
        if (n.isEmpty()) n = "basarang-rekaman.webm";
        return n;
    }

    /** Simpan rekaman: API 29+ ke MediaStore.Downloads (tanpa izin), API 23-28 ke folder aplikasi. */
    private void saveVideoFile(File src, String name, String mime) {
        try {
            if (!src.exists() || src.length() == 0) return;
            if (Build.VERSION.SDK_INT >= 29) {
                ContentValues cv = new ContentValues();
                cv.put(MediaStore.Downloads.DISPLAY_NAME, name);
                cv.put(MediaStore.Downloads.MIME_TYPE, mime);
                Uri uri = getContentResolver().insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, cv);
                if (uri == null) throw new IOException("gagal membuat entri Unduhan");
                OutputStream out = getContentResolver().openOutputStream(uri);
                if (out == null) throw new IOException("gagal membuka aliran tulis");
                copyStream(new FileInputStream(src), out);
                toast("Rekaman tersimpan di Unduhan: " + name);
            } else {
                File dir = getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS);
                if (dir == null) dir = getFilesDir();
                if (!dir.exists()) dir.mkdirs();
                File dst = new File(dir, name);
                copyStream(new FileInputStream(src), new FileOutputStream(dst));
                toast("Rekaman tersimpan: " + dst.getAbsolutePath());
            }
        } catch (Exception e) {
            toast("Gagal menyimpan rekaman: " + e.getMessage());
        } finally {
            src.delete();
        }
    }

    private static void copyStream(InputStream in, OutputStream out) throws IOException {
        byte[] buf = new byte[65536];
        int n;
        try {
            while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
        } finally {
            try {
                in.close();
            } catch (IOException ignored) {
            }
            try {
                out.close();
            } catch (IOException ignored) {
            }
        }
    }

    private static byte[] readAll(InputStream in) throws IOException {
        ByteArrayOutputStream bo = new ByteArrayOutputStream();
        byte[] buf = new byte[65536];
        int n;
        try {
            while ((n = in.read(buf)) > 0) bo.write(buf, 0, n);
        } finally {
            try {
                in.close();
            } catch (IOException ignored) {
            }
        }
        return bo.toByteArray();
    }

    private void writeAtomic(File dst, String content) {
        try {
            File tmp = new File(dst.getParentFile(), dst.getName() + ".tmp");
            FileOutputStream fo = new FileOutputStream(tmp);
            try {
                fo.write(content.getBytes(StandardCharsets.UTF_8));
                fo.getFD().sync();
            } finally {
                fo.close();
            }
            if (!tmp.renameTo(dst)) {
                // Ganti nama gagal (mis. file sedang dibaca) — tulis langsung.
                FileOutputStream fo2 = new FileOutputStream(dst);
                try {
                    fo2.write(content.getBytes(StandardCharsets.UTF_8));
                } finally {
                    fo2.close();
                }
                tmp.delete();
            }
        } catch (Exception ignored) {
        }
    }

    private void toast(final String message) {
        main.post(new Runnable() {
            @Override
            public void run() {
                Toast.makeText(MainActivity.this, message, Toast.LENGTH_LONG).show();
            }
        });
    }

    @Override
    protected void onDestroy() {
        io.shutdown();
        if (web != null) {
            web.removeJavascriptInterface("AndroidBridge");
        }
        super.onDestroy();
    }
}
