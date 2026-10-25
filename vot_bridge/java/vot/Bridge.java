package vot;

import android.content.Context;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import android.media.MediaPlayer;
import android.os.Handler;
import android.os.HandlerThread;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;

/**
 * VOT bridge: a tiny HTTP server bound to 127.0.0.1:8013 inside the
 * TizenTubeCobalt process. The live youtube.com/tv page can only reach
 * localhost via its CSP connect-src (http://localhost:*, http://127.0.0.1:*),
 * so the JS overlay calls this service to talk to Yandex VOT and to play
 * translated audio natively (page cannot decode mp3 / reach Yandex S3).
 */
public final class Bridge {

    private static final String UA =
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
            "(KHTML, like Gecko) Chrome/142.0.0.0 YaBrowser/25.12.4.1198 Safari/537.36";
    // googlevideo hands out different URLs per InnerTube client and sometimes
    // only serves the request if the User-Agent matches that client family, so
    // the download tries the UA the overlay asked for first, then these.
    private static final String[] AUDIO_UAS = {
            "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) " +
                    "Chrome/122.0.6261.64 Mobile Safari/537.36,gzip(gfe)",
            "com.google.android.youtube/19.44.38 (Linux; U; Android 11) gzip",
            "com.google.android.apps.youtube.vr.oculus/1.60.19 (Linux; U; Android 12; en_US; " +
                    "Quest 3 Build/SQ3A.220605.009.A1;) gzip",
            UA
    };
    private static final String YANDEX = "https://api.browser.yandex.ru";
    private static final String HMAC_KEY = "bt8xH3VOlb4mqf0nqAibnDOoiPlXsisf";
    private static final String VERSION = "25.12.4.1198";
    private static final int AUDIO_CHUNK_SIZE = 5295308;
    private static final String AUDIO_DOWNLOAD_TYPE = "web_api_steal_sig_and_n";

    private static volatile boolean started;

    // ---- overlay serving (mutable JS pulled from PC dev server) ----
    private static final String PC_BASE = "http://192.168.1.186:8013";
    private static final String OVERLAY_SOURCE = PC_BASE + "/vot.js";
    private static final String CONFIG_SOURCE = PC_BASE + "/vot_config.json";
    private static volatile byte[] sOverlay;
    private static volatile String sLastConfig = "";

    // ---- audio playback state (accessed on sAudioHandler thread) ----
    private static final Object AUDIO_LOCK = new Object();
    private static HandlerThread sAudioThread;
    private static Handler sAudioHandler;
    private static MediaPlayer sPlayer;
    private static volatile String sPlayerUrl = null;
    private static volatile boolean sPrepared = false;
    private static volatile long sLastPosMs = -1;
    private static volatile boolean sPlaying = false;
    // Громкость перевода: MediaPlayer в Cobalt играет мимо JS, поэтому уровень
    // задаётся из моста (/volume) и переиспользуется для новых треков.
    private static volatile float sVol = 1f;

    // ---- runtime config (posted by the overlay to /config) ----
    // lively  : ask Yandex for "live voices" (needs a Yandex OAuth token)
    // token   : Yandex OAuth token (empty => lively cannot work)
    // worker  : e.g. "vot-worker.eu.cc" (empty => talk to Yandex directly)
    // media   : e.g. "media-proxy.toil.cc" (empty => download audio directly)
    // proxy   : "off" | "audio" | "all"
    private static volatile boolean sLively = false;
    private static volatile String sOauthToken = "";
    private static volatile String sWorker = "";
    private static volatile String sMediaProxy = "";
    private static volatile String sProxyMode = "off";
    // Empty-audio strategy for status 6: "audio" (SmartTube marker, default),
    // "votjs" (vot.js marker) or "skip" (don't touch, just keep polling).
    private static volatile String sFaMode = "audio";
    // Serverless switches handed to the overlay via /config:
    // audioMode : "off" (PC filler as before) | "local" (bridge resolves the
    //             audio URL itself and feeds it to Yandex without a PC)
    // pcFill    : may the overlay ask the PC dev server for the source audio
    private static volatile String sAudioMode = "off";
    private static volatile boolean sPcFill = true;

    // ---- TV-side paths (needed to read Cobalt's cookie store) ----
    private static volatile String sDataDir = "";
    private static volatile String sCacheDir = "";

    private Bridge() {}

    public static synchronized void start(Context ctx) {
        if (started) return;
        started = true;
        try {
            sDataDir = ctx.getApplicationInfo().dataDir;
            File cd = ctx.getCacheDir();
            sCacheDir = cd == null ? sDataDir : cd.getAbsolutePath();
        } catch (Throwable e) {
            android.util.Log.w("VotBridge", "dirs failed: " + e);
        }
        android.util.Log.i("VotBridge", "dirs data=" + sDataDir + " cache=" + sCacheDir);
        capCleanupStale();
        Thread t = new Thread(Bridge::serve, "vot-bridge");
        t.setDaemon(true);
        t.start();
        Thread f = new Thread(Bridge::overlayFetcher, "vot-overlay-fetch");
        f.setDaemon(true);
        f.start();
        android.util.Log.i("VotBridge", "bridge starting on 127.0.0.1:8013");
    }

    private static void overlayFetcher() {
        while (true) {
            try {
                byte[] b = httpGet(OVERLAY_SOURCE);
                if (b != null && b.length > 0) {
                    sOverlay = b;
                    android.util.Log.i("VotBridge", "overlay refreshed " + b.length + " bytes");
                }
            } catch (Throwable e) {
                android.util.Log.w("VotBridge", "overlay fetch failed: " + e);
            }
            reloadConfig();
            try { Thread.sleep(8000); } catch (InterruptedException e) { return; }
        }
    }

    // Settings live in vot_config.json next to vot.js on the PC dev server, so
    // the OAuth token / worker can be changed without rebuilding the APK.
    private static void reloadConfig() {
        try {
            byte[] b = httpGet(CONFIG_SOURCE);
            if (b == null || b.length == 0) return;
            String s = new String(b, StandardCharsets.UTF_8).trim();
            if (s.isEmpty() || s.equals(sLastConfig)) return;
            JSONObject o = new JSONObject(s);
            sLastConfig = s;
            handleConfig(o);
        } catch (Throwable e) {
            android.util.Log.w("VotBridge", "config fetch failed: " + e);
        }
    }

    private static byte[] httpGet(String url) throws IOException {
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        c.setConnectTimeout(5000);
        c.setReadTimeout(5000);
        c.setRequestProperty("User-Agent", "vot-bridge/1");
        int code = c.getResponseCode();
        if (code != 200) { c.disconnect(); return null; }
        byte[] b = YandexClient.readAll(c.getInputStream());
        c.disconnect();
        return b;
    }

    // ---- PC filler ----------------------------------------------------------
    // The TV cannot give Yandex the source audio (every InnerTube client answers
    // LOGIN_REQUIRED and the urls it does return are refused with 403: no
    // poToken). The PC dev server can: yt-dlp with the browser cookies downloads
    // the track and uploads it to Yandex, after which this translationId turns
    // into status=1 on its own. The request is forwarded in a background thread
    // so the TV never waits for a 50 MB download.
    private static byte[] pcPost(String url, byte[] body) throws IOException {
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        c.setConnectTimeout(5000);
        c.setReadTimeout(15000);
        c.setRequestMethod("POST");
        c.setDoOutput(true);
        c.setRequestProperty("Content-Type", "application/json; charset=utf-8");
        c.setRequestProperty("User-Agent", "vot-bridge/1");
        c.getOutputStream().write(body);
        int code = c.getResponseCode();
        byte[] b = null;
        if (code == 200) b = YandexClient.readAll(c.getInputStream());
        c.disconnect();
        android.util.Log.i("VotBridge", "pc POST " + url + " -> " + code);
        return b;
    }

    // Read-only proxy for /fill_status on the PC: lets the overlay stop waiting
    // as soon as the filler has actually failed (e.g. expired cookies).
    private static String handleFillStatus(String id) {
        if (id == null || id.isEmpty()) return "{\"state\":\"none\",\"res\":{}}";
        try {
            byte[] b = httpGet(PC_BASE + "/fill_status?videoId=" + java.net.URLEncoder.encode(id, "UTF-8"));
            if (b == null) return "{\"state\":\"offline\",\"res\":{}}";
            return new String(b, StandardCharsets.UTF_8);
        } catch (Throwable e) {
            return "{\"state\":\"offline\",\"res\":{\"error\":\""
                    + safeJson(String.valueOf(e.getMessage())) + "\"}}";
        }
    }

    private static JSONObject handleFill(JSONObject req) throws Exception {
        final String id = req.optString("videoId", req.optString("id", "")).trim();
        if (id.isEmpty()) throw new IOException("missing videoId");
        final double dur = req.optDouble("duration", 0);
        final String tid = req.optString("tid", "");
        final String lang = req.optString("lang", "");
        JSONObject r = new JSONObject();
        r.put("queued", true);
        r.put("videoId", id);
        Thread t = new Thread(() -> {
            try {
                JSONObject o = new JSONObject();
                o.put("videoId", id);
                o.put("duration", dur);
                o.put("tid", tid);
                o.put("lang", lang);
                byte[] resp = pcPost(PC_BASE + "/fill", o.toString().getBytes(StandardCharsets.UTF_8));
                android.util.Log.i("VotBridge", "fill " + id + " -> "
                        + (resp == null ? "null" : new String(resp, StandardCharsets.UTF_8)));
            } catch (Throwable e) {
                android.util.Log.e("VotBridge", "fill " + id + " failed: " + e);
            }
        }, "vot-fill");
        t.setDaemon(true);
        t.start();
        android.util.Log.i("VotBridge", "fill queued id=" + id + " dur=" + dur + " tid=" + tid);
        return r;
    }

    // Full-body GET for downloading source audio (DASH itag URL). googlevideo
    // throttles plain full downloads via the "n" param but serves Range requests
    // at full speed, so when the URL carries a "clen" we fetch it in 1 MiB ranges.
    private static byte[] httpGetFull(String url, String ua) throws IOException {
        android.util.Log.i("VotBridge", "audio get clen=" + qclen(url) + " urlLen=" + url.length()
                + " ua=" + String.valueOf(ua).substring(0, Math.min(String.valueOf(ua).length(), 40)));
        long clen = qclen(url);
        if (clen > 0) {
            try {
                return httpGetRanged(url, clen, ua);
            } catch (IOException e) {
                android.util.Log.e("VotBridge", "ranged failed (" + e + "), falling back to full GET");
            }
        }
        return httpGetSingle(url, ua);
    }

    // Ask googlevideo for 64 bytes with each candidate UA and report the codes.
    private static String probeAudioUa(String url, String wanted) {
        java.util.LinkedHashSet<String> set = new java.util.LinkedHashSet<>();
        if (wanted != null && !wanted.isEmpty()) set.add(wanted);
        for (String u : AUDIO_UAS) set.add(u);
        String win = null;
        int i = 0;
        for (String u : set) {
            int code = -1;
            try {
                HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
                c.setInstanceFollowRedirects(true);
                c.setConnectTimeout(8000);
                c.setReadTimeout(8000);
                c.setRequestProperty("User-Agent", u);
                c.setRequestProperty("Range", "bytes=0-63");
                code = c.getResponseCode();
                try { c.disconnect(); } catch (Throwable e) { }
            } catch (Throwable e) {
                android.util.Log.w("VotBridge", "audio ua[" + i + "] err " + e);
            }
            android.util.Log.i("VotBridge", "audio ua[" + i + "] code=" + code
                    + " " + u.substring(0, Math.min(u.length(), 34)));
            if (win == null && (code == 200 || code == 206)) win = u;
            i++;
        }
        return win;
    }

    private static long qclen(String url) {
        try {
            int i = url.indexOf("clen=");
            if (i < 0) return -1;
            int j = i + 5;
            StringBuilder sb = new StringBuilder();
            while (j < url.length()) {
                char ch = url.charAt(j);
                if (ch >= '0' && ch <= '9') { sb.append(ch); j++; }
                else break;
            }
            return sb.length() == 0 ? -1 : Long.parseLong(sb.toString());
        } catch (Throwable e) { return -1; }
    }

    private static String errSnippet(HttpURLConnection c) {
        try {
            java.io.InputStream es = c.getErrorStream();
            if (es == null) return "";
            byte[] b = new byte[256];
            int n = es.read(b);
            if (n <= 0) return "";
            return new String(b, 0, n, StandardCharsets.UTF_8).replace('\n', ' ').replace('\r', ' ');
        } catch (Throwable e) { return ""; }
    }

    private static byte[] httpGetSingle(String url, String ua) throws IOException {
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        c.setInstanceFollowRedirects(true);
        c.setConnectTimeout(10000);
        c.setReadTimeout(120000);
        c.setRequestProperty("User-Agent", ua == null || ua.isEmpty() ? UA : ua);
        c.setRequestProperty("Accept", "*/*");
        try {
            int code = c.getResponseCode();
            if (code >= 400) throw new IOException("audio download HTTP " + code + " " + errSnippet(c));
            return YandexClient.readAll(c.getInputStream());
        } finally {
            try { c.disconnect(); } catch (Throwable e) { }
        }
    }

    private static byte[] httpGetRanged(String url, long total, String ua) throws IOException {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        long pos = 0;
        long chunk = 1024L * 1024L; // 1 MiB per range request
        while (pos < total) {
            long end = Math.min(total - 1, pos + chunk - 1);
            byte[] part = httpGetRange(url, pos, end, ua);
            if (part == null || part.length == 0) throw new IOException("audio range empty at " + pos);
            out.write(part, 0, part.length);
            pos += part.length;
        }
        return out.toByteArray();
    }

    private static byte[] httpGetRange(String url, long from, long to, String ua) throws IOException {
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        c.setInstanceFollowRedirects(true);
        c.setConnectTimeout(10000);
        c.setReadTimeout(30000);
        c.setRequestProperty("User-Agent", ua == null || ua.isEmpty() ? UA : ua);
        c.setRequestProperty("Range", "bytes=" + from + "-" + to);
        try {
            int code = c.getResponseCode();
            if (code != 200 && code != 206) throw new IOException("audio range HTTP " + code + " " + errSnippet(c));
            return YandexClient.readAll(c.getInputStream());
        } finally {
            try { c.disconnect(); } catch (Throwable e) { }
        }
    }

    // ---------------------------------------------------------------------
    // YouTube session of the TV + InnerTube (serverless path, no PC)
    // ---------------------------------------------------------------------
    // Cobalt keeps its cookies in a plaintext Chromium SQLite store inside the
    // app data dir. The bridge runs in the same uid, so it copies that file and
    // reads it read-only: no root, no Keystore, no WebView.
    private static final String COOKIE_REL = "app_content_shell/content_shell/Cookies";
    private static final long COOKIE_TTL_MS = 60000L;
    private static final String[] AUTH_COOKIES = {
            "SID", "SAPISID", "APISID", "HSID", "SSID", "__Secure-1PSID",
            "__Secure-3PSID", "__Secure-1PAPISID", "__Secure-3PAPISID", "LOGIN_INFO"
    };
    private static final Object COOKIE_LOCK = new Object();
    private static volatile long sCookieAtMs;
    private static volatile String sCookieHeader = "";
    private static volatile String sCookieNames = "";
    private static volatile String sCookieErr = "";
    private static volatile boolean sCookieLoggedIn;
    private static volatile Map<String, String> sCookieMap = new HashMap<>();

    private static final String INNERTUBE = "https://www.youtube.com/youtubei/v1/player";
    private static final String INNERTUBE_KEY = "AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8";
    private static final String WEB_VERSION = "2.20240101.00.00";
    private static final String WEB_UA =
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
            "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
    private static final String VR_VERSION = "1.62.27";
    private static final String VR_UA =
            "com.google.android.apps.youtube.vr.oculus/1.62.27 (Linux; U; Android 12; en_US; " +
            "Quest 3 Build/SQ3A.220605.009.A1;) gzip";

    private static final class MetaEntry {
        final long at;
        final boolean ok;
        final JSONObject json;
        MetaEntry(long at, boolean ok, JSONObject json) {
            this.at = at; this.ok = ok; this.json = json;
        }
    }
    private static final Map<String, MetaEntry> META_CACHE = new HashMap<>();

    // Copy the Chromium store into our cache dir (it may be locked by Cobalt),
    // then read host/name/value. Values stay in memory only: they never go into
    // /yt_session and never into the log.
    private static void refreshCookies(boolean force) {
        synchronized (COOKIE_LOCK) {
            long now = System.currentTimeMillis();
            if (!force && sCookieAtMs != 0 && now - sCookieAtMs < COOKIE_TTL_MS) return;
            sCookieAtMs = now;
            sCookieErr = "";
            Map<String, String> map = new HashMap<>();
            StringBuilder names = new StringBuilder();
            try {
                if (sDataDir == null || sDataDir.isEmpty()) throw new IOException("no data dir");
                File src = new File(sDataDir, COOKIE_REL);
                if (!src.isFile()) throw new IOException("no cookie store");
                File dst = new File(sCacheDir, "vot_cookies.db");
                copyFile(src, dst);
                SQLiteDatabase db = SQLiteDatabase.openDatabase(dst.getAbsolutePath(), null,
                        SQLiteDatabase.OPEN_READONLY);
                java.util.ArrayList<String> hosts = new java.util.ArrayList<>();
                java.util.ArrayList<String> ns = new java.util.ArrayList<>();
                java.util.ArrayList<String> vs = new java.util.ArrayList<>();
                Cursor c = null;
                try {
                    c = db.rawQuery("SELECT host_key,name,value,expires_utc FROM cookies"
                            + " WHERE host_key = 'youtube.com' OR host_key LIKE '%.youtube.com'", null);
                    while (c.moveToNext()) {
                        String host = c.getString(0);
                        String name = c.getString(1);
                        String val = c.isNull(2) ? "" : c.getString(2);
                        if (name == null || name.isEmpty()) continue;
                        long eu = c.isNull(3) ? 0L : c.getLong(3);
                        if (eu > 0) {
                            // Chromium: микросекунды от 1601; истёкшие не берём.
                            long sec = eu / 1000000L - 11644473600L;
                            if (sec < now / 1000L) continue;
                        }
                        hosts.add(host == null ? "" : host);
                        ns.add(name);
                        vs.add(val);
                    }
                } finally {
                    if (c != null) c.close();
                    db.close();
                }
                // Same name on several hosts: prefer ".youtube.com" (the session
                // cookies live there), then anything else.
                for (int pass = 0; pass < 2; pass++) {
                    for (int i = 0; i < ns.size(); i++) {
                        String host = hosts.get(i);
                        boolean exact = host.equals(".youtube.com") || host.equals("youtube.com");
                        if (pass == 0 ? !exact : exact) continue;
                        String name = ns.get(i);
                        if (map.containsKey(name)) continue;
                        map.put(name, vs.get(i));
                    }
                }
                StringBuilder sb = new StringBuilder();
                for (Map.Entry<String, String> e : map.entrySet()) {
                    String v = e.getValue();
                    if (v == null || v.isEmpty()) continue;
                    if (sb.length() > 0) sb.append("; ");
                    sb.append(e.getKey()).append('=').append(v);
                    if (names.length() > 0) names.append(',');
                    names.append(e.getKey());
                }
                sCookieHeader = sb.toString();
                sCookieLoggedIn = map.containsKey("SID") || map.containsKey("SAPISID");
                android.util.Log.i("VotBridge", "yt cookies n=" + map.size()
                        + " login=" + (sCookieLoggedIn ? 1 : 0) + " db=" + src.length()
                        + "B headerLen=" + sCookieHeader.length() + " names=" + names);
            } catch (Throwable e) {
                // Частично прочитанный map не должен остаться в памяти: иначе
                // cookie("SID") вернёт значение при sCookieLoggedIn=false.
                map = new HashMap<>();
                sCookieHeader = "";
                sCookieLoggedIn = false;
                sCookieErr = String.valueOf(e.getMessage());
                android.util.Log.w("VotBridge", "yt cookies failed: " + e);
            }
            sCookieMap = map;
            sCookieNames = names.toString();
        }
    }

    private static String cookie(String name) {
        String v = sCookieMap.get(name);
        return v == null ? "" : v;
    }

    private static void copyFile(File from, File to) throws IOException {
        File parent = to.getParentFile();
        if (parent != null && !parent.isDirectory()) parent.mkdirs();
        try (InputStream in = new FileInputStream(from);
             OutputStream out = new FileOutputStream(to)) {
            byte[] buf = new byte[16384];
            int n;
            while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
        }
    }

    private static String sha1Hex(String s) throws Exception {
        MessageDigest md = MessageDigest.getInstance("SHA-1");
        byte[] d = md.digest(s.getBytes(StandardCharsets.UTF_8));
        StringBuilder sb = new StringBuilder(d.length * 2);
        for (byte b : d) {
            int v = b & 0xff;
            if (v < 16) sb.append('0');
            sb.append(Integer.toHexString(v));
        }
        return sb.toString();
    }

    // WEB requires SAPISIDHASH (plain Cookie header alone hits the bot gate on
    // every non-cached video). Origin must match the header exactly.
    private static String sapisidHash(String sapisid) {
        try {
            long ts = System.currentTimeMillis() / 1000L;
            String digest = sha1Hex(ts + " " + sapisid + " https://www.youtube.com");
            return "SAPISIDHASH " + ts + "_" + digest;
        } catch (Throwable e) {
            return "";
        }
    }

    private static JSONObject itPlayer(String videoId, boolean vr) throws Exception {
        refreshCookies(false);
        JSONObject client = new JSONObject();
        JSONObject body = new JSONObject();
        JSONObject ctx = new JSONObject();
        if (vr) {
            client.put("clientName", "ANDROID_VR");
            client.put("clientVersion", VR_VERSION);
            client.put("deviceMake", "Oculus");
            client.put("deviceModel", "Quest 3");
            client.put("androidSdkVersion", 32);
            client.put("osName", "Android");
            client.put("osVersion", "12");
            client.put("userAgent", VR_UA);
        } else {
            client.put("clientName", "WEB");
            client.put("clientVersion", WEB_VERSION);
        }
        client.put("hl", "en");
        client.put("gl", "US");
        client.put("utcOffsetMinutes", 0);
        ctx.put("client", client);
        body.put("context", ctx);
        body.put("videoId", videoId);
        body.put("contentCheckOk", true);
        body.put("racyCheckOk", true);

        String ua = vr ? VR_UA : WEB_UA;
        HttpURLConnection c = (HttpURLConnection) new URL(
                INNERTUBE + "?key=" + INNERTUBE_KEY + "&prettyPrint=false").openConnection();
        c.setConnectTimeout(8000);
        c.setReadTimeout(15000);
        c.setRequestMethod("POST");
        c.setDoOutput(true);
        c.setRequestProperty("Content-Type", "application/json");
        c.setRequestProperty("User-Agent", ua);
        c.setRequestProperty("X-Youtube-Client-Name", vr ? "28" : "1");
        c.setRequestProperty("X-Youtube-Client-Version", vr ? VR_VERSION : WEB_VERSION);
        c.setRequestProperty("Accept-Language", "en");
        c.setRequestProperty("Origin", "https://www.youtube.com");
        c.setRequestProperty("Referer", "https://www.youtube.com/");
        String ck = sCookieHeader;
        if (ck != null && !ck.isEmpty()) c.setRequestProperty("Cookie", ck);
        if (!vr) {
            String sap = cookie("SAPISID");
            if (sap.isEmpty()) sap = cookie("__Secure-3PAPISID");
            if (sap.isEmpty()) sap = cookie("__Secure-1PAPISID");
            String authz = sap.isEmpty() ? "" : sapisidHash(sap);
            if (!authz.isEmpty()) c.setRequestProperty("Authorization", authz);
        }
        JSONObject j;
        try {
            OutputStream os = c.getOutputStream();
            os.write(body.toString().getBytes(StandardCharsets.UTF_8));
            os.close();
            int code = c.getResponseCode();
            if (code >= 400) throw new IOException("innertube HTTP " + code + " " + errSnippet(c));
            byte[] raw = YandexClient.readAll(c.getInputStream());
            j = new JSONObject(new String(raw, StandardCharsets.UTF_8));
        } finally {
            try { c.disconnect(); } catch (Throwable e) { }
        }
        JSONObject ps = j.optJSONObject("playabilityStatus");
        android.util.Log.i("VotBridge", "it player " + (vr ? "VR" : "WEB") + " id=" + videoId
                + " status=" + (ps == null ? "?" : ps.optString("status", "?"))
                + " login=" + (sCookieLoggedIn ? 1 : 0));
        return j;
    }

    private static boolean hasParam(String url, String param) {
        int q = url.indexOf('?');
        if (q < 0) return false;
        String[] kv = url.substring(q + 1).split("&");
        for (String s : kv) {
            int eq = s.indexOf('=');
            String k = eq < 0 ? s : s.substring(0, eq);
            if (k.equals(param)) return true;
        }
        return false;
    }

    private static String queryParam(String path, String key) {
        int q = path.indexOf('?');
        if (q < 0) return "";
        String[] kv = path.substring(q + 1).split("&");
        for (String s : kv) {
            int eq = s.indexOf('=');
            String k = eq < 0 ? s : s.substring(0, eq);
            if (!k.equals(key)) continue;
            String v = eq < 0 ? "" : s.substring(eq + 1);
            try {
                return java.net.URLDecoder.decode(v, "UTF-8");
            } catch (Throwable e) {
                return v;
            }
        }
        return "";
    }

    // Diagnostics only: cookie NAMES, never values.
    private static String handleYtSession() {
        refreshCookies(true);
        JSONObject o = new JSONObject();
        try {
            o.put("loggedIn", sCookieLoggedIn);
            o.put("count", sCookieMap.size());
            JSONArray auth = new JSONArray();
            for (String a : AUTH_COOKIES) if (sCookieMap.containsKey(a)) auth.put(a);
            o.put("auth", auth);
            o.put("names", sCookieNames);
            o.put("headerLen", sCookieHeader.length());
            o.put("err", sCookieErr);
            o.put("dataDir", sDataDir);
        } catch (Throwable ignored) { }
        android.util.Log.i("VotBridge", "yt_session " + o);
        return o.toString();
    }

    // Direct audio URLs for the native filler: the JS side gets the real
    // googlevideo link (and whether it still needs the "n" transform) instead
    // of asking the PC to run yt-dlp.
    private static JSONObject handleYtUrl(String videoId, boolean vr) throws Exception {
        JSONObject j = itPlayer(videoId, vr);
        JSONObject out = new JSONObject();
        out.put("videoId", videoId);
        out.put("client", vr ? "ANDROID_VR" : "WEB");
        out.put("loggedIn", sCookieLoggedIn);
        JSONObject ps = j.optJSONObject("playabilityStatus");
        String st = ps == null ? "" : ps.optString("status", "");
        out.put("status", st);
        if (ps != null) out.put("reason", ps.optString("reason", ""));
        JSONObject vd = j.optJSONObject("videoDetails");
        if (vd != null) {
            out.put("title", vd.optString("title", ""));
            out.put("duration", vd.optInt("lengthSeconds", 0));
        }
        JSONArray arr = new JSONArray();
        JSONObject sd = j.optJSONObject("streamingData");
        JSONArray fmts = sd == null ? null : sd.optJSONArray("adaptiveFormats");
        boolean hasN = false;
        int cipher = 0;
        if (fmts != null) {
            for (int i = 0; i < fmts.length(); i++) {
                JSONObject f = fmts.optJSONObject(i);
                if (f == null) continue;
                int itag = f.optInt("itag", 0);
                String mime = f.optString("mimeType", "");
                String url = f.optString("url", "");
                if (url.isEmpty()) {
                    if (!f.optString("signatureCipher", "").isEmpty()
                            || !f.optString("cipher", "").isEmpty()) cipher++;
                    continue;
                }
                boolean audio = mime.startsWith("audio/")
                        || (itag >= 139 && itag <= 141) || itag == 249 || itag == 250 || itag == 251;
                if (!audio) continue;
                JSONObject o = new JSONObject();
                o.put("itag", itag);
                o.put("mime", mime);
                long clen = f.optLong("contentLength", 0L);
                if (clen <= 0) clen = qclen(url);
                o.put("clen", clen);
                o.put("url", url);
                boolean n = hasParam(url, "n");
                o.put("n", n);
                if (n) hasN = true;
                arr.put(o);
            }
        }
        out.put("formats", arr);
        out.put("hasN", hasN);
        out.put("ciphered", cipher);
        out.put("sabr", sd != null && sd.has("serverAbrStreamingUrl"));
        return out;
    }

    // Port of dev_server/yt_lang.py: original language in ~0.5 s without the PC.
    private static String metaLocal(String videoId) {
        synchronized (META_CACHE) {
            MetaEntry e = META_CACHE.get(videoId);
            if (e != null) {
                long age = System.currentTimeMillis() - e.at;
                if (age < (e.ok ? 6L * 3600L * 1000L : 120000L)) {
                    try {
                        JSONObject copy = new JSONObject(e.json.toString());
                        copy.put("cached", true);
                        copy.put("ms", 0);
                        return copy.toString();
                    } catch (Throwable ignored) { }
                }
            }
        }
        long t0 = System.currentTimeMillis();
        JSONObject out = new JSONObject();
        boolean ok = false;
        try {
            String used = "WEB";
            JSONObject j = itPlayer(videoId, false);
            String st = playability(j);
            if (!"OK".equals(st)) {
                // Без живого логина WEB на большинстве роликов отдаёт
                // UNPLAYABLE/LOGIN_REQUIRED, а ANDROID_VR тот же ролик отдаёт:
                // язык берём из его ответа (yt_lang.py опирался на WEB+куки).
                out.put("webStatus", st);
                used = "ANDROID_VR";
                j = itPlayer(videoId, true);
                st = playability(j);
            }
            out.put("client", used);
            if (!"OK".equals(st)) {
                out.put("ok", false);
                out.put("err", ("playability=" + st + " " + playReason(j)).trim());
            } else {
                String lang = fillLang(j, out);
                out.put("videoId", videoId);
                out.put("login", sCookieLoggedIn ? 1 : 0);
                if (lang.isEmpty()) {
                    out.put("ok", false);
                    out.put("err", "no audio/caption language");
                } else {
                    ok = true;
                    out.put("ok", true);
                }
            }
        } catch (Throwable e) {
            try {
                out.put("ok", false);
                out.put("err", String.valueOf(e.getMessage()));
            } catch (Throwable ignored) { }
        }
        long ms = System.currentTimeMillis() - t0;
        try {
            out.put("ms", ms);
            out.put("cached", false);
        } catch (Throwable ignored) { }
        synchronized (META_CACHE) {
            META_CACHE.put(videoId, new MetaEntry(System.currentTimeMillis(), ok, out));
        }
        android.util.Log.i("VotBridge", "meta_local " + videoId + " "
                + (ok ? "lang=" + out.optString("lang") : "err=" + out.optString("err"))
                + " " + ms + "ms");
        return out.toString();
    }

    private static String playability(JSONObject j) {
        JSONObject ps = j.optJSONObject("playabilityStatus");
        return ps == null ? "" : ps.optString("status", "");
    }

    private static String playReason(JSONObject j) {
        JSONObject ps = j.optJSONObject("playabilityStatus");
        return ps == null ? "" : ps.optString("reason", "");
    }

    // lang/audioTracks/title/duration из ответа player'а — как в yt_lang.py:
    // порядок дорожек нестабилен, поэтому берём defaultAudioTrackIndex, а не [0].
    private static String fillLang(JSONObject j, JSONObject out) throws Exception {
        String atid = "";
        int idx = 0;
        JSONArray ids = new JSONArray();
        JSONObject caps = j.optJSONObject("captions");
        JSONObject rend = caps == null ? null : caps.optJSONObject("playerCaptionsTracklistRenderer");
        if (rend != null) {
            JSONArray tracks = rend.optJSONArray("audioTracks");
            int n = tracks == null ? 0 : tracks.length();
            if (n > 0) {
                idx = rend.optInt("defaultAudioTrackIndex", 0);
                if (idx < 0 || idx >= n) idx = 0;
                for (int i = 0; i < n && i < 12; i++) {
                    JSONObject t = tracks.optJSONObject(i);
                    String id = t == null ? "" : t.optString("audioTrackId", "");
                    ids.put(id);
                    if (i == idx) atid = id;
                }
            }
        }
        if (atid.equalsIgnoreCase("none") || atid.equalsIgnoreCase("null")) atid = "";
        int dot = atid.indexOf('.');
        String lang = dot > 0 ? atid.substring(0, dot) : atid;
        if (lang.isEmpty() && rend != null) {
            JSONArray ct = rend.optJSONArray("captionTracks");
            JSONObject c0 = ct == null || ct.length() == 0 ? null : ct.optJSONObject(0);
            if (c0 != null) lang = c0.optString("languageCode", "");
        }
        out.put("lang", lang);
        out.put("audioTrackId", atid);
        out.put("audioIndex", idx);
        out.put("audioTracks", ids);
        JSONObject vd = j.optJSONObject("videoDetails");
        if (vd != null) {
            out.put("title", vd.optString("title", ""));
            out.put("duration", vd.optString("lengthSeconds", ""));
        }
        return lang;
    }

    // ---------------------------------------------------------------------
    // HTTP server
    // ---------------------------------------------------------------------
    private static void serve() {
        try (ServerSocket ss = new ServerSocket(8013, 50, InetAddress.getByName("127.0.0.1"))) {
            while (true) {
                final Socket s = ss.accept();
                Thread h = new Thread(() -> handle(s), "vot-bridge-conn");
                h.setDaemon(true);
                h.start();
            }
        } catch (Throwable e) {
            android.util.Log.e("VotBridge", "server died", e);
        }
    }

    private static void handle(Socket s) {
        try (Socket cs = s) {
            cs.setSoTimeout(20000);
            InputStream in = cs.getInputStream();
            String reqLine = readLine(in);
            if (reqLine == null || reqLine.isEmpty()) return;
            String[] parts = reqLine.split(" ");
            if (parts.length < 2) return;
            String method = parts[0];
            String path = parts[1];
            android.util.Log.i("VotBridge", "req " + method + " " + path);

            if ("OPTIONS".equals(method)) {
                OutputStream out = cs.getOutputStream();
                out.write(("HTTP/1.1 204 No Content\r\n" +
                    "Access-Control-Allow-Origin: *\r\n" +
                    "Access-Control-Allow-Headers: *\r\n" +
                    "Access-Control-Allow-Methods: GET, POST, PUT, OPTIONS\r\n" +
                    "Access-Control-Allow-Private-Network: true\r\n" +
                    "Access-Control-Max-Age: 86400\r\n" +
                    "Content-Length: 0\r\n\r\n").getBytes(StandardCharsets.US_ASCII));
                out.flush();
                return;
            }

            int contentLength = 0;
            String line;
            while ((line = readLine(in)) != null && !line.isEmpty()) {
                int c = line.indexOf(':');
                if (c > 0 && line.substring(0, c).trim().equalsIgnoreCase("content-length")) {
                    try { contentLength = Integer.parseInt(line.substring(c + 1).trim()); } catch (Exception e) { }
                }
            }

            byte[] body = new byte[0];
            if (contentLength > 0 && contentLength < (4 * 1024 * 1024)) {
                body = readN(in, contentLength);
            }

            String resp = "";
            String ctype = "application/json; charset=utf-8";
            int code = 200;

            try {
                if (path.startsWith("/ping")) {
                    resp = "{\"ok\":1,\"service\":\"vot-bridge\"}";
                } else if (path.startsWith("/translate")) {
                    JSONObject req = body.length > 0 ? new JSONObject(new String(body, StandardCharsets.UTF_8)) : new JSONObject();
                    resp = handleTranslate(req).toString();
                } else if (path.startsWith("/failaudio")) {
                    JSONObject req = body.length > 0 ? new JSONObject(new String(body, StandardCharsets.UTF_8)) : new JSONObject();
                    resp = handleFailAudio(req).toString();
                } else if (path.startsWith("/cap/begin")) {
                    resp = capBegin(queryParam(path, "videoId"), body).toString();
                } else if (path.startsWith("/cap/chunk")) {
                    resp = capChunk(body).toString();
                } else if (path.startsWith("/cap/end")) {
                    resp = capEnd().toString();
                } else if (path.startsWith("/cap/drop")) {
                    resp = capDrop().toString();
                } else if (path.startsWith("/cap/status")) {
                    resp = capStatus(queryParam(path, "videoId")).toString();
                } else if (path.startsWith("/cap/upload")) {
                    int itag = 140;
                    try {
                        itag = Integer.parseInt(queryParam(path, "itag"));
                    } catch (Throwable ignore) { }
                    resp = capUpload(queryParam(path, "videoId"),
                            queryParam(path, "translationId"), itag).toString();
                } else if (path.startsWith("/audio")) {
                    JSONObject req = body.length > 0 ? new JSONObject(new String(body, StandardCharsets.UTF_8)) : new JSONObject();
                    resp = handleAudio(req).toString();
                } else if (path.startsWith("/fill_status")) {
                    String fid = "";
                    int q = path.indexOf("videoId=");
                    if (q >= 0) {
                        fid = path.substring(q + 8);
                        int amp = fid.indexOf('&');
                        if (amp >= 0) fid = fid.substring(0, amp);
                    }
                    resp = handleFillStatus(fid);
                } else if (path.startsWith("/fill")) {
                    JSONObject req = body.length > 0 ? new JSONObject(new String(body, StandardCharsets.UTF_8)) : new JSONObject();
                    resp = handleFill(req).toString();
                } else if (path.startsWith("/session")) {
                    JSONObject r = new JSONObject();
                    YandexSession se = YandexClient.ensureSession();
                    r.put("sessionKey", se == null ? "" : se.sk);
                    resp = r.toString();
                } else if (path.startsWith("/play")) {
                    JSONObject req = body.length > 0 ? new JSONObject(new String(body, StandardCharsets.UTF_8)) : new JSONObject();
                    String url = req.optString("url", "");
                    double offset = req.optDouble("offsetSec", 0);
                    if (url.isEmpty()) throw new IOException("missing url");
                    playAudio(url, offset);
                    resp = "{\"ok\":1,\"playing\":\"starting\"}";
                } else if (path.startsWith("/volume")) {
                    JSONObject req = body.length > 0 ? new JSONObject(new String(body, StandardCharsets.UTF_8)) : new JSONObject();
                    setAudioVolume(req.optDouble("pct", 100));
                    resp = "{\"ok\":1}";
                } else if (path.startsWith("/pause")) {
                    pauseAudio();
                    resp = "{\"ok\":1}";
                } else if (path.startsWith("/resume")) {
                    resumeAudio();
                    resp = "{\"ok\":1}";
                } else if (path.startsWith("/seek")) {
                    JSONObject req = body.length > 0 ? new JSONObject(new String(body, StandardCharsets.UTF_8)) : new JSONObject();
                    double offset = req.optDouble("offsetSec", 0);
                    seekAudio(offset);
                    resp = "{\"ok\":1}";
                } else if (path.startsWith("/stop")) {
                    stopAudio();
                    resp = "{\"ok\":1}";
                } else if (path.startsWith("/position")) {
                    resp = positionJson();
                } else if (path.startsWith("/config")) {
                    JSONObject req = body.length > 0 ? new JSONObject(new String(body, StandardCharsets.UTF_8)) : new JSONObject();
                    resp = handleConfig(req).toString();
                } else if (path.startsWith("/yt_session")) {
                    resp = handleYtSession();
                } else if (path.startsWith("/yt_url")) {
                    String vid = queryParam(path, "videoId");
                    if (vid.isEmpty()) throw new IOException("missing videoId");
                    resp = handleYtUrl(vid, !"web".equalsIgnoreCase(queryParam(path, "client"))).toString();
                } else if (path.startsWith("/meta_local")) {
                    String vid = queryParam(path, "videoId");
                    if (vid.isEmpty()) throw new IOException("missing videoId");
                    resp = metaLocal(vid);
                } else if (path.startsWith("/log")) {
                    String msg = body.length > 0 ? new String(body, StandardCharsets.UTF_8) : "";
                    android.util.Log.i("VotBridge", "js: " + msg);
                    resp = "{\"ok\":1}";
                } else if (path.startsWith("/vot.js")) {
                    byte[] ov = sOverlay;
                    if (ov == null || ov.length == 0) { code = 503; ctype = "text/plain"; resp = "no overlay"; }
                    else { ctype = "application/javascript; charset=utf-8"; resp = new String(ov, StandardCharsets.UTF_8); }
                } else {
                    code = 404;
                    resp = "{\"error\":\"not found\"}";
                }
            } catch (Throwable e) {
                code = 500;
                android.util.Log.e("VotBridge", "req FAILED " + method + " " + path + " : " + e);
                resp = "{\"error\":\"" + safeJson(String.valueOf(e.getMessage())) + "\"}";
            }

            byte[] rb = resp.getBytes(StandardCharsets.UTF_8);
            OutputStream out = cs.getOutputStream();
            String head = "HTTP/1.1 " + code + " OK\r\n" +
                    "Content-Type: " + ctype + "\r\n" +
                    "Access-Control-Allow-Origin: *\r\n" +
                    "Access-Control-Allow-Headers: *\r\n" +
                    "Access-Control-Allow-Methods: GET, POST, PUT, OPTIONS\r\n" +
                    "Access-Control-Allow-Private-Network: true\r\n" +
                    "Cache-Control: no-store\r\n" +
                    "Content-Length: " + rb.length + "\r\n" +
                    "Connection: close\r\n\r\n";
            out.write(head.getBytes(StandardCharsets.US_ASCII));
            out.write(rb);
            out.flush();
        } catch (Throwable ignored) {
        }
    }

    private static JSONObject configJson() throws Exception {
        JSONObject o = new JSONObject();
        o.put("lively", sLively);
        o.put("hasToken", sOauthToken != null && !sOauthToken.isEmpty());
        o.put("worker", sWorker == null ? "" : sWorker);
        o.put("mediaProxy", sMediaProxy == null ? "" : sMediaProxy);
        o.put("proxyMode", sProxyMode == null ? "off" : sProxyMode);
        o.put("faMode", sFaMode == null ? "audio" : sFaMode);
        o.put("audioMode", sAudioMode == null ? "off" : sAudioMode);
        o.put("pcFill", sPcFill);
        return o;
    }

    // GET /config -> current values; POST /config {key:value,...} -> patch + return.
    private static JSONObject handleConfig(JSONObject req) throws Exception {
        if (req != null && req.length() > 0) {
            if (req.has("lively")) sLively = req.optBoolean("lively", false);
            if (req.has("token")) sOauthToken = req.optString("token", "");
            if (req.has("worker")) sWorker = req.optString("worker", "");
            if (req.has("mediaProxy")) sMediaProxy = req.optString("mediaProxy", "");
            if (req.has("proxyMode")) sProxyMode = req.optString("proxyMode", "off");
            if (req.has("faMode")) sFaMode = req.optString("faMode", "audio");
            if (req.has("audioMode")) sAudioMode = req.optString("audioMode", "off");
            if (req.has("pcFill")) sPcFill = req.optBoolean("pcFill", true);
            android.util.Log.i("VotBridge", "config " + configJson().toString());
        }
        return configJson();
    }

    private static JSONObject handleTranslate(JSONObject req) throws Exception {
        String videoUrl = req.optString("videoUrl", "");
        double duration = req.optDouble("duration", 0);
        boolean firstRequest = req.optBoolean("firstRequest", true);
        String lang = req.optString("lang", "auto");
        String target = req.optString("targetLang", "ru");
        String title = req.optString("title", "");
        // Live voices are only meaningful for English -> Russian and require a
        // Yandex OAuth token; without one Yandex answers SESSION_REQUIRED.
        boolean lively = req.has("lively")
                ? req.optBoolean("lively", false)
                : (sLively && "ru".equals(target));

        if (videoUrl.isEmpty()) throw new IOException("missing videoUrl");
        if (!(duration > 0)) throw new IOException("missing duration");

        YandexSession se = YandexClient.ensureSession();
        if (se == null) throw new IOException("no session");

        byte[] body = YandexClient.buildTranslate(videoUrl, duration, firstRequest, lang, target, title, lively);
        Map<String, String> headers = YandexClient.authHeaders(se, body, "/video-translation/translate", lively);

        android.util.Log.i("VotBridge", "translate req url=" + videoUrl
                + " dur=" + duration + " first=" + firstRequest
                + " lang=" + lang + " target=" + target + " lively=" + lively
                + " titleLen=" + (title == null ? 0 : title.length()));

        byte[] resp = YandexClient.httpPost(YANDEX + "/video-translation/translate", body, headers);
        Map<Integer, Object> p = YandexClient.readProto(resp);

        // Live voices need real Yandex auth (OAuth token and/or Session_id
        // cookie). If Yandex refuses (status 7 = auth required, or an auth
        // wording in the message), silently re-ask for a normal voice so the
        // user still gets a translation instead of an error.
        if (lively && (num(p.get(4)) == 7 || looksLikeAuthError(p))) {
            android.util.Log.w("VotBridge", "lively rejected (status=" + num(p.get(4))
                    + " msg=" + (p.containsKey(9) ? p.get(9) : "-") + ") -> retry without lively");
            lively = false;
            body = YandexClient.buildTranslate(videoUrl, duration, firstRequest, lang, target, title, false);
            headers = YandexClient.authHeaders(se, body, "/video-translation/translate", false);
            resp = YandexClient.httpPost(YANDEX + "/video-translation/translate", body, headers);
            p = YandexClient.readProto(resp);
        }

        android.util.Log.i("VotBridge", "translate resp len=" + resp.length
                + " hex=" + hex(resp).substring(0, Math.min(160, hex(resp).length()))
                + " status=" + num(p.get(4))
                + " msg=" + (p.containsKey(9) ? String.valueOf(p.get(9)) : "-")
                + " audio=" + (p.containsKey(1) ? "yes" : "no")
                + " tid=" + (p.containsKey(7) ? String.valueOf(p.get(7)) : "-")
                + " lively=" + (p.containsKey(10) ? String.valueOf(num(p.get(10))) : "-")
                // Field 8 is the source language Yandex detected, 11/12 are its
                // verdicts: "this video may be translated" and "retry makes sense".
                // The extension (vot.js 1.12.2) reads all three; we only logged them
                // as raw hex before. Seeing them in the log proves the semantics.
                + " lang8=" + (p.containsKey(8) ? String.valueOf(p.get(8)) : "-")
                + " allow=" + (p.containsKey(11) ? String.valueOf(num(p.get(11))) : "-")
                + " retry=" + (p.containsKey(12) ? String.valueOf(num(p.get(12))) : "-"));

        JSONObject out = new JSONObject();
        out.put("status", num(p.get(4)));
        if (p.containsKey(5)) out.put("remaining", num(p.get(5)));
        if (p.containsKey(7)) out.put("translationId", String.valueOf(p.get(7)));
        if (p.containsKey(1)) out.put("audioUrl", String.valueOf(p.get(1)));
        if (p.containsKey(9)) out.put("message", String.valueOf(p.get(9)));
        if (p.containsKey(2)) out.put("duration", dnum(p.get(2)));
        out.put("lively", p.containsKey(10) && num(p.get(10)) != 0);
        // 8 = source language of the video (never empty in a normal answer).
        // It arrives in the very first response (~1-2 s), which is far faster
        // than the PC metadata path (yt-dlp, cold cache ~10 s), so the JS side
        // can decide "this is Russian, do not translate" from the answer itself.
        if (p.containsKey(8)) {
            String lang8 = String.valueOf(p.get(8));
            if (!lang8.isEmpty() && !"null".equals(lang8)) out.put("lang", lang8);
        }
        // 11 = allowToTranslateVideo, 12 = shouldRetry. Both optional: absent
        // means Yandex said nothing and the JS fallback keeps its old behaviour.
        if (p.containsKey(11)) out.put("allow", num(p.get(11)) != 0);
        if (p.containsKey(12)) out.put("shouldRetry", num(p.get(12)) != 0);
        return out;
    }

    // ---- MSE audio capture (path E) -------------------------------------
    // Youtube has removed direct audio urls: the player response for a normal
    // TV session carries adaptiveFormats but url=0 / audioUrl=0, SABR only. The
    // page therefore tees the bytes the stock player already feeds into its
    // audio SourceBuffer and posts them here. Init segment (ftyp+moov) comes
    // first, then media fragments (moof+mdat) in playback order, so a plain
    // append of everything is a valid fragmented MP4 that Yandex accepts.
    private static final Object CAP_LOCK = new Object();
    private static final long CAP_MAX = 64L * 1024L * 1024L;
    private static java.io.OutputStream sCapOut;
    private static File sCapFile;
    private static long sCapSize;
    private static String sCapVid = "";
    private static boolean sCapFull;

    private static void capCloseLocked() {
        if (sCapOut != null) {
            try { sCapOut.flush(); sCapOut.close(); } catch (Throwable ignore) { }
            sCapOut = null;
        }
    }

    private static JSONObject capBegin(String vid, byte[] data) throws Exception {
        synchronized (CAP_LOCK) {
            capCloseLocked();
            if (sCacheDir == null || sCacheDir.isEmpty()) throw new IOException("no cache dir");
            String safe = String.valueOf(vid).replaceAll("[^A-Za-z0-9_-]", "");
            if (safe.isEmpty()) safe = "vid";
            sCapFile = new File(sCacheDir, "cap_" + safe + ".mp4");
            sCapVid = safe;
            sCapSize = 0;
            sCapFull = false;
            sCapOut = new java.io.BufferedOutputStream(new java.io.FileOutputStream(sCapFile, false), 65536);
            if (data != null && data.length > 0) {
                sCapOut.write(data);
                sCapSize += data.length;
            }
            // Cache hygiene: a 486 MB TV should not accumulate captures. Upload
            // happens in the same video session, so older files are dead weight.
            try {
                File[] old = new File(sCacheDir).listFiles();
                if (old != null) {
                    for (File f : old) {
                        String n = f.getName();
                        if (n.startsWith("cap_") && n.endsWith(".mp4") && !f.equals(sCapFile)) {
                            //noinspection ResultOfMethodCallIgnored
                            f.delete();
                        }
                    }
                }
            } catch (Throwable ignore) { }
            android.util.Log.i("VotBridge", "cap begin vid=" + safe
                    + " init=" + (data == null ? 0 : data.length));
            JSONObject o = new JSONObject();
            o.put("ok", 1);
            o.put("vid", safe);
            o.put("size", sCapSize);
            return o;
        }
    }

    private static JSONObject capChunk(byte[] data) throws Exception {
        synchronized (CAP_LOCK) {
            JSONObject o = new JSONObject();
            if (sCapOut == null) {
                o.put("ok", 0);
                o.put("error", "not started");
                return o;
            }
            if (sCapFull || sCapSize >= CAP_MAX) {
                sCapFull = true;
                o.put("ok", 0);
                o.put("full", 1);
                o.put("size", sCapSize);
                return o;
            }
            if (data != null && data.length > 0) {
                sCapOut.write(data);
                sCapSize += data.length;
            }
            o.put("ok", 1);
            o.put("size", sCapSize);
            return o;
        }
    }

    private static JSONObject capEnd() throws Exception {
        synchronized (CAP_LOCK) {
            capCloseLocked();
            android.util.Log.i("VotBridge", "cap end vid=" + sCapVid + " bytes=" + sCapSize);
            JSONObject o = new JSONObject();
            o.put("ok", 1);
            o.put("vid", sCapVid);
            o.put("size", sCapSize);
            return o;
        }
    }

    private static JSONObject capStatus(String vid) throws Exception {
        synchronized (CAP_LOCK) {
            JSONObject o = new JSONObject();
            o.put("vid", sCapVid);
            o.put("size", sCapSize);
            o.put("open", sCapOut == null ? 0 : 1);
            o.put("full", sCapFull ? 1 : 0);
            o.put("exists", sCapFile != null && sCapFile.isFile() ? 1 : 0);
            // Also report the file of a concrete videoId: after a channel switch
            // "the current capture" belongs to a different video.
            if (vid != null && !vid.isEmpty()) {
                File f = capFileFor(vid);
                if (f != null && f.isFile()) {
                    boolean current = f.equals(sCapFile) && sCapOut != null;
                    long n = f.length();
                    if (current) {
                        try { sCapOut.flush(); } catch (Throwable ignore) { }
                        n = Math.max(n, sCapSize);
                    }
                    o.put("fileSize", n);
                    o.put("fileCurrent", current ? 1 : 0);
                }
            }
            return o;
        }
    }

    private static JSONObject capStatus() throws Exception {
        return capStatus("");
    }

    private static JSONObject capDrop() throws Exception {
        synchronized (CAP_LOCK) {
            capCloseLocked();
            if (sCapFile != null) {
                //noinspection ResultOfMethodCallIgnored
                sCapFile.delete();
            }
            JSONObject o = new JSONObject();
            o.put("ok", 1);
            o.put("dropped", true);
            sCapSize = 0;
            sCapVid = "";
            sCapFull = false;
            return o;
        }
    }

    private static File capFileFor(String vid) {
        if (sCacheDir == null || sCacheDir.isEmpty()) return null;
        String safe = String.valueOf(vid).replaceAll("[^A-Za-z0-9_-]", "");
        if (safe.isEmpty()) return null;
        return new File(sCacheDir, "cap_" + safe + ".mp4");
    }

    // Capture files are per-video and nothing removes them on the next start, so
    // a 6+ MB cap_*.mp4 can sit in the TV cache for days. Wipe them at boot.
    private static void capCleanupStale() {
        try {
            if (sCacheDir == null || sCacheDir.isEmpty()) return;
            File dir = new File(sCacheDir);
            File[] list = dir.listFiles();
            if (list == null) return;
            int n = 0;
            long bytes = 0;
            for (int i = 0; i < list.length; i++) {
                File f = list[i];
                if (f == null) continue;
                String name = f.getName();
                if (name == null || !name.startsWith("cap_") || !name.endsWith(".mp4")) continue;
                long len = f.length();
                try {
                    if (f.delete()) {
                        n++;
                        bytes += len;
                    }
                } catch (Throwable ignore) { }
            }
            android.util.Log.i("VotBridge", "cap cleanup files=" + n + " bytes=" + bytes);
        } catch (Throwable e) {
            android.util.Log.w("VotBridge", "cap cleanup failed: " + e);
        }
    }

    private static byte[] capReadFile(File f) throws IOException {
        if (f == null || !f.isFile()) throw new IOException("no capture file");
        long n = f.length();
        if (n <= 0) throw new IOException("capture empty");
        byte[] out = new byte[(int) n];
        java.io.DataInputStream in = new java.io.DataInputStream(
                new java.io.BufferedInputStream(new java.io.FileInputStream(f), 65536));
        try {
            in.readFully(out);
        } finally {
            try { in.close(); } catch (Throwable ignore) { }
        }
        return out;
    }

    // One capture file per video: the TV switches videos on its own (autoplay,
    // resume, user click), so "the current capture" is not the one the caller
    // asked for. Upload strictly by videoId.
    private static JSONObject capUpload(String vid, String tid, int itag) throws Exception {
        if (vid == null || vid.isEmpty()) throw new IOException("missing videoId");
        if (tid == null || tid.isEmpty()) throw new IOException("missing translationId");
        File wanted = capFileFor(vid);
        byte[] data;
        synchronized (CAP_LOCK) {
            boolean current = wanted != null && wanted.equals(sCapFile) && sCapOut != null;
            if (current) {
                // Still recording this very video: flush, do not close, the tee
                // keeps feeding the player.
                try { sCapOut.flush(); } catch (Throwable ignore) { }
            }
            data = capReadFile(current ? sCapFile : wanted);
        }
        YandexSession se = YandexClient.ensureSession();
        if (se == null) throw new IOException("no session");
        String videoUrl = "https://www.youtube.com/watch?v=" + vid;
        String fileId = YandexClient.buildFileId(itag, String.valueOf(data.length));
        long t0 = System.currentTimeMillis();
        YandexClient.uploadStreamedAudio(se, videoUrl, tid, fileId, data);
        android.util.Log.i("VotBridge", "cap uploaded vid=" + vid + " bytes=" + data.length
                + " itag=" + itag + " tid=" + tid + " in " + (System.currentTimeMillis() - t0) + "ms");
        JSONObject o = new JSONObject();
        o.put("ok", 1);
        o.put("vid", vid);
        o.put("size", data.length);
        o.put("itag", itag);
        o.put("ms", System.currentTimeMillis() - t0);
        return o;
    }

    // Download source audio (DASH itag URL) and upload it to Yandex VOT so the
    // server can produce the translation (status 6 => AUDIO_REQUESTED path).
    private static JSONObject handleAudio(JSONObject req) throws Exception {
        String videoUrl = req.optString("videoUrl", "");
        String translationId = req.optString("translationId", "");
        String audioUrl = req.optString("audioUrl", "");
        int itag = req.optInt("itag", 0);

        if (videoUrl.isEmpty()) throw new IOException("missing videoUrl");
        if (translationId.isEmpty()) throw new IOException("missing translationId");
        if (audioUrl.isEmpty()) throw new IOException("missing audioUrl");

        YandexSession se = YandexClient.ensureSession();
        if (se == null) throw new IOException("no session");

        android.util.Log.i("VotBridge", "audio download start itag=" + itag
                + " url=" + audioUrl.substring(0, Math.min(audioUrl.length(), 120)));

        String ua = req.optString("ua", "");
        String win = probeAudioUa(audioUrl, ua);
        if (win == null) throw new IOException("no user-agent accepted the audio url (see audio ua[i] codes)");
        byte[] data = httpGetFull(audioUrl, win);
        if (data == null || data.length == 0) throw new IOException("audio download empty");

        android.util.Log.i("VotBridge", "audio downloaded bytes=" + data.length);

        String fileId = YandexClient.buildFileId(itag, String.valueOf(data.length));
        YandexClient.uploadStreamedAudio(se, videoUrl, translationId, fileId, data);

        android.util.Log.i("VotBridge", "audio uploaded bytes=" + data.length);

        JSONObject out = new JSONObject();
        out.put("ok", 1);
        out.put("size", data.length);
        return out;
    }

    // Cheap workaround for status 6 (AUDIO_REQUESTED): tell Yandex that the
    // in-browser audio probe failed, upload an empty audio buffer and let the
    // server fetch the track itself. No YouTube/InnerTube download involved
    // (that path dies on LOGIN_REQUIRED bot checks).
    private static JSONObject handleFailAudio(JSONObject req) throws Exception {
        String videoUrl = req.optString("videoUrl", "");
        String videoId = req.optString("videoId", "");
        String translationId = req.optString("translationId", "");
        if (videoUrl.isEmpty()) throw new IOException("missing videoUrl");
        if (translationId.isEmpty()) throw new IOException("missing translationId");

        JSONObject out = new JSONObject();
        // "skip" = leave status 6 alone and let Yandex do whatever it does next
        // (A/B experiment: our empty-audio attempt may be what poisons the job).
        if (sFaMode != null && sFaMode.trim().toLowerCase().startsWith("skip")) {
            out.put("ok", 1);
            out.put("skipped", true);
            android.util.Log.i("VotBridge", "failaudio skipped by config");
            return out;
        }

        YandexSession se = YandexClient.ensureSession();
        if (se == null) throw new IOException("no session");

        byte[] jb = ("{\"video_url\":\"" + safeJson(videoUrl) + "\"}").getBytes(StandardCharsets.UTF_8);
        Map<String, String> h = YandexClient.authHeaders(se, jb, "/video-translation/fail-audio-js");
        byte[] fr = YandexClient.httpPutJson(YANDEX + "/video-translation/fail-audio-js", jb, h);
        String fs = new String(fr, StandardCharsets.UTF_8).replace('\n', ' ');
        if (fs.length() > 200) fs = fs.substring(0, 200);
        android.util.Log.i("VotBridge", "fail-audio-js resp=" + fs);

        // Two known markers. SmartTube uses the "web_api_..." one with an empty
        // buffer, vot.js uses "fallback-empty-audio:...". Pick via config so we
        // can A/B them without a rebuild.
        boolean votjs = sFaMode != null && sFaMode.trim().toLowerCase().startsWith("votjs");
        String fid = votjs
                ? "fallback-empty-audio:video-translation:" + videoId
                : "web_api_get_all_generating_urls_data_from_iframe";
        byte[] ab = YandexClient.encodeSingleAudioRequest(videoUrl, translationId, fid, new byte[0]);
        Map<String, String> ah = YandexClient.authHeaders(se, ab, "/video-translation/audio");
        YandexClient.httpPut(YANDEX + "/video-translation/audio", ab, ah);
        android.util.Log.i("VotBridge", "fail-audio-js empty audio sent tid=" + translationId + " fileId=" + fid);

        out.put("ok", 1);
        out.put("failAudio", true);
        out.put("fileId", fid);
        return out;
    }

    // ---------------------------------------------------------------------
    // native audio playback (MediaPlayer on a dedicated HandlerThread)
    // ---------------------------------------------------------------------
    private static void ensureAudioThread() {
        synchronized (AUDIO_LOCK) {
            if (sAudioHandler == null) {
                sAudioThread = new HandlerThread("vot-audio");
                sAudioThread.start();
                sAudioHandler = new Handler(sAudioThread.getLooper());
            }
        }
    }

    private static void playAudio(String url, double offsetSec) {
        ensureAudioThread();
        sAudioHandler.post(() -> {
            try {
                // Reuse the already-prepared player for the same track: a fresh
                // releaseAsync cycle on every /play caused the stutter loop.
                if (sPlayer != null && sPrepared && url.equals(sPlayerUrl)) {
                    try { sPlayer.seekTo((int) (offsetSec * 1000)); } catch (Throwable e) { }
                    try { sPlayer.start(); sPlaying = true; } catch (Throwable e) { }
                    android.util.Log.i("VotBridge", "play reuse+seek to " + (int) (offsetSec * 1000) + "ms");
                    return;
                }
                releaseLocked();
                MediaPlayer mp = new MediaPlayer();
                mp.setDataSource(url);
                mp.setOnPreparedListener(m -> {
                    try {
                        sPrepared = true;
                        if (offsetSec > 0) m.seekTo((int) (offsetSec * 1000));
                        m.start();
                        sPlaying = true;
                        android.util.Log.i("VotBridge", "playback started url=" + url.substring(0, Math.min(url.length(), 60)));
                    } catch (Throwable e) {
                        android.util.Log.e("VotBridge", "onPrepared failed", e);
                    }
                });
                mp.setOnCompletionListener(m -> { sPlaying = false; sLastPosMs = -1; });
                mp.setOnErrorListener((m, what, extra) -> {
                    android.util.Log.e("VotBridge", "MediaPlayer error " + what + "/" + extra);
                    sPrepared = false;
                    sPlaying = false;
                    return false;
                });
                sPlayer = mp;
                sPlayerUrl = url;
                sPrepared = false;
                try { mp.setVolume(sVol, sVol); } catch (Throwable e) { }
                mp.prepareAsync();
            } catch (Throwable e) {
                android.util.Log.e("VotBridge", "play failed", e);
                sPrepared = false;
                sPlaying = false;
            }
        });
    }

    // Громкость перевода (0…100 %). JS не может управлять звуком MediaPlayer,
    // поэтому уровень задаётся этим эндпоинтом и запоминается в sVol.
    private static void setAudioVolume(double pct) {
        if (Double.isNaN(pct) || pct < 0) pct = 0;
        if (pct > 100) pct = 100;
        final float v = (float) (pct / 100.0);
        sVol = v;
        ensureAudioThread();
        sAudioHandler.post(() -> {
            try { if (sPlayer != null) sPlayer.setVolume(v, v); } catch (Throwable e) { }
        });
        android.util.Log.i("VotBridge", "audio volume " + (int) pct + "%");
    }

    private static void seekAudio(double offsetSec) {
        ensureAudioThread();
        sAudioHandler.post(() -> {
            try {
                if (sPlayer != null && sPrepared) {
                    sPlayer.seekTo((int) (offsetSec * 1000));
                    sPlaying = sPlayer.isPlaying();
                }
            } catch (Throwable e) { }
        });
    }

    private static void pauseAudio() {
        ensureAudioThread();
        sAudioHandler.post(() -> {
            try { if (sPlayer != null) sPlayer.pause(); sPlaying = false; } catch (Throwable e) { }
        });
    }

    private static void resumeAudio() {
        ensureAudioThread();
        sAudioHandler.post(() -> {
            try { if (sPlayer != null) sPlayer.start(); sPlaying = true; } catch (Throwable e) { }
        });
    }

    private static void stopAudio() {
        ensureAudioThread();
        sAudioHandler.post(() -> { releaseLocked(); sPlaying = false; sLastPosMs = -1; });
    }

    private static void releaseLocked() {
        if (sPlayer != null) {
            try { sPlayer.stop(); } catch (Throwable e) { }
            try { sPlayer.release(); } catch (Throwable e) { }
            sPlayer = null;
        }
        sPlayerUrl = null;
        sPrepared = false;
    }

    private static String positionJson() throws Exception {
        ensureAudioThread();
        final CountDownLatch latch = new CountDownLatch(1);
        sAudioHandler.post(() -> {
            try {
                MediaPlayer mp = sPlayer;
                if (mp != null) {
                    sLastPosMs = mp.getCurrentPosition();
                    sPlaying = mp.isPlaying();
                } else {
                    sLastPosMs = -1;
                    sPlaying = false;
                }
            } catch (Throwable e) {
                sLastPosMs = -1;
                sPlaying = false;
            }
            latch.countDown();
        });
        latch.await(500, TimeUnit.MILLISECONDS);
        JSONObject r = new JSONObject();
        r.put("positionMs", sLastPosMs);
        r.put("playing", sPlaying);
        r.put("prepared", sPrepared);
        return r.toString();
    }

    // ---------------------------------------------------------------------
    // tiny HTTP + line utils
    // ---------------------------------------------------------------------
    private static String readLine(InputStream in) throws IOException {
        ByteArrayOutputStream b = new ByteArrayOutputStream();
        int c;
        while ((c = in.read()) != -1) {
            if (c == '\n') break;
            if (c != '\r') b.write(c);
        }
        if (c == -1 && b.size() == 0) return null;
        return b.toString("UTF-8");
    }

    private static byte[] readN(InputStream in, int n) throws IOException {
        byte[] b = new byte[n];
        int off = 0;
        while (off < n) {
            int r = in.read(b, off, n - off);
            if (r < 0) break;
            off += r;
        }
        return b;
    }

    private static String safeJson(String s) {
        if (s == null) return "";
        return s.replace("\\", "\\\\").replace("\"", "\\\"");
    }

    private static long num(Object o) {
        return o instanceof Number ? ((Number) o).longValue() : 0L;
    }

    private static double dnum(Object o) {
        return o instanceof Number ? ((Number) o).doubleValue() : 0.0;
    }

    // Yandex answers status 7 (auth required) for live voices without a valid
    // credential; the message text varies, so match the common wordings.
    private static boolean looksLikeAuthError(Map<Integer, Object> p) {
        if (!p.containsKey(9)) return false;
        String m = String.valueOf(p.get(9)).toLowerCase();
        return m.contains("auth") || m.contains("session") || m.contains("token")
                || m.contains("подписк") || m.contains("войдите") || m.contains("премиум");
    }

    // ---------------------------------------------------------------------
    // Yandex VOT client
    // ---------------------------------------------------------------------
    static final class YandexSession {
        final String uuid;
        final String sk;
        final long createdAtSec;
        final long expiresSec;
        YandexSession(String uuid, String sk, long createdAtSec, long expiresSec) {
            this.uuid = uuid; this.sk = sk; this.createdAtSec = createdAtSec; this.expiresSec = expiresSec;
        }
    }

    static final class YandexClient {
        private static volatile YandexSession cached;

        static synchronized YandexSession ensureSession() throws Exception {
            long now = System.currentTimeMillis() / 1000;
            if (cached != null && (cached.createdAtSec + cached.expiresSec) > now) return cached;

            String uuid = randomHex(32).toUpperCase(java.util.Locale.US);
            ByteArrayOutputStream body = new ByteArrayOutputStream();
            writeString(body, 1, uuid);
            writeString(body, 2, "video-translation");

            Map<String, String> headers = new HashMap<>();
            headers.put("Vtrans-Signature", hmacHex(body.toByteArray()));
            clientHints(headers);

            byte[] resp = httpPost(YANDEX + "/session/create", body.toByteArray(), headers);
            Map<Integer, Object> p = readProto(resp);
            String sk = p.containsKey(1) ? String.valueOf(p.get(1)) : "";
            long expires = p.containsKey(2) ? num(p.get(2)) : 3600;
            if (sk.isEmpty()) return null;
            cached = new YandexSession(uuid, sk, now, expires);
            android.util.Log.i("VotBridge", "session created, expires=" + expires);
            return cached;
        }

        static byte[] buildTranslate(String url, double duration, boolean firstRequest,
                                     String lang, String target, String title, boolean lively) throws IOException {
            ByteArrayOutputStream b = new ByteArrayOutputStream();
            writeString(b, 3, url);
            writeBool(b, 5, firstRequest);
            writeDouble(b, 6, duration);
            writeInt(b, 7, 1);
            writeString(b, 8, lang);
            writeString(b, 14, target);
            writeInt(b, 15, 1);
            writeInt(b, 16, 2);
            writeBool(b, 18, lively);
            if (title != null && !title.isEmpty()) writeString(b, 19, title);
            return b.toByteArray();
        }

        static Map<String, String> authHeaders(YandexSession se, byte[] body, String path) throws Exception {
            return authHeaders(se, body, path, false);
        }

        static Map<String, String> authHeaders(YandexSession se, byte[] body, String path, boolean lively) throws Exception {
            Map<String, String> h = new HashMap<>();
            h.put("Vtrans-Signature", hmacHex(body));
            if (se.sk != null && !se.sk.isEmpty()) {
                String token = se.uuid + ":" + path + ":" + VERSION;
                h.put("Sec-Vtrans-Sk", se.sk);
                h.put("Sec-Vtrans-Token", hmacHex(token.getBytes(StandardCharsets.UTF_8)) + ":" + token);
            }
            // Live voices are a paid/authenticated feature: Yandex only accepts
            // field 18 when the request carries the user's OAuth token.
            if (lively) {
                String tok = sOauthToken == null ? "" : sOauthToken.trim();
                if (!tok.isEmpty()) {
                    if (!tok.regionMatches(true, 0, "OAuth ", 0, 6)
                            && !tok.regionMatches(true, 0, "Bearer ", 0, 7)) {
                        tok = "OAuth " + tok;
                    }
                    h.put("Authorization", tok);
                }
            }
            clientHints(h);
            return h;
        }

        static void clientHints(Map<String, String> h) {
            h.put("sec-ch-ua", "\"Chromium\";v=\"134\", \"YaBrowser\";v=\"25.12\", \"Not?A_Brand\";v=\"24\", \"Yowser\";v=\"2.5\"");
            h.put("sec-ch-ua-full-version-list", "\"Chromium\";v=\"142.0.7444.291\", \"YaBrowser\";v=\"25.12.4.1198\", \"Not?A_Brand\";v=\"24.0.0.0\", \"Yowser\";v=\"2.5\"");
            h.put("Sec-Fetch-Mode", "no-cors");
        }

        static byte[] httpPost(String url, byte[] body, Map<String, String> extraHeaders) throws IOException {
            if (!workerBase().isEmpty()) return viaWorker(url, "POST", body, extraHeaders);
            return direct("POST", url, body, extraHeaders, 30000, "application/x-protobuf");
        }

        // fail-audio-js is a plain JSON endpoint (PUT {"video_url": "..."}).
        static byte[] httpPutJson(String url, byte[] jsonBody, Map<String, String> extraHeaders) throws IOException {
            if (!workerBase().isEmpty()) return viaWorkerRawJson(url, "PUT", jsonBody, extraHeaders);
            return direct("PUT", url, jsonBody, extraHeaders, 30000, "application/json");
        }

        private static byte[] direct(String method, String url, byte[] body,
                                      Map<String, String> extraHeaders, int readTimeoutMs,
                                      String contentType) throws IOException {
            HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
            c.setRequestMethod(method);
            c.setConnectTimeout(10000);
            c.setReadTimeout(readTimeoutMs);
            c.setDoOutput(true);
            c.setRequestProperty("Content-Type", contentType);
            c.setRequestProperty("User-Agent", UA);
            c.setRequestProperty("Accept", "application/json");
            c.setRequestProperty("Accept-Language", "en");
            c.setRequestProperty("Cache-Control", "no-cache");
            c.setRequestProperty("Pragma", "no-cache");
            if (extraHeaders != null) {
                for (Map.Entry<String, String> e : extraHeaders.entrySet()) {
                    c.setRequestProperty(e.getKey(), e.getValue());
                }
            }
            OutputStream os = c.getOutputStream();
            os.write(body);
            os.flush();
            os.close();
            int code = c.getResponseCode();
            InputStream in = code >= 400 ? c.getErrorStream() : c.getInputStream();
            byte[] resp = readAll(in == null ? new ByteArrayInputStream(new byte[0]) : in);
            c.disconnect();
            if (code >= 400) {
                String s = new String(resp, StandardCharsets.UTF_8);
                if (s.length() > 200) s = s.substring(0, 200);
                throw new IOException("HTTP " + code + " " + s);
            }
            return resp;
        }

        // ---- vot-worker proxy -------------------------------------------
        // When the worker is configured every Yandex call goes through
        // https://<worker><path>. Two wire formats exist; the current one sends
        // the raw protobuf body with the upstream headers in X-VOT-Headers,
        // the legacy one wraps everything in a JSON envelope.
        static String workerBase() {
            String w = sWorker == null ? "" : sWorker.trim();
            if (w.isEmpty()) return "";
            if (!w.startsWith("http://") && !w.startsWith("https://")) w = "https://" + w;
            while (w.endsWith("/")) w = w.substring(0, w.length() - 1);
            return w;
        }

        private static String pathOf(String url) {
            int p = url.indexOf("://");
            if (p > 0) {
                int slash = url.indexOf('/', p + 3);
                if (slash > 0) return url.substring(slash);
            }
            return "/";
        }

        private static String headersJson(Map<String, String> headers) {
            JSONObject h = new JSONObject();
            if (headers != null) {
                for (Map.Entry<String, String> e : headers.entrySet()) {
                    try { h.put(e.getKey(), e.getValue()); } catch (Throwable ignored) { }
                }
            }
            return h.toString();
        }

        private static byte[] viaWorker(String url, String method, byte[] body,
                                        Map<String, String> headers) throws IOException {
            String base = workerBase();
            String path = pathOf(url);
            String hj = headersJson(headers);
            JSONObject env = new JSONObject();
            try {
                env.put("headers", new JSONObject(hj));
                org.json.JSONArray arr = new org.json.JSONArray();
                for (int i = 0; i < body.length; i++) arr.put(body[i] & 0xFF);
                env.put("body", arr);
            } catch (Throwable e) {
                throw new IOException("worker envelope: " + e);
            }
            try {
                Map<String, String> wh = new HashMap<>();
                wh.put("X-VOT-Headers", android.util.Base64.encodeToString(
                        hj.getBytes(StandardCharsets.UTF_8), android.util.Base64.NO_WRAP));
                byte[] r = workerSend(base + path, method, body, "application/x-protobuf", wh);
                android.util.Log.i("VotBridge", "worker proto " + method + " " + path + " bytes=" + r.length);
                return r;
            } catch (IOException e1) {
                android.util.Log.e("VotBridge", "worker proto failed (" + e1.getMessage() + "), trying json envelope");
                if (body.length > (2 * 1024 * 1024)) throw e1;
                byte[] r = workerSend(base + path, method,
                        env.toString().getBytes(StandardCharsets.UTF_8), "application/json", null);
                android.util.Log.i("VotBridge", "worker json " + method + " " + path + " bytes=" + r.length);
                return r;
            }
        }

        // fail-audio-js is JSON on the wire: forward it as-is with X-VOT-Headers.
        private static byte[] viaWorkerRawJson(String url, String method, byte[] json,
                                               Map<String, String> headers) throws IOException {
            String path = pathOf(url);
            Map<String, String> wh = new HashMap<>();
            wh.put("X-VOT-Headers", android.util.Base64.encodeToString(
                    headersJson(headers).getBytes(StandardCharsets.UTF_8), android.util.Base64.NO_WRAP));
            byte[] r = workerSend(workerBase() + path, method, json, "application/json", wh);
            android.util.Log.i("VotBridge", "worker json-raw " + method + " " + path + " bytes=" + r.length);
            return r;
        }

        private static byte[] workerSend(String url, String method, byte[] body,
                                         String contentType, Map<String, String> extra) throws IOException {            HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
            c.setRequestMethod(method);
            c.setConnectTimeout(15000);
            c.setReadTimeout(120000);
            c.setDoOutput(true);
            c.setRequestProperty("Content-Type", contentType);
            c.setRequestProperty("Accept", "*/*");
            c.setRequestProperty("User-Agent", UA);
            if (extra != null) {
                for (Map.Entry<String, String> e : extra.entrySet()) {
                    c.setRequestProperty(e.getKey(), e.getValue());
                }
            }
            OutputStream os = c.getOutputStream();
            os.write(body);
            os.flush();
            os.close();
            int code = c.getResponseCode();
            InputStream in = code >= 400 ? c.getErrorStream() : c.getInputStream();
            byte[] resp = readAll(in == null ? new ByteArrayInputStream(new byte[0]) : in);
            c.disconnect();
            if (code >= 400) {
                String s = new String(resp, StandardCharsets.UTF_8);
                if (s.length() > 200) s = s.substring(0, 200);
                throw new IOException("worker HTTP " + code + " " + s);
            }
            return resp;
        }

        static byte[] httpPut(String url, byte[] body, Map<String, String> extraHeaders) throws IOException {
            if (!workerBase().isEmpty()) return viaWorker(url, "PUT", body, extraHeaders);
            return direct("PUT", url, body, extraHeaders, 120000, "application/x-protobuf");
        }

        static String buildFileId(int itag, String fileSize) {
            return "{\"downloadType\":\"" + AUDIO_DOWNLOAD_TYPE + "\",\"itag\":" + itag
                    + ",\"minChunkSize\":" + AUDIO_CHUNK_SIZE + ",\"fileSize\":\"" + fileSize + "\"}";
        }

        // single: {1: translationId, 2: videoUrl, 6: {1: fileId, 2: data}}
        static byte[] encodeSingleAudioRequest(String videoUrl, String translationId, String fileId, byte[] data) throws IOException {
            ByteArrayOutputStream b = new ByteArrayOutputStream();
            writeString(b, 1, translationId);
            writeString(b, 2, videoUrl);
            ByteArrayOutputStream inner = new ByteArrayOutputStream();
            writeString(inner, 1, fileId);
            writeBytes(inner, 2, data);
            writeMessage(b, 6, inner.toByteArray());
            return b.toByteArray();
        }

        // chunk: {1: translationId, 2: videoUrl, 4: {1:{1:idx,2:data}, 2:total, 3:fileId, 4:1}}
        static byte[] encodeChunkAudioRequest(String videoUrl, String translationId, String fileId,
                                              int chunkIndex, int totalChunks, byte[] data) throws IOException {
            ByteArrayOutputStream b = new ByteArrayOutputStream();
            writeString(b, 1, translationId);
            writeString(b, 2, videoUrl);
            ByteArrayOutputStream part = new ByteArrayOutputStream();
            writeInt(part, 1, chunkIndex);
            writeBytes(part, 2, data);
            ByteArrayOutputStream wrap = new ByteArrayOutputStream();
            writeMessage(wrap, 1, part.toByteArray());
            writeInt(wrap, 2, totalChunks);
            writeString(wrap, 3, fileId);
            writeInt(wrap, 4, 1);
            writeMessage(b, 4, wrap.toByteArray());
            return b.toByteArray();
        }

        static void uploadSingleAudio(YandexSession se, String videoUrl, String translationId,
                                      String fileId, byte[] data) throws Exception {
            byte[] body = encodeSingleAudioRequest(videoUrl, translationId, fileId, data);
            Map<String, String> h = authHeaders(se, body, "/video-translation/audio");
            httpPut(YANDEX + "/video-translation/audio", body, h);
        }

        static void uploadChunkAudio(YandexSession se, String videoUrl, String translationId,
                                     String fileId, int chunkIndex, int totalChunks, byte[] data) throws Exception {
            byte[] body = encodeChunkAudioRequest(videoUrl, translationId, fileId, chunkIndex, totalChunks, data);
            Map<String, String> h = authHeaders(se, body, "/video-translation/audio");
            httpPut(YANDEX + "/video-translation/audio", body, h);
        }

        static void uploadStreamedAudio(YandexSession se, String videoUrl, String translationId,
                                        String fileId, byte[] data) throws Exception {
            int total = (int) Math.max(1L, ((long) data.length + AUDIO_CHUNK_SIZE - 1) / AUDIO_CHUNK_SIZE);
            if (total <= 1) {
                uploadSingleAudio(se, videoUrl, translationId, fileId, data);
                return;
            }
            for (int i = 0; i < total; i++) {
                int from = i * AUDIO_CHUNK_SIZE;
                int to = Math.min(data.length, from + AUDIO_CHUNK_SIZE);
                byte[] chunk = new byte[to - from];
                System.arraycopy(data, from, chunk, 0, chunk.length);
                android.util.Log.i("VotBridge", "audio chunk " + (i + 1) + "/" + total + " bytes=" + chunk.length);
                uploadChunkAudio(se, videoUrl, translationId, fileId, i, total, chunk);
            }
        }

        static byte[] readAll(InputStream in) throws IOException {
            ByteArrayOutputStream b = new ByteArrayOutputStream();
            byte[] buf = new byte[8192];
            int r;
            while ((r = in.read(buf)) != -1) b.write(buf, 0, r);
            return b.toByteArray();
        }

        static Map<Integer, Object> readProto(byte[] data) {
            Map<Integer, Object> m = new HashMap<>();
            int[] p = {0};
            int n = data.length;
            while (p[0] < n) {
                long tag = readVarint(data, p);
                int field = (int) (tag >>> 3);
                int wire = (int) (tag & 7);
                if (wire == 0) {
                    m.put(field, readVarint(data, p));
                } else if (wire == 2) {
                    long len = readVarint(data, p);
                    int l = (int) len;
                    byte[] sb = new byte[l];
                    System.arraycopy(data, p[0], sb, 0, l);
                    p[0] += l;
                    m.put(field, new String(sb, StandardCharsets.UTF_8));
                } else if (wire == 1) {
                    long bits = 0;
                    for (int i = 0; i < 8; i++) bits |= ((long) (data[p[0] + i] & 0xFF)) << (8 * i);
                    p[0] += 8;
                    m.put(field, Double.longBitsToDouble(bits));
                } else if (wire == 5) {
                    p[0] += 4;
                } else {
                    break;
                }
            }
            return m;
        }

        static long readVarint(byte[] data, int[] pos) {
            long result = 0;
            int shift = 0;
            int p = pos[0];
            while (true) {
                int b = data[p++] & 0xFF;
                result |= ((long) (b & 0x7F)) << shift;
                shift += 7;
                if ((b & 0x80) == 0) break;
                if (shift > 63) break;
            }
            pos[0] = p;
            return result;
        }
    }

    // ---------------------------------------------------------------------
    // protobuf encode + crypto helpers
    // ---------------------------------------------------------------------
    private static void writeVarint(ByteArrayOutputStream out, long value) {
        while ((value & ~0x7FL) != 0) {
            out.write((int) (value & 0x7F) | 0x80);
            value >>>= 7;
        }
        out.write((int) value);
    }

    private static void writeTag(ByteArrayOutputStream out, int field, int wireType) {
        writeVarint(out, ((long) field << 3) | wireType);
    }

    private static void writeString(ByteArrayOutputStream out, int field, String s) throws IOException {
        byte[] b = s.getBytes(StandardCharsets.UTF_8);
        writeTag(out, field, 2);
        writeVarint(out, b.length);
        out.write(b);
    }

    private static void writeBytes(ByteArrayOutputStream out, int field, byte[] b) {
        writeTag(out, field, 2);
        writeVarint(out, b.length);
        out.write(b, 0, b.length);
    }

    private static void writeMessage(ByteArrayOutputStream out, int field, byte[] msg) {
        writeTag(out, field, 2);
        writeVarint(out, msg.length);
        out.write(msg, 0, msg.length);
    }

    private static void writeBool(ByteArrayOutputStream out, int field, boolean v) {
        writeTag(out, field, 0);
        out.write(v ? 1 : 0);
    }

    private static void writeInt(ByteArrayOutputStream out, int field, long v) {
        writeTag(out, field, 0);
        writeVarint(out, v);
    }

    private static void writeDouble(ByteArrayOutputStream out, int field, double v) {
        writeTag(out, field, 1);
        long bits = Double.doubleToRawLongBits(v);
        for (int i = 0; i < 8; i++) out.write((int) (bits >>> (8 * i)) & 0xFF);
    }

    private static String randomHex(int len) {
        SecureRandom r = new SecureRandom();
        StringBuilder sb = new StringBuilder(len);
        String ch = "0123456789ABCDEF";
        for (int i = 0; i < len; i++) sb.append(ch.charAt(r.nextInt(16)));
        return sb.toString();
    }

    private static String hmacHex(byte[] data) throws Exception {
        Mac mac = Mac.getInstance("HmacSHA256");
        mac.init(new SecretKeySpec(HMAC_KEY.getBytes(StandardCharsets.UTF_8), "HmacSHA256"));
        return hex(mac.doFinal(data));
    }

    private static String hex(byte[] b) {
        StringBuilder sb = new StringBuilder(b.length * 2);
        for (byte x : b) {
            int v = x & 0xFF;
            sb.append(Character.forDigit(v >> 4, 16)).append(Character.forDigit(v & 0xF, 16));
        }
        return sb.toString();
    }
}
