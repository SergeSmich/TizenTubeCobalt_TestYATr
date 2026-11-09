package vot;

import android.content.Context;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import android.media.MediaPlayer;
import android.os.Handler;
import android.os.HandlerThread;
import android.util.Base64;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedInputStream;
import java.io.BufferedOutputStream;
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
import java.util.Arrays;
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

    // ---- overlay serving ----
    // The overlay ships inside the APK (assets/vot.js = ui + vot + net glued at
    // build time) and is served from there: the box is self-sufficient, no PC
    // and no LAN server anywhere. Settings live in the same asset-defaults plus
    // the on-TV cache (vot_config_cache.json) the overlay itself writes.
    private static final String OVERLAY_ASSET = "vot.js";
    private static volatile byte[] sOverlay;
    private static volatile String sLastConfig = "";
    // What the bridge actually handed to the player / pushed to Yandex for the
    // last audio job: role, language, itag, whether a dub was stripped. The
    // overlay asks for it over GET /source?videoId=… so "which language is
    // playing" stops being a guess made from two different data sets.
    private static volatile JSONObject sSrcInfo;

    private static synchronized void srcInfo(JSONObject o) {
        sSrcInfo = o;
    }

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
    // audioMode : "local" (bridge resolves the audio URL itself and feeds it to
    //             Yandex without a PC — the standalone path, player untouched)
    //             | "off" | "capture" (harvest the player's own MSE audio — a
    //             fallback only).
    private static volatile String sAudioMode = "local";
    // A/B: make the player pick AAC (itag 140) instead of opus. SABR replay
    // streams whatever format the player selected — with opus the staged track
    // is webm/opus and Yandex refuses it. Verified on the TV: default (opus)
    // → itag 251, matroska/opus, 25 000 "non monotonically increasing dts"
    // errors; aac → itag 140, mp4/aac 44.1 kHz, zero decode errors. So AAC is
    // the default: the player can play mp4a in MSE (it asked and appended it),
    // and the whole local-audio path needs it.
    private static volatile boolean sAac = true;
    // Язык, который не переводим (переопределяет настройку страницы; пусто —
    // страница решает сама). Нужен и как сервисный рычаг для проверок на ТВ.
    private static volatile String sSkipLang = "";
    // Ручной выбор озвучки для текущего ролика ('dub' | 'yandex'), тоже
    // сервисный рычаг: страница применяет его как выбор в меню.
    private static volatile String sDubPick = "";
    // Разрешить AV1 (по умолчанию false: декодер бокса отдаёт чёрный экран).
    private static volatile boolean sAv1 = false;
    // "auto" | "avc": заставлять ли плеер брать только H.264. По умолчанию
    // "avc" — на этом боксе av1 и vp9 дают чёрный кадр.
    private static volatile String sVcodec = "avc";
    // ---- TV-side paths (needed to read Cobalt's cookie store) ----
    private static volatile String sDataDir = "";
    private static volatile String sCacheDir = "";
    // Application context, needed by the poToken WebView generator.
    private static volatile android.content.Context sAppCtx;

    private Bridge() {}

    public static synchronized void start(Context ctx) {
        if (started) return;
        started = true;
        try {
            sAppCtx = ctx.getApplicationContext() != null ? ctx.getApplicationContext() : ctx;
            sDataDir = ctx.getApplicationInfo().dataDir;
            File cd = ctx.getCacheDir();
            sCacheDir = cd == null ? sDataDir : cd.getAbsolutePath();
        } catch (Throwable e) {
            android.util.Log.w("VotBridge", "dirs failed: " + e);
        }
        android.util.Log.i("VotBridge", "dirs data=" + sDataDir + " cache=" + sCacheDir);
        capCleanupStale();
        loadOverlayFromAssets();
        loadCachedConfig();
        Thread t = new Thread(Bridge::serve, "vot-bridge");
        t.setDaemon(true);
        t.start();
        Thread w = new Thread(Bridge::warmUp, "vot-warm");
        w.setDaemon(true);
        w.start();
        android.util.Log.i("VotBridge", "bridge starting on 127.0.0.1:8013");
    }

    // Cold-start warm-up. Both the Yandex handshake and the BotGuard generator
    // cost seconds on this TV, and both used to be paid on the critical path of
    // the first audio upload: measured 7.7 s between "audiosrc start" and the
    // first player request, which the user sees as "download stuck at 0 %".
    // Doing it at bridge start moves that cost into the app launch, where nobody
    // is waiting for it. Tokens are cached for hours, so later videos are free.
    private static void warmUp() {
        long t0 = System.currentTimeMillis();
        try {
            YandexSession se = YandexClient.ensureSession();
            android.util.Log.i("VotBridge", "warm session ms="
                    + (System.currentTimeMillis() - t0) + " ok=" + (se != null ? 1 : 0));
        } catch (Throwable e) {
            android.util.Log.w("VotBridge", "warm session failed: " + e);
        }
        long t1 = System.currentTimeMillis();
        try {
            // No videoId: this only spins the generator up and mints the
            // visitor-bound streaming token, which is the expensive part.
            PoToken.get(sAppCtx, "");
            android.util.Log.i("VotBridge", "warm pot ms="
                    + (System.currentTimeMillis() - t1));
        } catch (Throwable e) {
            android.util.Log.w("VotBridge", "warm pot failed: " + e);
        }
    }

    // The overlay compiled into the APK: works offline, on a fresh install, with
    // no dev server anywhere. /vot.js serves exactly these bytes.
    private static void loadOverlayFromAssets() {
        try {
            InputStream in = sAppCtx.getAssets().open(OVERLAY_ASSET);
            byte[] b = YandexClient.readAll(in);
            try { in.close(); } catch (Throwable e) { }
            if (b != null && b.length > 0) {
                sOverlay = b;
                android.util.Log.i("VotBridge", "overlay from assets " + b.length + " bytes");
            }
        } catch (Throwable e) {
            android.util.Log.w("VotBridge", "no overlay asset: " + e);
        }
    }

    private static String configCachePath() {
        return (sDataDir == null || sDataDir.isEmpty() ? "" : sDataDir + "/") + "vot_config_cache.json";
    }

    // Settings the overlay posts to /config are cached here (vot_config_cache.json)
    // so a reboot keeps them without any LAN server.
    private static void loadCachedConfig() {
        try {
            File f = new File(configCachePath());
            if (!f.isFile() || f.length() == 0) return;
            byte[] b;
            FileInputStream fi = new FileInputStream(f);
            try { b = YandexClient.readAll(fi); } finally { try { fi.close(); } catch (Throwable e) { } }
            if (b == null || b.length == 0) return;
            String s = new String(b, StandardCharsets.UTF_8).trim();
            if (s.isEmpty()) return;
            JSONObject cached = new JSONObject(s);
            // Кэш старых сборок писал audioMode:"capture" и ПК-поля (pcFill,
            // fillLang, fillFormat, fillMaxWait). ПК больше нет, а capture —
            // только аварийный фолбэк: такие файлы не должны навязывать режим,
            // иначе приставка молча остаётся без автономного звука. Маркер
            // "v">=2 ставит только новая сборка при осознанном POST /config.
            if (cached.optInt("v", 0) < 2) {
                boolean legacy = cached.has("audioMode") || cached.has("pcFill");
                cached.remove("audioMode");
                cached.remove("pcFill");
                cached.remove("fillLang");
                cached.remove("fillFormat");
                cached.remove("fillMaxWait");
                if (legacy) android.util.Log.i("VotBridge",
                        "config cache legacy -> defaults (audioMode=" + sAudioMode + ")");
            }
            sLastConfig = cached.toString();
            handleConfig(cached);
            android.util.Log.i("VotBridge", "config from cache " + s.length() + "B");
        } catch (Throwable e) {
            android.util.Log.w("VotBridge", "config cache read failed: " + e);
        }
    }

    private static void saveConfigCache(String s) {
        try {
            FileOutputStream fo = new FileOutputStream(configCachePath());
            fo.write(s.getBytes(StandardCharsets.UTF_8));
            fo.close();
        } catch (Throwable e) {
            android.util.Log.w("VotBridge", "config cache write failed: " + e);
        }
    }

    // ---- PC filler: removed ------------------------------------------------
    // The bridge used to proxy /fill and /fill_status to a dev server on the LAN
    // (yt-dlp with browser cookies downloaded the track and uploaded it). The app
    // is now autonomous on the box: the SABR/page-audio path below fetches the
    // original track itself, so those endpoints answer 410 "no pc".

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
    private static final String WEB_VERSION = "2.20260708.00.00";
    private static final String WEB_UA =
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
            "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
    private static final String VR_VERSION = "1.65.10";
    // Byte-for-byte copy of the fork's CLIENTS.ANDROID_VR.USER_AGENT: googlevideo
    // ties the media URL to the UA of the client that asked for it, a different
    // string is answered with 403 + empty body even though the URL is valid.
    private static final String VR_UA =
            "com.google.android.apps.youtube.vr.oculus/1.65.10 (Linux; U; Android 12L; " +
            "eureka-user Build/SQ3A.220605.009.A1) gzip";
    private static final String IOS_VERSION = "21.26.4";
    private static final String IOS_UA =
            "com.google.ios.youtube/21.26.4 (iPhone16,2; U; CPU iOS 18_3_2 like Mac OS X;)";
    private static final String VISIONOS_VERSION = "1.02";
    private static final String VISIONOS_UA =
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 15_7_3) AppleWebKit/605.1.15 " +
            "(KHTML, like Gecko) Version/26.0 Safari/605.1.15";
    private static final String ANDROID_VERSION = "20.10.38";
    private static final String ANDROID_UA =
            "com.google.android.youtube/20.10.38 (Linux; U; Android 11) gzip";
    // The TV page plays as TVHTML5 (its googlevideo urls carry "c=TVHTML5") and
    // it is the one client that is not sent to the "confirm you're not a bot"
    // gate on this device, so the bridge asks InnerTube as TVHTML5 too.
    private static final String TV_VERSION = "7.20250312.16.00";
    private static final String TV_UA =
            "Mozilla/5.0 (ChromiumStylePlatform) Cobalt/Version";
    private static final String TV_EMB_VERSION = "2.0";
    private static final String EMBED_URL = "https://www.youtube.com/";

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

    // One InnerTube client. Version and UA must stay byte-identical to the fork
    // (Constants.kt / AppClient.kt): googlevideo ties the media URL to the UA of
    // the client that asked for it, a different string gives 403 + empty body.
    private static final class Client {
        final String name;
        final String version;
        final String num;       // X-Youtube-Client-Name
        final String ua;
        final boolean potInBody; // WEB family only: adds SAPISID Authorization
        final String make;
        final String model;
        final String osName;
        final String osVersion;
        final int sdk;
        final String embedUrl;   // embedded players only: thirdParty.embedUrl

        Client(String name, String version, String num, String ua, boolean potInBody,
               String make, String model, String osName, String osVersion, int sdk) {
            this(name, version, num, ua, potInBody, make, model, osName, osVersion, sdk, null);
        }

        Client(String name, String version, String num, String ua, boolean potInBody,
               String make, String model, String osName, String osVersion, int sdk,
               String embedUrl) {
            this.name = name;
            this.version = version;
            this.num = num;
            this.ua = ua;
            this.potInBody = potInBody;
            this.make = make;
            this.model = model;
            this.osName = osName;
            this.osVersion = osVersion;
            this.sdk = sdk;
            this.embedUrl = embedUrl;
        }

        String uaOrWeb() {
            return ua == null ? WEB_UA : ua;
        }
    }

    private static final Client C_WEB = new Client("WEB", WEB_VERSION, "1", WEB_UA,
            true, null, null, null, null, 0);
    private static final Client C_VR = new Client("ANDROID_VR", VR_VERSION, "28", VR_UA,
            false, "Oculus", "Quest 3", "Android", "12", 32);
    private static final Client C_VISIONOS = new Client("VISIONOS", VISIONOS_VERSION, "101",
            VISIONOS_UA, false, "Apple", "RealityDevice14,1", "visionOS", "1.3.0.0.0", 0);
    private static final Client C_IOS = new Client("IOS", IOS_VERSION, "5", IOS_UA,
            false, "Apple", "iPhone16,2", "iPhone", "18.3.2.18.1", 0);
    private static final Client C_ANDROID = new Client("ANDROID", ANDROID_VERSION, "3", ANDROID_UA,
            false, "Google", "Pixel 7", "Android", "11", 30);
    private static final Client C_TV = new Client("TVHTML5", TV_VERSION, "7", TV_UA,
            false, "Google", null, null, null, 0, EMBED_URL);
    // num 85; without thirdParty.embedUrl this client answers UNPLAYABLE.
    private static final Client C_TV_EMB = new Client("TVHTML5_SIMPLY_EMBEDDED_PLAYER",
            TV_EMB_VERSION, "85", WEB_UA, false, null, null, null, null, 0, EMBED_URL);

    // Order matters and is measured, not guessed. VISIONOS goes first: on the TV
    // its audio url serves Range 206 for every chunk, while ANDROID_VR and
    // ANDROID answer 403 on the actual range GET even though the bare probe
    // (`Range: bytes=0-63`) succeeded — each failing client costs ~12 s of
    // retries, and VISIONOS never failed. IOS returns SABR-only formats and WEB
    // answers UNPLAYABLE without login, so they stay last.
    private static final Client[] AUDIO_CLIENTS =
            new Client[]{C_TV, C_TV_EMB, C_VISIONOS, C_VR, C_ANDROID, C_IOS, C_WEB};

    private static Client clientByName(String s) {
        if (s == null) return null;
        if (s.equalsIgnoreCase("web") || s.equalsIgnoreCase("mweb")) return C_WEB;
        if (s.equalsIgnoreCase("vr") || s.equalsIgnoreCase("android_vr")) return C_VR;
        if (s.equalsIgnoreCase("visionos") || s.equalsIgnoreCase("vision")) return C_VISIONOS;
        if (s.equalsIgnoreCase("ios")) return C_IOS;
        if (s.equalsIgnoreCase("tv") || s.equalsIgnoreCase("tvhtml5")) return C_TV;
        if (s.equalsIgnoreCase("tvemb") || s.equalsIgnoreCase("embedded")
                || s.equalsIgnoreCase("tvhtml5_simply_embedded_player")) return C_TV_EMB;
        if (s.equalsIgnoreCase("android") || s.equalsIgnoreCase("reel")
                || s.equalsIgnoreCase("android_reel")) return C_ANDROID;
        return null;
    }

    private static JSONObject itPlayer(String videoId, boolean vr) throws Exception {
        return itPlayer(videoId, vr ? C_VR : C_WEB, null, null);
    }

    private static JSONObject itPlayer(String videoId, boolean vr, String visitorData, String playerPot)
            throws Exception {
        return itPlayer(videoId, vr ? C_VR : C_WEB, visitorData, playerPot);
    }

    // visitorData + player poToken go into EVERY client request, not just WEB: the
    // media URL is signed against the visitorData/poToken pair of the player call
    // that produced it. Sending them for WEB only was the reason ANDROID_VR URLs
    // came back "valid" and then answered 403 with an empty body on the range GET
    // (the pot we appended was minted for a visitor the request never declared).
    private static JSONObject itPlayer(String videoId, Client cl, String visitorData, String playerPot)
            throws Exception {
        refreshCookies(false);
        JSONObject client = new JSONObject();
        JSONObject body = new JSONObject();
        JSONObject ctx = new JSONObject();
        client.put("clientName", cl.name);
        client.put("clientVersion", cl.version);
        if (cl.make != null) client.put("deviceMake", cl.make);
        if (cl.model != null) client.put("deviceModel", cl.model);
        if (cl.sdk > 0) client.put("androidSdkVersion", cl.sdk);
        if (cl.osName != null) client.put("osName", cl.osName);
        if (cl.osVersion != null) client.put("osVersion", cl.osVersion);
        if (cl.ua != null) client.put("userAgent", cl.ua);
        if (visitorData != null && !visitorData.isEmpty()) {
            client.put("visitorData", visitorData);
        }
        client.put("hl", "en");
        client.put("gl", "US");
        client.put("utcOffsetMinutes", 0);
        ctx.put("client", client);
        body.put("context", ctx);
        if (cl.embedUrl != null) {
            // Embedded players are only served when the request says where they
            // are embedded; without it TVHTML5_SIMPLY_EMBEDDED_PLAYER is
            // UNPLAYABLE and TVHTML5 falls back to SABR-only.
            JSONObject third = new JSONObject();
            third.put("embedUrl", cl.embedUrl);
            body.put("thirdParty", third);
        }
        body.put("videoId", videoId);
        body.put("contentCheckOk", true);
        body.put("racyCheckOk", true);
        if (playerPot != null && !playerPot.isEmpty()) {
            JSONObject sid = new JSONObject();
            sid.put("poToken", playerPot);
            body.put("serviceIntegrityDimensions", sid);
        }

        String ua = cl.ua != null ? cl.ua : WEB_UA;
        HttpURLConnection c = (HttpURLConnection) new URL(
                INNERTUBE + "?key=" + INNERTUBE_KEY + "&prettyPrint=false").openConnection();
        c.setConnectTimeout(8000);
        c.setReadTimeout(15000);
        c.setRequestMethod("POST");
        c.setDoOutput(true);
        c.setRequestProperty("Content-Type", "application/json");
        c.setRequestProperty("User-Agent", ua);
        c.setRequestProperty("X-Youtube-Client-Name", cl.num);
        c.setRequestProperty("X-Youtube-Client-Version", cl.version);
        c.setRequestProperty("Accept-Language", "en");
        c.setRequestProperty("Origin", "https://www.youtube.com");
        c.setRequestProperty("Referer", "https://www.youtube.com/");
        String ck = sCookieHeader;
        if (ck != null && !ck.isEmpty()) c.setRequestProperty("Cookie", ck);
        if (visitorData != null && !visitorData.isEmpty()) {
            c.setRequestProperty("X-Goog-Visitor-Id", visitorData);
        }
        if (cl.potInBody) {
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
        android.util.Log.i("VotBridge", "it player " + cl.name + " id=" + videoId
                + " status=" + (ps == null ? "?" : ps.optString("status", "?"))
                + " login=" + (sCookieLoggedIn ? 1 : 0)
                + " pot=" + (playerPot != null && !playerPot.isEmpty() ? 1 : 0)
                + " vd=" + (visitorData != null && !visitorData.isEmpty() ? 1 : 0));
        return j;
    }

    // Query parameter names only (no values) — enough to see whether gvs gave us
    // an "n", an expire, an ip lock, etc.
    private static String queryKeys(String url) {
        int q = url.indexOf('?');
        if (q < 0) return "";
        String[] kv = url.substring(q + 1).split("&");
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < kv.length; i++) {
            int eq = kv[i].indexOf('=');
            String k = eq < 0 ? kv[i] : kv[i].substring(0, eq);
            if (sb.length() > 0) sb.append(',');
            sb.append(k);
        }
        return sb.toString();
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
        return handleYtUrl(videoId, vr ? C_VR : C_WEB, false);
    }

    // withPot: mint visitorData + poToken and let the WEB client sign the
    // request with it (serviceIntegrityDimensions), then append
    // "&pot=<streamingPot>" to every returned audio URL. Without pot googlevideo
    // answers 403 with an empty body, so this is the only path that downloads.
    private static JSONObject handleYtUrl(String videoId, Client cl, boolean withPot) throws Exception {
        String visitorData = null;
        String playerPot = null;
        String streamPot = null;
        if (withPot) {
            try {
                PoToken.Tokens t = PoToken.get(sAppCtx, videoId);
                visitorData = t.visitorData;
                playerPot = t.playerPot;
                streamPot = t.streamingPot;
            } catch (Throwable e) {
                android.util.Log.e("VotBridge", "pot unavailable for " + videoId + ": " + e);
            }
        }
        JSONObject j = itPlayer(videoId, cl, visitorData, playerPot);
        JSONObject out = new JSONObject();
        out.put("videoId", videoId);
        out.put("client", cl.name);
        out.put("loggedIn", sCookieLoggedIn);
        out.put("pot", streamPot != null && !streamPot.isEmpty());
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
                if (playerPot != null && !playerPot.isEmpty()
                        && !hasParam(url, "pot")) {
                    url = url + "&pot=" + PoToken.urlEnc(playerPot);
                }
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

    // /potest: does the poToken machinery work in this process at all?
    private static JSONObject handlePotest(String videoId) {
        JSONObject out = new JSONObject();
        try {
            long t0 = System.currentTimeMillis();
            PoToken.Tokens t = PoToken.get(sAppCtx, videoId);
            out.put("ok", 1);
            out.put("ms", System.currentTimeMillis() - t0);
            out.put("vdLen", t.visitorData.length());
            out.put("vd", t.visitorData.length() > 24 ? t.visitorData.substring(0, 24) : t.visitorData);
            out.put("playerLen", t.playerPot.length());
            out.put("streamLen", t.streamingPot.length());
            out.put("stream", t.streamingPot.length() > 16
                    ? t.streamingPot.substring(0, 16) : t.streamingPot);
        } catch (Throwable e) {
            try {
                out.put("ok", 0);
                out.put("error", String.valueOf(e));
            } catch (Throwable ignored) { }
            android.util.Log.e("VotBridge", "potest failed: " + e);
        }
        return out;
    }

    // Pick the best audio format out of a WEB player response: opus 251 first,
    // then m4a 140, then whatever audio track has a plain URL.
    // ---- audio track metadata (language + role) ------------------------------
    // Innertube describes each audio format with `xtags` and/or `audioTrack`.
    // `xtags` is either the plain string `acont=original:lang=en-US` or a
    // base64-encoded protobuf of repeated {1:key, 2:value} pairs (the TV client
    // sends the protobuf form). Roles:
    //   original      — the video's own voice
    //   dubbed        — a dub the uploader added
    //   dubbed-auto   — YouTube's automatic dub (the TV player prefers it!)
    //   descriptive   — audio description for the blind
    // `dcr=1` is NOT descriptive: it is the DRC (dynamic-range-compressed)
    // variant of the same track and can share the itag with the clean one.
    // Treating it as descriptive demoted the real original track (ru.4 with
    // dcr=1) to the lowest rank, and the auto-dub won the pick.
    // audioIsDefault is NOT a role: the default track can be the auto-dub
    // YouTube picked for the account/interface language.
    private static final int ROLE_ORIGINAL = 0;
    private static final int ROLE_PLAIN = 1;     // no role marker at all
    private static final int ROLE_DUB = 2;
    private static final int ROLE_AUTODUB = 3;
    private static final int ROLE_DESC = 4;

    private static final class TrackMeta {
        String lang = "";        // normalised to the base code ("en-US" -> "en")
        String acont = "";
        int role = ROLE_PLAIN;
        boolean isDefault;
        boolean originalByName;
        String id = "";
    }

    private static final class AudioChoice {
        JSONObject fmt;
        TrackMeta meta;
        int itag;
    }

    private static String roleName(int role) {
        return role == ROLE_ORIGINAL ? "ORIGINAL" : role == ROLE_DUB ? "DUB"
                : role == ROLE_AUTODUB ? "AUTODUB" : role == ROLE_DESC ? "DESC" : "PLAIN";
    }

    private static int roleOfName(String n) {
        String v = n == null ? "" : n.trim();
        return "ORIGINAL".equals(v) ? ROLE_ORIGINAL : "DUB".equals(v) ? ROLE_DUB
                : "AUTODUB".equals(v) ? ROLE_AUTODUB : "DESC".equals(v) ? ROLE_DESC : ROLE_PLAIN;
    }

    // "en-US" -> "en", "ru (original)" -> "ru", "EN_us" -> "en".
    private static String langBase(String s) {
        String v = s == null ? "" : s.trim().toLowerCase();
        v = v.replace('\u2010', '-').replace('\u2011', '-').replace('_', '-');
        int p = v.indexOf('(');
        if (p > 0) v = v.substring(0, p).trim();
        int d = v.indexOf('-');
        if (d > 0) v = v.substring(0, d);
        return v.trim();
    }

    // xtags in text form: pass the plain "k=v:k=v" string through, decode the
    // base64 protobuf form into the same text.
    private static String xtagsText(String raw) {
        String s = raw == null ? "" : raw.trim();
        if (s.isEmpty()) return "";
        if (s.indexOf('=') >= 0) return s;
        try {
            byte[] b;
            try {
                b = Base64.decode(s, Base64.NO_WRAP | Base64.URL_SAFE);
            } catch (Throwable e1) {
                b = Base64.decode(s, Base64.DEFAULT);
            }
            return xtagsPbText(b);
        } catch (Throwable e) {
            return "";
        }
    }

    // Repeated {1:string key, 2:string value} -> "acont=original:lang=en-US".
    private static String xtagsPbText(byte[] b) {
        StringBuilder sb = new StringBuilder();
        int i = 0;
        while (i < b.length) {
            long[] k = pbVarint(b, i);
            if (k == null) break;
            i = (int) k[1];
            int wt = (int) (k[0] & 7);
            if (wt != 2) {
                if (wt == 0) { long[] v = pbVarint(b, i); if (v == null) break; i = (int) v[1]; }
                else if (wt == 5) i += 4;
                else if (wt == 1) i += 8;
                else break;
                continue;
            }
            long[] ln = pbVarint(b, i);
            if (ln == null) break;
            int n = (int) ln[0];
            i = (int) ln[1];
            if (n < 0 || i + n > b.length) break;
            String key = "", val = "";
            int j = i, end = i + n;
            while (j < end) {
                long[] k2 = pbVarint(b, j);
                if (k2 == null) break;
                j = (int) k2[1];
                int f2 = (int) (k2[0] >>> 3), w2 = (int) (k2[0] & 7);
                if (w2 != 2) {
                    if (w2 == 0) { long[] v2 = pbVarint(b, j); if (v2 == null) break; j = (int) v2[1]; }
                    else if (w2 == 5) j += 4;
                    else if (w2 == 1) j += 8;
                    else break;
                    continue;
                }
                long[] l2 = pbVarint(b, j);
                if (l2 == null) break;
                int n2 = (int) l2[0];
                j = (int) l2[1];
                if (n2 < 0 || j + n2 > end) break;
                String str = new String(b, j, n2, StandardCharsets.UTF_8);
                if (f2 == 1) key = str; else if (f2 == 2) val = str;
                j += n2;
            }
            if (!key.isEmpty()) {
                if (sb.length() > 0) sb.append(':');
                sb.append(key).append('=').append(val);
            }
            i = end;
        }
        return sb.toString();
    }

    private static long[] pbVarint(byte[] b, int i) {
        long v = 0;
        int sh = 0;
        while (i < b.length && sh < 64) {
            int c = b[i++] & 0xff;
            v |= (long) (c & 0x7f) << sh;
            sh += 7;
            if ((c & 0x80) == 0) return new long[]{v, i};
        }
        return null;
    }

    private static TrackMeta parseTrack(JSONObject f) {
        TrackMeta m = new TrackMeta();
        if (f == null) return m;
        fillKv(m, xtagsText(f.optString("xtags", "")));
        JSONObject at = f.optJSONObject("audioTrack");
        if (at != null) {
            m.id = at.optString("id", "");
            if (m.lang.isEmpty()) m.lang = langBase(m.id);
            m.isDefault = at.optBoolean("audioIsDefault", false);
            if (at.optBoolean("isAutoDubbed", false)) m.acont = "dubbed-auto";
            String dn = at.optString("displayName", "");
            if (dn.toLowerCase().indexOf("original") >= 0) m.originalByName = true;
        }
        roleOf(m);
        return m;
    }

    // "acont=original:lang=en-US" -> fields. Unknown keys are ignored.
    private static void fillKv(TrackMeta m, String xt) {
        if (m == null || xt == null || xt.isEmpty()) return;
        String[] parts = xt.split(":");
        for (int i = 0; i < parts.length; i++) {
            int e = parts[i].indexOf('=');
            if (e <= 0) continue;
            String k = parts[i].substring(0, e).trim().toLowerCase();
            String v = parts[i].substring(e + 1).trim();
            if ("acont".equals(k)) m.acont = v.toLowerCase();
            else if ("lang".equals(k) && m.lang.isEmpty()) m.lang = langBase(v);
            // `dcr`/`drc` — вариант с динамическим сжатием, роль не меняет.
        }
    }

    private static void roleOf(TrackMeta m) {
        if (m == null) return;
        String a = m.acont == null ? "" : m.acont;
        if (a.indexOf("descriptive") >= 0) m.role = ROLE_DESC;
        else if (a.indexOf("dubbed-auto") >= 0 || a.indexOf("autodub") >= 0) m.role = ROLE_AUTODUB;
        else if (a.indexOf("dubbed") >= 0) m.role = ROLE_DUB;
        else if (a.indexOf("original") >= 0 || m.originalByName) m.role = ROLE_ORIGINAL;
        else m.role = ROLE_PLAIN;
    }

    private static int itagScore(int itag) {
        return itag == 140 ? 100 : itag == 251 ? 80 : itag == 250 ? 70
                : itag == 249 ? 60 : itag == 139 ? 50 : 10;
    }

    // true when `a` should replace `b` as the audio track to play/upload.
    private static boolean betterAudio(AudioChoice a, AudioChoice b) {
        // 1) logical role first: original > plain > dub > auto-dub > descriptive.
        if (a.meta.role != b.meta.role) return a.meta.role < b.meta.role;
        // 2) a known language beats an unknown one.
        boolean al = !a.meta.lang.isEmpty(), bl = !b.meta.lang.isEmpty();
        if (al != bl) return al;
        // 3) same role, different languages: the player's own default keeps
        //    playback continuity; bitrate is NOT comparable across languages.
        if (!a.meta.lang.equals(b.meta.lang)) return a.meta.isDefault && !b.meta.isDefault;
        // 4) same logical track: codec Yandex accepts, then default.
        int sa = itagScore(a.itag), sb = itagScore(b.itag);
        if (sa != sb) return sa > sb;
        return a.meta.isDefault && !b.meta.isDefault;
    }

    private static AudioChoice chooseAudio(JSONArray fmts, boolean requireUrl) {
        if (fmts == null) return null;
        AudioChoice best = null;
        for (int i = 0; i < fmts.length(); i++) {
            JSONObject f = fmts.optJSONObject(i);
            if (f == null) continue;
            int itag = f.optInt("itag", 0);
            String mime = f.optString("mimeType", "");
            boolean audio = mime.startsWith("audio/") || (itag >= 139 && itag <= 141)
                    || itag == 249 || itag == 250 || itag == 251;
            if (!audio) continue;
            if (requireUrl && f.optString("url", "").isEmpty()) continue;
            AudioChoice c = new AudioChoice();
            c.fmt = f;
            c.itag = itag;
            c.meta = parseTrack(f);
            if (best == null || betterAudio(c, best)) best = c;
        }
        return best;
    }

    private static JSONObject pickAudio(JSONObject playerJson) {
        JSONObject sd = playerJson.optJSONObject("streamingData");
        AudioChoice c = chooseAudio(sd == null ? null : sd.optJSONArray("adaptiveFormats"), true);
        if (c == null) return null;
        android.util.Log.i("VotBridge", "audio pick role=" + roleName(c.meta.role)
                + " lang=" + (c.meta.lang.isEmpty() ? "-" : c.meta.lang)
                + " itag=" + c.itag + " def=" + (c.meta.isDefault ? 1 : 0));
        return c.fmt;
    }

    // ------------------------------------------------------------ SABR path
    // TVHTML5 is the only client the "confirm you're not a bot" gate does not
    // stop, but it never returns a plain url: only serverAbrStreamingUrl. The
    // format list is still there (itag/lmt/contentLength), which is everything
    // Sabr needs to pull the same audio the TV player is pulling.
    private static final class SabrPick {
        int itag;
        long lmt;
        String xtags = "";
        String trackId = "";
        long clen;
        long bitrate;
        String mime = "";
        TrackMeta meta;
    }

    private static SabrPick pickSabrAudio(JSONObject playerJson) {
        JSONObject sd = playerJson.optJSONObject("streamingData");
        if (sd == null || sd.optString("serverAbrStreamingUrl", "").isEmpty()) return null;
        AudioChoice c = chooseAudio(sd.optJSONArray("adaptiveFormats"), false);
        if (c == null) return null;
        SabrPick p = new SabrPick();
        p.itag = c.itag;
        p.lmt = numField(c.fmt, "lastModified");
        p.clen = numField(c.fmt, "contentLength");
        p.bitrate = numField(c.fmt, "bitrate");
        p.mime = c.fmt.optString("mimeType", "");
        p.xtags = c.fmt.optString("xtags", "");
        p.trackId = c.meta.id;
        p.meta = c.meta;
        android.util.Log.i("VotBridge", "sabr pick role=" + roleName(c.meta.role)
                + " lang=" + (c.meta.lang.isEmpty() ? "-" : c.meta.lang)
                + " acont=" + (c.meta.acont == null || c.meta.acont.isEmpty() ? "-" : c.meta.acont)
                + " itag=" + p.itag + " def=" + (c.meta.isDefault ? 1 : 0)
                + " xt=" + (p.xtags.isEmpty() ? "-" : p.xtags));
        return p;
    }

    // InnerTube writes numbers as strings ("5661002", "1759..."), so parse the
    // string first and only fall back to optLong.
    private static long numField(JSONObject o, String k) {
        String v = o.optString(k, "");
        if (!v.isEmpty()) {
            try {
                return Long.parseLong(v.trim());
            } catch (Throwable ignore) { }
        }
        return o.optLong(k, 0L);
    }

    private static String ustreamerConfig(JSONObject playerJson) {
        JSONObject pc = playerJson.optJSONObject("playerConfig");
        JSONObject mc = pc == null ? null : pc.optJSONObject("mediaCommonConfig");
        JSONObject ur = mc == null ? null : mc.optJSONObject("mediaUstreamerRequestConfig");
        return ur == null ? "" : ur.optString("videoPlaybackUstreamerConfig", "");
    }

    private static Sabr.Params sabrParams(String videoId, JSONObject playerJson,
                                          PoToken.Tokens t, SabrPick f) {
        Sabr.Params p = new Sabr.Params();
        JSONObject sd = playerJson.optJSONObject("streamingData");
        p.videoId = videoId;
        p.url = sd == null ? "" : sd.optString("serverAbrStreamingUrl", "");
        p.ustreamerConfig = ustreamerConfig(playerJson);
        p.poToken = t == null ? "" : t.playerPot;
        p.visitorData = t == null ? "" : t.visitorData;
        p.clientName = 7;                       // TVHTML5
        p.clientVersion = TV_VERSION;
        p.ua = TV_UA;
        p.itag = f == null ? 0 : f.itag;
        p.lmt = f == null ? 0L : f.lmt;
        p.xtags = f == null ? "" : f.xtags;
        p.audioTrackId = f == null ? "" : f.trackId;
        p.bandwidth = f == null || f.bitrate <= 0 ? 128000L : f.bitrate;
        p.expectedLength = f == null ? 0L : f.clen;
        return p;
    }

    // Sequential SABR bytes go straight into Yandex in 5 295 308-byte parts,
    // same part semantics as sendTrack: middle parts carry 0, the last carries
    // the number of parts.
    private static final class SabrUpload implements Sabr.Sink {
        private final int gen;
        private final String videoId;
        private final String videoUrl;
        private final String tid;
        private final String fileId;
        private final int itag;
        private final long clen;   // progress-bar hint only, may be 0
        private final long t0;
        private final byte[] buf = new byte[AUDIO_CHUNK_SIZE];
        private int fill;
        private int part;
        private long sent;

        SabrUpload(int gen, String videoId, String videoUrl, String tid, String fileId,
                   int itag, long clen, int totalIgnored, long t0) {
            this.gen = gen;
            this.videoId = videoId;
            this.videoUrl = videoUrl;
            this.tid = tid;
            this.fileId = fileId;
            this.itag = itag;
            this.clen = clen;
            this.t0 = t0;
        }

        public void onBytes(byte[] d, int off, int len) throws Exception {
            while (len > 0) {
                // A full buffer is flushed only once more bytes arrive: the very
                // last chunk of the track is the one that must carry the part
                // count, and that count is its own index + 1. Flushing eagerly
                // makes the final part indistinguishable from a middle one.
                if (fill >= AUDIO_CHUNK_SIZE) flush(false);
                int n = Math.min(len, AUDIO_CHUNK_SIZE - fill);
                System.arraycopy(d, off, buf, fill, n);
                fill += n;
                off += n;
                len -= n;
            }
            asrcProgress(videoId, "download", part + 1, chunksHint(), sent + fill, clen, itag,
                    "sabr", System.currentTimeMillis() - t0);
        }

        // Rough part count for the progress bar only (the real count is known
        // once the track ends). 0 means "unknown" — the page then shows bytes.
        private int chunksHint() {
            if (clen <= 0) return 0;
            return (int) Math.max(1L, (clen + AUDIO_CHUNK_SIZE - 1) / AUDIO_CHUNK_SIZE);
        }

        private void flush(boolean last) throws Exception {
            if (fill <= 0) return;
            if (gen != sAsrcGen) throw new IOException("cancelled");
            byte[] data = Arrays.copyOf(buf, fill);
            boolean single = last && part == 0;
            int parts = last ? part + 1 : 0;   // middle parts carry 0, the last one the total
            asrcProgress(videoId, "upload", part + 1, chunksHint(), sent, clen, itag, "sabr",
                    System.currentTimeMillis() - t0);
            YandexSession se = YandexClient.ensureSession();
            if (se == null) throw new IOException("no session");
            if (single) {
                YandexClient.uploadSingleAudio(se, videoUrl, tid, fileId, data);
            } else {
                YandexClient.uploadChunkAudio(se, videoUrl, tid, fileId, part, parts, data);
            }
            part++;
            sent += data.length;
            fill = 0;
            android.util.Log.i("VotBridge", "audiosrc chunk " + part + "/"
                    + (last ? part : 0) + " bytes=" + data.length + " sent=" + sent
                    + " parts=" + parts + " at=" + (System.currentTimeMillis() - t0));
        }

        long finish() throws Exception {
            flush(true);
            return sent;
        }

        int partsUploaded() {
            return part;
        }
    }

    // SABR gives no trustworthy length up front (contentLength in the page
    // config goes stale between videos), while Yandex wants the exact file size
    // in fileId and the exact part count on the last part. So the track is
    // staged to a cache file first — the size is then known for certain — and
    // uploaded in AUDIO_CHUNK_SIZE parts afterwards. Only one part is in memory
    // at a time, so a one-hour track costs 5 MB of heap, not 60.
    private static final class SabrStage implements Sabr.Sink {
        private final String videoId;
        private final int itag;
        private final long est;
        private final long t0;
        private final File file = new File(sAppCtx.getCacheDir(), "vot_asrc.bin");
        private OutputStream os;
        private long bytes;

        SabrStage(String videoId, int itag, long est, long t0) {
            this.videoId = videoId;
            this.itag = itag;
            this.est = est;
            this.t0 = t0;
            // Start from an empty file: a failed run must not leave the previous
            // track behind for /sabrfile to report as "staged".
            try { if (file.exists()) file.delete(); } catch (Throwable ignore) { }
        }

        // A SABR stream of a session that already played the track contains only
        // media fragments — the init segment (ftyp/moov or the WebM header) went
        // to the player long ago. Without it the file is not a container at all
        // (ffprobe: "moov atom not found"; ffmpeg: "Unknown input format") and
        // Yandex answers "Видео слишком длинное" instead of translating. The
        // player appends that very init to its audio SourceBuffer, so the page
        // hands it to us (POST /mseinit) and it is written first.
        SabrStage init(byte[] b) throws IOException {
            if (b == null || b.length == 0) return this;
            // Not swallowed: if the init segment cannot be written the staged
            // file has no container header at all, and Yandex would answer with
            // an obscure "video too long" instead of a usable error.
            try {
                if (os == null) os = new BufferedOutputStream(new FileOutputStream(file), 65536);
                os.write(b, 0, b.length);
                bytes += b.length;
            } catch (IOException e) {
                throw new IOException("stage init " + b.length + "B: " + e, e);
            }
            return this;
        }

        File file() { return file; }

        public void onBytes(byte[] d, int off, int len) throws Exception {
            if (os == null) {
                os = new BufferedOutputStream(new FileOutputStream(file), 65536);
            }
            os.write(d, off, len);
            bytes += len;
            asrcProgress(videoId, "download", 0, 0, bytes, est, itag, "sabr",
                    System.currentTimeMillis() - t0);
        }

        long close() {
            long n = bytes;
            if (os != null) {
                try { os.close(); } catch (Throwable ignored) { }
                os = null;
            }
            return n;
        }
    }

    // Second phase of the staged path: the parts leave the cache file with the
    // real total size declared, so Yandex sees the same numbers the browser
    // extension sends.
    private static long uploadStaged(int gen, String videoId, String videoUrl, String tid,
                                     int itag, long size, long t0) throws Exception {
        File f = new File(sAppCtx.getCacheDir(), "vot_asrc.bin");
        int total = (int) Math.max(1L, (size + AUDIO_CHUNK_SIZE - 1) / AUDIO_CHUNK_SIZE);
        String fileId = YandexClient.buildFileId(itag, String.valueOf(size));
        long sent = 0;
        InputStream in = new BufferedInputStream(new FileInputStream(f), 65536);
        try {
            for (int i = 0; i < total; i++) {
                if (gen != sAsrcGen) throw new IOException("cancelled");
                int want = (int) Math.min(AUDIO_CHUNK_SIZE, size - sent);
                byte[] chunk = new byte[want];
                int off = 0;
                while (off < want) {
                    int r = in.read(chunk, off, want - off);
                    if (r <= 0) break;
                    off += r;
                }
                if (off <= 0) throw new IOException("staged file short at part " + i);
                if (off < want) chunk = Arrays.copyOf(chunk, off);
                YandexSession se = YandexClient.ensureSession();
                if (se == null) throw new IOException("no session");
                int parts = total <= 1 ? 0 : (i == total - 1 ? total : 0);
                asrcProgress(videoId, "upload", i + 1, total, sent, size, itag, "sabr",
                        System.currentTimeMillis() - t0);
                if (total <= 1) {
                    YandexClient.uploadSingleAudio(se, videoUrl, tid, fileId, chunk);
                } else {
                    YandexClient.uploadChunkAudio(se, videoUrl, tid, fileId, i, parts, chunk);
                }
                sent += chunk.length;
                android.util.Log.i("VotBridge", "audiosrc chunk " + (i + 1) + "/" + total
                        + " bytes=" + chunk.length + " sent=" + sent + " parts=" + parts
                        + " at=" + (System.currentTimeMillis() - t0));
                asrcProgress(videoId, "upload", i + 1, total, sent, size, itag, "sabr",
                        System.currentTimeMillis() - t0);
            }
        } finally {
            try { in.close(); } catch (Throwable ignored) { }
        }
        return sent;
    }

    // GET /sabrfile -> the track the last page-SABR run staged, base64, so it can
    // be checked on the PC with ffprobe instead of guessing from Yandex statuses.
    private static JSONObject handleSabrFile(long from, int max) throws Exception {
        File f = new File(sAppCtx.getCacheDir(), "vot_asrc.bin");
        JSONObject o = new JSONObject();
        long len = f.length();
        o.put("size", len);
        o.put("boxes", mp4Head(f));
        if (from < 0) from = 0;
        if (from > len) from = len;
        int n = (int) Math.min(Math.max(1, max), len - from);
        byte[] all = new byte[n];
        java.io.RandomAccessFile raf = new java.io.RandomAccessFile(f, "r");
        try {
            raf.seek(from);
            int off = 0;
            while (off < n) {
                int r = raf.read(all, off, n - off);
                if (r <= 0) break;
                off += r;
            }
            if (off < n) all = Arrays.copyOf(all, off);
        } finally {
            try { raf.close(); } catch (Throwable ignored) { }
        }
        o.put("from", from);
        o.put("n", all.length);
        o.put("b64", android.util.Base64.encodeToString(all, android.util.Base64.NO_WRAP));
        return o;
    }

    // What the staged track actually is: the seq of top-level MP4 boxes. A valid
    // fragmented-MP4 audio file starts with ftyp, then moov (init segment), then
    // moof/mdat pairs. If moov is missing, Yandex decodes nothing and reports
    // "there is no speech", which is exactly what happened before.
    private static String mp4Head(File f) {
        StringBuilder sb = new StringBuilder();
        java.io.RandomAccessFile raf = null;
        try {
            raf = new java.io.RandomAccessFile(f, "r");
            long pos = 0;
            long len = raf.length();
            for (int i = 0; i < 24 && pos + 8 <= len; i++) {
                raf.seek(pos);
                long size = raf.readInt() & 0xFFFFFFFFL;
                byte[] t = new byte[4];
                raf.readFully(t);
                String type = new String(t, StandardCharsets.ISO_8859_1).trim();
                long hdr = 8;
                if (size == 1) {
                    size = raf.readLong();
                    hdr = 16;
                } else if (size == 0) {
                    size = len - pos;
                }
                if (size < hdr) break;
                if (sb.length() > 0) sb.append(',');
                sb.append(type).append('/').append(size);
                pos += size;
            }
        } catch (Throwable e) {
            sb.append("err=").append(e);
        } finally {
            if (raf != null) {
                try { raf.close(); } catch (Throwable ignored) { }
            }
        }
        return sb.toString();
    }

    // /sabrtest: pull the whole audio track over SABR and report what arrived,
    // without touching Yandex. This is the cheapest way to tell whether the
    // protocol works before wiring it into the upload path.
    //
    // /sabrreq: page hands over the exact SABR POST its player made (url,
    // headers, protobuf body). /sabrreplay repeats it from Java: if that is
    // 200 while our own request is 403, the difference is in the request, not
    // in the network. Nothing here touches Yandex.
    private static volatile JSONObject sSabrReq;

    // Top-level field 5 (video_playback_ustreamer_config) of the player's own
    // SABR request. The copy in the player response (`videoPlaybackUstreamerConfig`)
    // is NOT the same bytes: the server answers our request with
    // `sabr.malformed_config` when we echo it, and streams media when we use the
    // player's. Diff starts at byte 709, ours is 24 bytes longer.
    private static volatile byte[] sSabrUcfg;

    // Video the captured body belongs to. The page flips videos faster than the
    // bridge notices, and a stale config is answered with `sabr.malformed_config`.
    private static volatile String sSabrUcfgVid = "";

    // Config the page's own player uses right now: serverAbrStreamingUrl +
    // videoPlaybackUstreamerConfig + the audio format it streams. Our own
    // InnerTube answers get `sabr.malformed_config`, this one is by definition
    // the one the server accepts.
    private static volatile JSONObject sSabrCfg;

    // Init segment of the track the player is streaming, taken from its own
    // audio SourceBuffer (the first MSE appendBuffer). SABR only serves media
    // fragments to a session that already played the stream, so without this
    // the staged file has no ftyp/moov (or WebM header) at all and is not a
    // container — Yandex rejects it. Keyed by video id: a stale header from
    // another video would corrupt the file just as badly as no header.
    private static volatile byte[] sMseInit;
    private static volatile String sMseInitVid = "";
    private static volatile String sMseInitMime = "";

    private static JSONObject handleMseInit(byte[] body, String vid, String mime) throws Exception {
        JSONObject o = new JSONObject();
        if (body == null || body.length == 0) throw new IOException("empty body");
        String m = mime == null ? "" : mime;
        o.put("len", body.length);
        o.put("mime", m);
        sMseInit = body;
        sMseInitMime = m;
        sMseInitVid = vid == null ? "" : vid;
        android.util.Log.i("VotBridge", "mseinit len=" + body.length + " mime=" + m
                + " vid=" + sMseInitVid + " head=" + Sabr.hexHead(body, 16));
        o.put("ok", 1);
        return o;
    }

    // Init bytes for this video (null when absent or from another video).
    private static byte[] mseInitFor(String videoId) {
        byte[] b = sMseInit;
        if (b == null || b.length == 0) return null;
        String v = sMseInitVid;
        if (!v.isEmpty() && !videoId.isEmpty() && !v.equals(videoId)) return null;
        return b;
    }

    private static JSONObject handleSabrCfg(byte[] body) throws Exception {
        JSONObject o = new JSONObject();
        if (body.length == 0) throw new IOException("empty body");
        JSONObject cfg = new JSONObject(new String(body, StandardCharsets.UTF_8));
        String url = cfg.optString("url", "");
        if (url.isEmpty()) throw new IOException("no url");
        sSabrCfg = cfg;
        // Публикуем дорожку сразу, не дожидаясь аудио-задачи: так /source
        // отвечает и в режиме capture (там задачи нет вообще), и до старта
        // перевода. Это ровно та дорожка, которую играет Cobalt.
        publishSourceFromPage(cfg);
        o.put("ok", 1);
        o.put("urlLen", url.length());
        o.put("ucfg", cfg.optString("ucfg", "").length());
        o.put("itag", cfg.optInt("itag", 0));
        o.put("clen", cfg.optString("clen", ""));
        android.util.Log.i("VotBridge", "sabrcfg urlLen=" + url.length()
                + " ucfg=" + cfg.optString("ucfg", "").length()
                + " itag=" + cfg.optInt("itag", 0) + " clen=" + cfg.optString("clen", "")
                + " vd=" + cfg.optString("vd", "").length());
        return o;
    }

    private static long longOf(String s) {
        try {
            return Long.parseLong(String.valueOf(s).trim());
        } catch (Throwable e) {
            return 0L;
        }
    }

    // /sabrtest?page=1: run the SABR loop entirely on the page's config.
    // Nothing is uploaded anywhere, only the byte count is reported.
    private static JSONObject handleSabrTestPage(int itagOverride, String xtagsOverride,
                                                 int rawMode) throws Exception {
        JSONObject out = new JSONObject();
        JSONObject cfg = sSabrCfg;
        if (cfg == null) {
            out.put("ok", 0);
            out.put("why", "no page config yet");
            return out;
        }
        long t0 = System.currentTimeMillis();
        Sabr.Params p = sabrParamsFromCfg(itagOverride);
        // A/B on the live video: ?xtags=none asks for the original audio,
        // ?xtags=<value> forces a specific track. Without it the page's own
        // xtags is used (with dubs stripped).
        if (!xtagsOverride.isEmpty()) {
            p.xtags = "none".equals(xtagsOverride) ? "" : xtagsOverride;
            p.lmt = 0;
        }
        p.expectedLength = longOf(cfg.optString("clen", ""));
        p.maxPosts = 60;
        // ?raw=1 replays the player's own request body instead of ours. Our body
        // is answered with policy frames only (35/46/47, empty playback_cookie),
        // which by protocol means "reload the player response" — i.e. the server
        // does not treat our session as the one that owns the stream. The page's
        // body carries po_token / sabr_contexts / capabilities we do not build.
        // ?raw=2 does the same but drops field 3 (buffered_ranges): replaying the
        // player's ranges verbatim tells the server "I already have all of it".
        if (rawMode > 0) {
            JSONObject req = sSabrReq;
            String b64 = req == null ? "" : req.optString("body", "");
            byte[] tpl = null;
            try { tpl = Base64.decode(b64, Base64.DEFAULT); } catch (Throwable ignore) { }
            if (tpl == null || tpl.length == 0) {
                out.put("ok", 0);
                out.put("why", "no captured player body");
                return out;
            }
            byte[] ours = Sabr.requestBody(p, 0);
            out.put("tplVid", req.optString("vid", ""));
            out.put("tplLen", tpl.length);
            out.put("ourLen", ours.length);
            out.put("tplFields", Sabr.topFields(tpl));
            out.put("ourFields", Sabr.topFields(ours));
            out.put("tplSc", Sabr.fieldInfo(tpl, 19));
            out.put("ourSc", Sabr.fieldInfo(ours, 19));
            out.put("raw", rawMode);
            out.put("tplBuf", Sabr.fieldInfo(tpl, 3));
            p.bodyTpl = tpl;
            p.bodyStrip = rawMode >= 2;
            // The page's clen belongs to the format the player picked; what the
            // replayed body selects may be another itag, so do not stop on it.
            p.expectedLength = 0;
            p.itag = 0;
        }
        out.put("itag", p.itag);
        out.put("xtags", p.xtags);
        out.put("lmt", p.lmt);
        out.put("want", p.expectedLength);
        out.put("ucfg", p.ustreamerConfig.length());
        out.put("ucfgFromBody", sSabrUcfg == null ? 0 : sSabrUcfg.length);
        out.put("urlPot", hasParam(p.url, "pot") ? 1 : 0);
        out.put("urlKeys", queryKeys(p.url));
        try {
            Sabr.Result r = Sabr.run(p, new Sabr.Sink() {
                public void onBytes(byte[] d, int off, int len) { }
            });
            out.put("ok", r.bytes > 0 ? 1 : 0);
            out.put("bytes", r.bytes);
            out.put("media", r.mediaBytes);
            out.put("segs", r.segments);
            out.put("posts", r.posts);
            out.put("eot", r.endOfTrack);
            out.put("clen", r.contentLength);
            out.put("endMs", r.endMs);
            out.put("firstMs", r.firstByteMs);
            out.put("parts", r.parts.toString());
            if (!r.err.isEmpty()) out.put("err", r.err);
            android.util.Log.i("VotBridge", "sabrtest page " + r.summary()
                    + " parts=" + r.parts);
        } catch (Throwable e) {
            out.put("ok", 0);
            out.put("err", String.valueOf(e));
        }
        out.put("ms", System.currentTimeMillis() - t0);
        return out;
    }

    private static JSONObject handleSabrReq(byte[] body) throws Exception {
        JSONObject o = new JSONObject();
        if (body.length == 0) throw new IOException("empty body");
        JSONObject req = new JSONObject(new String(body, StandardCharsets.UTF_8));
        String url = req.optString("url", "");
        if (url.isEmpty()) throw new IOException("no url");
        // The page fires some SABR posts with an empty body (or we get the POST
        // before the clone finishes). Keep the last capture that actually had a
        // body, otherwise the diagnostics see pageLen=0 half of the time.
        JSONObject prev = sSabrReq;
        String prevBody = prev == null ? "" : prev.optString("body", "");
        if (req.optString("body", "").isEmpty() && !prevBody.isEmpty()) {
            req.put("body", prevBody);
            o.put("bodyKept", 1);
        }
        sSabrReq = req;
        o.put("ok", 1);
        o.put("urlLen", url.length());
        o.put("bodyLen", req.optString("body", "").length());
        // Keep the ustreamer config the player actually sends: this is the only
        // copy the SABR server accepts for this stream.
        String b64 = req.optString("body", "");
        if (!b64.isEmpty()) {
            try {
                byte[] raw = Sabr.fieldBytes(Base64.decode(b64, Base64.DEFAULT), 5);
                if (raw != null && raw.length > 100) {
                    sSabrUcfg = raw;
                    sSabrUcfgVid = req.optString("vid", "");
                    o.put("ucfg", raw.length);
                }
            } catch (Throwable ignore) { }
        }
        return o;
    }

    // videoId the page attached to the config it posted ("" when unknown).
    private static String pageCfgVid() {
        JSONObject c = sSabrCfg;
        return c == null ? "" : c.optString("vid", "");
    }

    // The player's own VideoPlaybackAbrRequest body for this video, decoded.
    // Null when nothing was captured yet or the capture belongs to another
    // video (replaying somebody else's body answers with policies only).
    private static byte[] capturedSabrBody(String videoId) {
        JSONObject req = sSabrReq;
        if (req == null) return null;
        String rv = req.optString("vid", "");
        if (!rv.isEmpty() && !videoId.isEmpty() && !rv.equals(videoId)) return null;
        String b64 = req.optString("body", "");
        if (b64.isEmpty()) return null;
        try {
            byte[] b = Base64.decode(b64, Base64.DEFAULT);
            return b.length > 200 ? b : null;
        } catch (Throwable e) {
            return null;
        }
    }

    // True when the SABR pair (wire url + the player's own ustreamer config) can
    // be trusted for *this* video. Two sources qualify:
    //   1) /sabrcfg posted by the page for this very video;
    //   2) the player's own SABR POST captured from the wire (/sabrreq) for this
    //      video — it carries the wire url AND field 5 of its body.
    // The second source matters: on TV the page does not re-post the config for
    // every video, so sSabrCfg kept the previous video's id and the audio job
    // waited its full 12 s and then fell back to a client the bot gate blocks.
    // An unknown id counts as acceptable (older page builds do not send it); a
    // known different id does not.
    private static boolean pageSabrUsable(String videoId) {
        JSONObject c = sSabrCfg;
        if (c != null && sSabrUcfg != null && sSabrUcfg.length > 0) {
            String cv = c.optString("vid", "");
            boolean ok = true;
            if (!cv.isEmpty() && !cv.equals(videoId)) ok = false;
            if (!sSabrUcfgVid.isEmpty() && !sSabrUcfgVid.equals(videoId)) ok = false;
            if (ok) return true;
        }
        JSONObject r = sSabrReq;
        if (r == null) return false;
        if (!videoId.equals(r.optString("vid", ""))) return false;
        if (r.optString("url", "").isEmpty()) return false;
        return capturedSabrBody(videoId) != null;
    }

    // Base64 of the config the player sends; empty when nothing was captured yet.
    private static String sabrUcfgB64() {
        byte[] c = sSabrUcfg;
        if (c == null || c.length == 0) return "";
        return Base64.encodeToString(c, Base64.NO_WRAP);
    }

    // Params for "our" request, taken from the page's own config and, when it
    // is missing or belongs to another video, straight from the player's own
    // captured SABR request (url + body).
    private static Sabr.Params sabrParamsFromCfg(int itagOverride) {
        JSONObject cfg = sSabrCfg;
        Sabr.Params p = new Sabr.Params();
        p.videoId = videoIdOfPage();
        // The config's `serverAbrStreamingUrl` answers 403 without a po token;
        // the url the player actually POSTs to (captured from the wire, with
        // alr/cpn/cver/rn/spc) is accepted as is.
        JSONObject req = sSabrReq;
        String wire = req == null ? "" : req.optString("url", "").trim();
        if (!wire.isEmpty()) p.url = wire;
        else p.url = cfg == null ? "" : cfg.optString("url", "");
        // Prefer the config copied out of the player's own request; the copy in
        // the player response gets `sabr.malformed_config`.
        String fromBody = sabrUcfgB64();
        p.ustreamerConfig = !fromBody.isEmpty() ? fromBody
                : cfg == null ? "" : cfg.optString("ucfg", "");
        p.visitorData = cfg == null ? "" : cfg.optString("vd", "");
        p.itag = itagOverride > 0 ? itagOverride
                : cfg == null ? 0 : cfg.optInt("itag", 0);
        p.lmt = cfg == null ? 0L : longOf(cfg.optString("lmt", ""));
        // The TV player picks the auto-dubbed track (`acont=dubbed-auto:lang=xx`)
        // and the SABR server answers such a request with a policy/seek frame
        // instead of media (resp≈170 B, no MEDIA part). Yandex needs the
        // original voice anyway, so drop the dub and ask for the plain track.
        String xt = cfg == null ? "" : cfg.optString("xtags", "");
        // `xtags` is normally base64 protobuf, so a plain text search misses
        // `dubbed` entirely and the dub would be requested as is.
        if (xtagsText(xt).toLowerCase().indexOf("dubbed") >= 0) {
            xt = "";
            p.lmt = 0;   // lmt belongs to the dubbed track
        }
        p.xtags = xt;
        p.clientName = 7;
        return p;
    }

    // /sabrbody: structural dump of the player's own SABR request body next to
    // the protobuf our encoder builds from the same page config. Field numbers,
    // lengths and short strings only — enough to see what is missing or extra.
    private static JSONObject handleSabrBody(int itagOverride) throws Exception {
        JSONObject out = new JSONObject();
        JSONObject req = sSabrReq;
        byte[] page = new byte[0];
        if (req != null) {
            String b64 = req.optString("body", "");
            if (!b64.isEmpty()) {
                try {
                    page = Base64.decode(b64, Base64.DEFAULT);
                } catch (Throwable e) {
                    out.put("pageErr", String.valueOf(e));
                }
            }
        }
        byte[] our = Sabr.requestBody(sabrParamsFromCfg(itagOverride), 0);
        out.put("pageLen", page.length);
        out.put("ourLen", our.length);
        out.put("pageTop", Sabr.topFields(page));
        out.put("ourTop", Sabr.topFields(our));
        out.put("page", Sabr.dump(page));
        out.put("our", Sabr.dump(our));
        out.put("pageUcfg", Sabr.fieldInfo(page, 5));
        out.put("ourUcfg", Sabr.fieldInfo(our, 5));
        out.put("pageCtx", Sabr.fieldInfo(page, 19));
        out.put("ourCtx", Sabr.fieldInfo(our, 19));
        // Is the ustreamer config in the page's *request* the same bytes we get
        // from the player response (`ucfg`)? If not, our body carries a config
        // the server never issued for this stream.
        out.put("ucfgVsBody", Sabr.cmp(Sabr.fieldBytes(page, 5),
                Sabr.b64Of(sabrParamsFromCfg(itagOverride).ustreamerConfig)));
        android.util.Log.i("VotBridge", "sabrbody page=" + page.length + " our=" + our.length);
        return out;
    }

    // One POST on the SABR endpoint, reporting only what identifies the answer:
    // code, size, part types, first media bytes. Response is capped, the media
    // itself is never stored.
    private static JSONObject sabrPost(String url, byte[] body) throws Exception {
        JSONObject o = new JSONObject();
        HttpURLConnection c = null;
        try {
            c = (HttpURLConnection) new URL(url).openConnection();
            c.setConnectTimeout(10000);
            c.setReadTimeout(30000);
            c.setRequestMethod("POST");
            c.setDoOutput(true);
            c.setFixedLengthStreamingMode(body.length);
            c.setRequestProperty("Content-Type", "application/x-protobuf");
            c.setRequestProperty("Accept", "application/vnd.yt-ump");
            c.setRequestProperty("Accept-Encoding", "identity");
            OutputStream os = c.getOutputStream();
            os.write(body);
            os.close();
            int code = c.getResponseCode();
            o.put("code", code);
            o.put("ctype", hdr(c, "Content-Type"));
            InputStream in = code == 200 ? c.getInputStream() : c.getErrorStream();
            byte[] resp = in == null ? new byte[0] : readN(in, 512 * 1024);
            o.put("len", resp.length);
            if (resp.length > 0) {
                JSONObject p = Sabr.inspect(resp);
                o.put("itag", p.optInt("itag", 0));
                o.put("media", p.optLong("media", 0));
                o.put("segs", p.optInt("segs", 0));
                o.put("parts", p.optString("parts", ""));
                o.put("byItag", p.optString("byItag", ""));
                if (p.has("err")) o.put("err", p.optString("err", ""));
                o.put("hex", hexHead(resp, 16));
            }
        } catch (Throwable e) {
            o.put("err", String.valueOf(e));
        } finally {
            if (c != null) c.disconnect();
        }
        return o;
    }

    // /sabrmix: the page's own request is the only body the server accepts, so
    // the probe starts from it and removes/changes one thing at a time. The
    // first row that still returns media after losing the page's video formats
    // and gaining itag 140 is the shape we can build ourselves.
    private static JSONObject handleSabrMix(int itagOverride) throws Exception {
        JSONObject out = new JSONObject();
        JSONObject req = sSabrReq;
        if (req == null || sSabrCfg == null) {
            out.put("ok", 0);
            out.put("why", "need both captured request and page config");
            return out;
        }
        String url = req.optString("url", "");
        if (url.isEmpty()) url = sSabrCfg.optString("url", "");
        byte[] page = Base64.decode(req.optString("body", ""), Base64.DEFAULT);
        if (page.length == 0) {
            out.put("ok", 0);
            out.put("why", "captured body is empty; wait for the next sabr-body log line");
            return out;
        }
        Sabr.Params p = sabrParamsFromCfg(itagOverride);
        byte[] our = Sabr.requestBody(p, 0);
        out.put("urlLen", url.length());
        out.put("pageLen", page.length);
        out.put("ourLen", our.length);
        out.put("pageTop", Sabr.topFields(page));
        out.put("ourTop", Sabr.topFields(our));
        JSONArray rows = new JSONArray();
        String[] names = new String[]{"page", "page+our4", "page-sel140", "page-sel140+pa",
                "page-sel140+pa+ctx", "page-sel140+pa+ctx+abr", "page-sel140-min",
                "our", "our+page5", "our+page5+ctx"};
        out.put("audioItag", Sabr.audioItagOf(page));
        for (int i = 0; i < names.length; i++) {
            byte[] body;
            try {
                switch (i) {
                    case 0:
                        body = page;
                        break;
                    case 1:
                        body = Sabr.mix(page, our, 4);
                        break;
                    case 2:
                        body = Sabr.mix(page, our, 2);
                        break;
                    case 3:
                        body = Sabr.mix(Sabr.mix(page, our, 2), our, 16);
                        break;
                    case 4:
                        body = Sabr.mix(Sabr.mix(Sabr.mix(page, our, 2), our, 16), our, 19);
                        break;
                    case 5:
                        body = Sabr.mix(Sabr.mix(Sabr.mix(Sabr.mix(page, our, 2), our, 16),
                                our, 19), our, 1);
                        break;
                    case 6: {
                        byte[] b = Sabr.mix(Sabr.mix(Sabr.mix(Sabr.mix(page, our, 2), our, 16),
                                our, 19), our, 1);
                        body = Sabr.drop(b, 17, 22, 23);
                        break;
                    }
                    case 7:
                        body = our;
                        break;
                    case 8:
                        body = Sabr.mix(our, page, 5);
                        break;
                    default:
                        body = Sabr.mix(Sabr.mix(our, page, 5), page, 19);
                        break;
                }
            } catch (Throwable e) {
                JSONObject row = new JSONObject();
                row.put("v", names[i]);
                row.put("err", String.valueOf(e));
                rows.put(row);
                continue;
            }
            JSONObject row = sabrPost(url, body);
            row.put("v", names[i]);
            row.put("bodyLen", body.length);
            rows.put(row);
            android.util.Log.i("VotBridge", "sabrmix " + names[i] + " body=" + body.length
                    + " code=" + row.optInt("code", 0) + " len=" + row.optInt("len", 0)
                    + " media=" + row.optLong("media", 0) + " itag=" + row.optInt("itag", 0)
                    + " parts=" + row.optString("parts", "")
                    + (row.has("err") ? " err=" + row.optString("err", "") : ""));
        }
        out.put("ok", 1);
        out.put("rows", rows);
        return out;
    }

    private static JSONObject handleSabrReplay(String mode, String videoId, int itag,
                                               String visitorData) throws Exception {
        JSONObject out = new JSONObject();
        JSONObject req = sSabrReq;
        if (req == null) {
            out.put("ok", 0);
            out.put("why", "no captured request yet");
            return out;
        }
        String url = req.optString("url", "");
        String b64 = req.optString("body", "");
        byte[] data = new byte[0];
        out.put("mode", mode.isEmpty() ? "page" : mode);
        if ("nobody".equals(mode)) {
            // URL + headers only: tells whether the signature itself is refused.
        } else if ("ourbody".equals(mode)) {
            // Same URL and headers as the player, but the protobuf body we
            // build ourselves: tells whether our encoder is the problem.
            try {
                PoToken.Tokens t = visitorData.isEmpty()
                        ? PoToken.get(sAppCtx, videoId)
                        : PoToken.getWithVisitor(sAppCtx, videoId, visitorData);
                JSONObject j = itPlayer(videoId, C_TV, t.visitorData, t.playerPot);
                SabrPick f = pickSabrAudio(j);
                Sabr.Params p = sabrParams(videoId, j, t, f);
                if (itag > 0) p.itag = itag;
                data = Sabr.requestBody(p, 0);
                out.put("itag", p.itag);
            } catch (Throwable e) {
                out.put("bodyErr", String.valueOf(e));
            }
        } else if (!b64.isEmpty()) {
            try {
                data = Base64.decode(b64, Base64.DEFAULT);
            } catch (Throwable e) {
                out.put("bodyErr", String.valueOf(e));
            }
        }
        JSONObject hs = req.optJSONObject("headers");
        if ("range".equals(mode)) return sabrRangeProbe(url, hs);
        String reqMethod = req.optString("method", "POST").toUpperCase();
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        try {
            c.setConnectTimeout(10000);
            c.setReadTimeout(20000);
            c.setRequestMethod("GET".equals(reqMethod) ? "GET" : "POST");
            boolean sendsBody = !"GET".equals(reqMethod);
            if (sendsBody) {
                c.setDoOutput(true);
                c.setFixedLengthStreamingMode(data.length);
            }
            out.put("method", reqMethod);
            if (hs != null) {
                java.util.Iterator<String> it = hs.keys();
                while (it.hasNext()) {
                    String k = it.next();
                    // Host/Content-Length are set by the stack, everything else
                    // is replayed verbatim.
                    if ("host".equals(k) || "content-length".equals(k)) continue;
                    try {
                        c.setRequestProperty(k, hs.optString(k, ""));
                    } catch (Throwable ignored) { }
                }
            }
            if (sendsBody) {
                OutputStream os = c.getOutputStream();
                os.write(data);
                os.close();
            }
            int code = c.getResponseCode();
            out.put("ok", code == 200 ? 1 : 0);
            out.put("code", code);
            out.put("bodyLen", data.length);
            out.put("urlLen", url.length());
            out.put("ctype", hdr(c, "Content-Type"));
            out.put("respClen", hdr(c, "Content-Length"));
            InputStream in = code == 200 ? c.getInputStream() : c.getErrorStream();
            byte[] resp = in == null ? new byte[0] : readN(in, 4 * 1024 * 1024);
            out.put("respLen", resp.length);
            out.put("hex", hexHead(resp, 32));
            if (code == 200) {
                JSONObject parsed = Sabr.inspect(resp);
                out.put("itag", parsed.optInt("itag", 0));
                out.put("media", parsed.optLong("media", 0L));
                out.put("segs", parsed.optInt("segs", 0));
                out.put("parts", parsed.optString("parts", ""));
                if (parsed.has("xtags")) out.put("xtags", parsed.optString("xtags", ""));
            } else {
                out.put("errBody", new String(resp, 0, Math.min(resp.length, 300),
                        StandardCharsets.UTF_8));
            }
            android.util.Log.i("VotBridge", "sabrreplay code=" + code + " body=" + data.length
                    + " resp=" + resp.length);
            return out;
        } finally {
            c.disconnect();
        }
    }

    // Plain GET with a byte window on the same url the page uses. If this is
    // 206 with a real Content-Range, the whole SABR detour is unnecessary: the
    // url can be downloaded like any other audio track.
    private static JSONObject sabrRangeProbe(String url, JSONObject hs) throws Exception {
        JSONObject out = new JSONObject();
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        try {
            c.setConnectTimeout(10000);
            c.setReadTimeout(20000);
            c.setRequestProperty("Range", "bytes=0-1023");
            if (hs != null) {
                java.util.Iterator<String> it = hs.keys();
                while (it.hasNext()) {
                    String k = it.next();
                    if ("host".equals(k) || "content-length".equals(k)
                            || "range".equals(k) || "content-type".equals(k)
                            || "content-encoding".equals(k)) continue;
                    try {
                        c.setRequestProperty(k, hs.optString(k, ""));
                    } catch (Throwable ignored) { }
                }
            }
            int code = c.getResponseCode();
            out.put("mode", "range");
            out.put("ok", code == 206 || code == 200 ? 1 : 0);
            out.put("code", code);
            out.put("ctype", hdr(c, "Content-Type"));
            out.put("respClen", hdr(c, "Content-Length"));
            out.put("contentRange", hdr(c, "Content-Range"));
            InputStream in = code == 200 || code == 206 ? c.getInputStream() : c.getErrorStream();
            byte[] resp = in == null ? new byte[0] : readN(in, 4096);
            out.put("respLen", resp.length);
            out.put("hex", hexHead(resp, 32));
            android.util.Log.i("VotBridge", "sabrrangeprobe code=" + code + " len=" + resp.length
                    + " cr=" + hdr(c, "Content-Range"));
            return out;
        } finally {
            c.disconnect();
        }
    }

    private static String hdr(HttpURLConnection c, String name) {
        try {
            String v = c.getHeaderField(name);
            return v == null ? "" : v;
        } catch (Throwable e) {
            return "";
        }
    }

    private static String hexHead(byte[] b, int n) {
        if (b == null || b.length == 0) return "";
        StringBuilder sb = new StringBuilder();
        int lim = Math.min(n, b.length);
        for (int i = 0; i < lim; i++) {
            if (i > 0) sb.append(' ');
            int v = b[i] & 0xFF;
            if (v < 16) sb.append('0');
            sb.append(Integer.toHexString(v));
        }
        return sb.toString();
    }

    // /sabrdiag?page=1: the same url, the same body, several header sets.
    // Our POST gets 403 while replaying the player's request gets 200, so the
    // difference is in what we put on the wire. Each row is one combination.
    private static JSONObject handleSabrDiag(int itagOverride) throws Exception {
        JSONObject out = new JSONObject();
        JSONObject cfg = sSabrCfg;
        if (cfg == null) {
            out.put("ok", 0);
            out.put("why", "no page config yet");
            return out;
        }
        String url = cfg.optString("url", "");
        Sabr.Params p = new Sabr.Params();
        p.videoId = videoIdOfPage();
        p.url = url;
        p.ustreamerConfig = cfg.optString("ucfg", "");
        p.visitorData = cfg.optString("vd", "");
        p.itag = itagOverride > 0 ? itagOverride : cfg.optInt("itag", 0);
        p.lmt = longOf(cfg.optString("lmt", ""));
        p.xtags = cfg.optString("xtags", "");
        p.clientName = 7;
        byte[] body = Sabr.requestBody(p, 0);

        String full = "full";
        String[] fullKv = new String[]{
                "Content-Type", "application/x-protobuf",
                "Accept", "application/vnd.yt-ump",
                "Accept-Encoding", "identity",
                "User-Agent", "Cobalt",
                "X-Goog-Visitor-Id", p.visitorData,
                "X-Youtube-Client-Name", "7",
                "Origin", "https://www.youtube.com",
                "Referer", "https://www.youtube.com/"
        };
        String[] minKv = new String[]{"Content-Type", "application/x-protobuf"};

        JSONArray rows = new JSONArray();
        Object[][] combos = new Object[][]{
                {"min+norn", minKv, body, 0},
                {"min+rn", minKv, body, 1},
                {"full+norn", fullKv, body, 0},
                {"full+rn", fullKv, body, 1},
                {"min+empty", minKv, new byte[0], 1},
                {"nohdr+rn", null, body, 1}
        };
        for (int i = 0; i < combos.length; i++) {
            JSONObject row = new JSONObject();
            row.put("v", String.valueOf(combos[i][0]));
            try {
                Sabr.Raw rr = Sabr.postRaw(url, (byte[]) combos[i][2],
                        (String[]) combos[i][1], (Integer) combos[i][3]);
                row.put("code", rr.code);
                row.put("ctype", rr.ctype);
                row.put("len", rr.len);
                row.put("hex", rr.head);
                if (!rr.err.isEmpty()) row.put("err", rr.err);
            } catch (Throwable e) {
                row.put("err", String.valueOf(e));
            }
            rows.put(row);
        }
        out.put("ok", 1);
        out.put("bodyLen", body.length);
        out.put("urlLen", url.length());
        out.put("itag", p.itag);
        out.put("rows", rows);
        android.util.Log.i("VotBridge", "sabrdiag body=" + body.length + " " + rows);
        return out;
    }

    // /sabrtest?wire=1: the page's own wire url (the exact string its player
    // POSTs to) with the page's own ustreamer config. 403 on the plain
    // `serverAbrStreamingUrl` but 200 on the wire url means the player appends
    // something (pot/rn/alr) that the server requires.
    private static JSONObject handleSabrTestWire(int itagOverride) throws Exception {
        JSONObject out = new JSONObject();
        JSONObject cfg = sSabrCfg;
        JSONObject req = sSabrReq;
        if (cfg == null) {
            out.put("ok", 0);
            out.put("why", "no page config yet");
            return out;
        }
        String baseUrl = cfg.optString("url", "");
        String wireUrl = req == null ? "" : req.optString("url", "");
        out.put("cfgUrlLen", baseUrl.length());
        out.put("wireUrlLen", wireUrl.length());
        out.put("urlDiff", urlDiff(baseUrl, wireUrl));
        String url = wireUrl.isEmpty() ? baseUrl : wireUrl;
        long t0 = System.currentTimeMillis();
        Sabr.Params p = new Sabr.Params();
        p.videoId = videoIdOfPage();
        p.url = url;
        p.ustreamerConfig = cfg.optString("ucfg", "");
        p.visitorData = cfg.optString("vd", "");
        p.itag = itagOverride > 0 ? itagOverride : cfg.optInt("itag", 0);
        p.lmt = longOf(cfg.optString("lmt", ""));
        p.xtags = cfg.optString("xtags", "");
        p.expectedLength = longOf(cfg.optString("clen", ""));
        p.maxPosts = 4;
        out.put("ucfg", p.ustreamerConfig.length());
        out.put("src", wireUrl.isEmpty() ? "cfg" : "wire");
        out.put("itag", p.itag);
        out.put("want", p.expectedLength);

        // poToken lives inside streamer_context.po_token (19.2), not in the
        // url — without it SABR answers with an error frame. Probe the three
        // candidates, then run the winner to the end.
        String vd = p.visitorData;
        String[] names = new String[]{"none", "player", "stream"};
        String[] toks = new String[]{"", "", ""};
        if (!vd.isEmpty()) {
            try {
                PoToken.Tokens t = PoToken.getWithVisitor(sAppCtx, p.videoId, vd);
                toks[1] = t.playerPot;
                toks[2] = t.streamingPot;
            } catch (Throwable e) {
                out.put("potErr", String.valueOf(e));
            }
        }
        JSONArray probe = new JSONArray();
        int best = -1;
        for (int i = 0; i < names.length; i++) {
            JSONObject row = new JSONObject();
            row.put("pot", names[i]);
            row.put("len", toks[i].length());
            Sabr.Params q = p.copy();
            q.poToken = toks[i];
            try {
                Sabr.Result pr = Sabr.run(q, null);
                row.put("bytes", pr.bytes);
                row.put("parts", pr.parts.toString());
                if (!pr.err.isEmpty()) row.put("err", pr.err);
                if (pr.bytes > 0 && best < 0) best = i;
            } catch (Throwable e) {
                row.put("err", String.valueOf(e));
            }
            probe.put(row);
        }
        out.put("probe", probe);
        if (best < 0) {
            out.put("ok", 0);
            out.put("why", "no pot variant produced bytes");
            out.put("ms", System.currentTimeMillis() - t0);
            return out;
        }
        out.put("pot", names[best]);
        p.poToken = toks[best];
        p.maxPosts = 60;
        try {
            Sabr.Result r = Sabr.run(p, new Sabr.Sink() {
                public void onBytes(byte[] d, int off, int len) { }
            });
            out.put("ok", r.bytes > 0 ? 1 : 0);
            out.put("bytes", r.bytes);
            out.put("media", r.mediaBytes);
            out.put("segs", r.segments);
            out.put("posts", r.posts);
            out.put("eot", r.endOfTrack);
            out.put("clen", r.contentLength);
            out.put("endMs", r.endMs);
            out.put("firstMs", r.firstByteMs);
            out.put("parts", r.parts.toString());
            if (!r.err.isEmpty()) out.put("err", r.err);
            android.util.Log.i("VotBridge", "sabrtest wire " + r.summary()
                    + " parts=" + r.parts);
        } catch (Throwable e) {
            out.put("ok", 0);
            out.put("err", String.valueOf(e));
        }
        out.put("ms", System.currentTimeMillis() - t0);
        return out;
    }

    // Which query params each url has that the other lacks. Kept tiny on
    // purpose: it goes straight into an HTTP response.
    private static String urlDiff(String a, String b) {
        try {
            java.util.Set<String> ka = new java.util.HashSet<>(java.util.Arrays.asList(
                    queryKeys(a).split(",")));
            java.util.Set<String> kb = new java.util.HashSet<>(java.util.Arrays.asList(
                    queryKeys(b).split(",")));
            java.util.Set<String> added = new java.util.TreeSet<>(kb);
            added.removeAll(ka);
            java.util.Set<String> dropped = new java.util.TreeSet<>(ka);
            dropped.removeAll(kb);
            return "added=" + added + " dropped=" + dropped;
        } catch (Throwable e) {
            return "diffErr=" + e;
        }
    }

    private static JSONObject handleSabrTest(String videoId, int itag, String visitorData)
            throws Exception {
        JSONObject out = new JSONObject();
        PoToken.Tokens t = visitorData.isEmpty()
                ? PoToken.get(sAppCtx, videoId)
                : PoToken.getWithVisitor(sAppCtx, videoId, visitorData);
        long t0 = System.currentTimeMillis();
        JSONObject j = itPlayer(videoId, C_TV, t.visitorData, t.playerPot);
        JSONObject ps = j.optJSONObject("playabilityStatus");
        JSONObject sd = j.optJSONObject("streamingData");
        out.put("status", ps == null ? "" : ps.optString("status", ""));
        String url = sd == null ? "" : sd.optString("serverAbrStreamingUrl", "");
        out.put("sabr", url.isEmpty() ? 0 : 1);
        out.put("ustreamer", ustreamerConfig(j).length());
        if (url.isEmpty()) {
            out.put("ok", 0);
            out.put("why", "no serverAbrStreamingUrl");
            out.put("reason", ps == null ? "" : ps.optString("reason", ""));
            return out;
        }
        SabrPick f = pickSabrAudio(j);
        out.put("fmtItag", f == null ? 0 : f.itag);
        out.put("fmtClen", f == null ? 0 : f.clen);
        out.put("urlKeys", queryKeys(url));
        out.put("urlPot", hasParam(url, "pot") ? 1 : 0);
        out.put("streamPotLen", t.streamingPot.length());
        out.put("playerPotLen", t.playerPot.length());
        Sabr.Params base = sabrParams(videoId, j, t, f);
        if (itag > 0) base.itag = itag;

        // One POST per token variant: a bare 403 means "this token is not the
        // one googlevideo wants for SABR", actual media bytes mean it is.
        String[] names = new String[]{"stream-ctx", "stream-ctx+url", "player-ctx+url", "none-ctx"};
        String[] toks = new String[]{t.streamingPot, t.streamingPot, t.playerPot, ""};
        boolean[] inUrl = new boolean[]{false, true, true, false};
        JSONArray probe = new JSONArray();
        int best = -1;
        for (int i = 0; i < names.length; i++) {
            Sabr.Params pv = base.copy();
            pv.poToken = toks[i];
            pv.urlPot = inUrl[i];
            pv.maxPosts = 1;
            JSONObject row = new JSONObject();
            row.put("v", names[i]);
            row.put("potLen", toks[i].length());
            try {
                Sabr.Result pr = Sabr.run(pv, null);
                row.put("bytes", pr.bytes);
                row.put("media", pr.mediaBytes);
                row.put("parts", pr.parts.toString());
                if (pr.bytes > 0 && best < 0) best = i;
            } catch (Throwable e) {
                row.put("err", String.valueOf(e.getMessage()));
            }
            probe.put(row);
        }
        out.put("probe", probe);
        if (best < 0) {
            out.put("ok", 0);
            out.put("why", "all probe variants failed");
            out.put("ms", System.currentTimeMillis() - t0);
            return out;
        }
        out.put("variant", names[best]);
        Sabr.Params p = base.copy();
        p.poToken = toks[best];
        p.urlPot = inUrl[best];
        p.maxPosts = 60;
        Sabr.Result r = Sabr.run(p, new Sabr.Sink() {
            public void onBytes(byte[] d, int off, int len) { }
        });
        out.put("ok", r.bytes > 0 ? 1 : 0);
        out.put("bytes", r.bytes);
        out.put("mediaBytes", r.mediaBytes);
        out.put("itag", r.itag);
        out.put("segs", r.segments);
        out.put("posts", r.posts);
        out.put("endMs", r.endMs);
        out.put("eot", r.endOfTrack);
        out.put("clen", r.contentLength);
        out.put("firstMs", r.firstByteMs);
        out.put("ms", System.currentTimeMillis() - t0);
        out.put("parts", r.parts.toString());
        out.put("err", r.err);
        android.util.Log.i("VotBridge", "sabrtest id=" + videoId + " " + r.summary()
                + " ms=" + (System.currentTimeMillis() - t0));
        return out;
    }

    // /audiotest: pot -> player (web or vr) -> Range GET probe, all on the TV.
    // Probes twice: with "&pot=<playerPot>" and without, so we can tell a
    // gvs-gate 403 (needs pot) from a dead URL (403 both ways).
    private static JSONObject handleAudioTest(String videoId, String client) throws Exception {
        Client cl = clientByName(client);
        if (cl == null) cl = C_VR;
        JSONObject out = new JSONObject();
        out.put("client", cl.name);
        PoToken.Tokens t = PoToken.get(sAppCtx, videoId);
        JSONObject j = itPlayer(videoId, cl, t.visitorData, t.playerPot);
        JSONObject ps = j.optJSONObject("playabilityStatus");
        out.put("status", ps == null ? "" : ps.optString("status", ""));
        JSONObject sd = j.optJSONObject("streamingData");
        out.put("sabr", sd != null && sd.has("serverAbrStreamingUrl"));
        JSONArray fmts = sd == null ? null : sd.optJSONArray("adaptiveFormats");
        out.put("nFormats", fmts == null ? 0 : fmts.length());
        JSONObject f = pickAudio(j);
        if (f == null) {
            out.put("ok", 0);
            out.put("error", "no audio format with a plain url");
            out.put("reason", ps == null ? "" : ps.optString("reason", ""));
            return out;
        }
        String bare = f.optString("url", "");
        // Two different token kinds exist (like yt-dlp's web.player vs web.gvs):
        // the content-bound one signs the player request, the visitor-bound one
        // ("streaming" pot) is what googlevideo expects as the "pot" url param.
        String withPlayer = t.playerPot.isEmpty() || hasParam(bare, "pot")
                ? bare : bare + "&pot=" + PoToken.urlEnc(t.playerPot);
        String withStream = t.streamingPot.isEmpty() || hasParam(bare, "pot")
                ? bare : bare + "&pot=" + PoToken.urlEnc(t.streamingPot);
        int itag = f.optInt("itag", 0);
        String mime = f.optString("mimeType", "");
        out.put("itag", itag);
        out.put("mime", mime);
        out.put("clen", qclen(bare));
        out.put("n", hasParam(bare, "n"));
        String ua = cl.uaOrWeb();
        int[] playerRes = probeRange(withPlayer, ua);
        String playerBody = sProbeErrBody;
        int[] streamRes = probeRange(withStream, ua);
        String streamBody = sProbeErrBody;
        int[] bareRes = probeRange(bare, ua);
        String bareBody = sProbeErrBody;
        out.put("urlKeys", queryKeys(bare));
        out.put("playerErr", playerBody);
        out.put("streamErr", streamBody);
        out.put("bareErr", bareBody);
        out.put("playerPotCode", playerRes[0]);
        out.put("playerPotBytes", playerRes[1]);
        out.put("streamPotCode", streamRes[0]);
        out.put("streamPotBytes", streamRes[1]);
        out.put("noPotCode", bareRes[0]);
        out.put("noPotBytes", bareRes[1]);
        boolean ok = (playerRes[0] == 206 || playerRes[0] == 200) && playerRes[1] > 0;
        boolean okStream = (streamRes[0] == 206 || streamRes[0] == 200) && streamRes[1] > 0;
        out.put("ok", ok || okStream ? 1 : 0);
        out.put("best", ok ? "player" : okStream ? "stream" : "");
        android.util.Log.i("VotBridge", "audiotest " + videoId + " " + cl.name
                + " itag=" + itag + " playerPot=" + playerRes[0] + "/" + playerRes[1]
                + " streamPot=" + streamRes[0] + "/" + streamRes[1]
                + " noPot=" + bareRes[0] + "/" + bareRes[1]);
        return out;
    }

    // ?all=1: walk the client list once and report every result, so a single
    // HTTP call tells us which client still hands out a downloadable url.
    private static JSONObject handleAudioTestAll(String videoId) throws Exception {
        PoToken.Tokens t = PoToken.get(sAppCtx, videoId);
        JSONObject out = new JSONObject();
        JSONArray arr = new JSONArray();
        String best = "";
        for (int i = 0; i < AUDIO_CLIENTS.length; i++) {
            Client cl = AUDIO_CLIENTS[i];
            JSONObject r;
            try {
                r = handleAudioTest(videoId, cl.name == null ? "" : cl.name);
            } catch (Throwable e) {
                r = new JSONObject();
                r.put("client", cl.name);
                r.put("ok", 0);
                r.put("error", String.valueOf(e));
            }
            arr.put(r);
            if (best.isEmpty() && r.optInt("ok", 0) == 1) {
                best = cl.name + "/" + r.optString("best", "");
            }
        }
        out.put("ok", best.isEmpty() ? 0 : 1);
        out.put("best", best);
        out.put("tests", arr);
        return out;
    }

    // Range GET of 64 bytes; returns {httpCode, bytesRead}. For a 4xx we also
    // scrape the first bytes of the error body into sProbeErrBody: googlevideo
    // explains the reason there ("Sign in to confirm you're not a bot",
    // "url expired", ...), which is the only way to tell the gates apart.
    private static volatile String sProbeErrBody = "";
    private static volatile String sLastProbeUrl = "";

    private static int[] probeRange(String url, String ua) {
        int code = -1;
        int got = 0;
        sProbeErrBody = "";
        sLastProbeUrl = url;
        try {
            HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
            c.setConnectTimeout(8000);
            c.setReadTimeout(15000);
            c.setRequestProperty("User-Agent", ua);
            c.setRequestProperty("Range", "bytes=0-63");
            code = c.getResponseCode();
            if (code < 400) {
                byte[] b = new byte[64];
                int n = c.getInputStream().read(b);
                got = n > 0 ? n : 0;
            } else {
                sProbeErrBody = errBodySnippet(c);
            }
            try { c.disconnect(); } catch (Throwable ignored) { }
        } catch (Throwable e) {
            android.util.Log.i("VotBridge", "probe failed: " + e);
        }
        return new int[]{code, got};
    }

    // Up to 220 printable chars of an error body (html tags and newlines folded).
    private static String errBodySnippet(HttpURLConnection c) {
        try {
            InputStream es = c.getErrorStream();
            if (es == null) return "";
            byte[] b = new byte[600];
            int n = es.read(b);
            es.close();
            if (n <= 0) return "";
            String s = new String(b, 0, n, StandardCharsets.UTF_8);
            s = s.replaceAll("<[^>]*>", " ").replaceAll("\\s+", " ").trim();
            return s.length() > 220 ? s.substring(0, 220) : s;
        } catch (Throwable e) {
            return "";
        }
    }

    // Appends "&pot=" unless the url already carries one.
    private static String withPotParam(String url, String tok) {
        return tok == null || tok.isEmpty() || hasParam(url, "pot")
                ? url : url + "&pot=" + PoToken.urlEnc(tok);
    }

    // Tries the pot variants on a googlevideo url and returns the first payload
    // that actually downloads. For the non-WEB clients the fork never adds a
    // token at all, so the bare url is tried first there.
    private static byte[] downloadWithPot(String url, Client cl, PoToken.Tokens t) {
        String ua = cl.uaOrWeb();
        String[] variants = new String[]{withPotParam(url, t.playerPot),
                withPotParam(url, t.streamingPot), url};
        String[] names = new String[]{"player", "stream", "none"};
        for (int i = 0; i < variants.length; i++) {
            int[] p = probeRange(variants[i], ua);
            android.util.Log.i("VotBridge", "download probe " + names[i] + " code=" + p[0]
                    + " bytes=" + p[1]);
            if (!((p[0] == 206 || p[0] == 200) && p[1] > 0)) continue;
            try {
                byte[] d = httpGetFull(variants[i], ua);
                if (d != null && d.length > 0) {
                    android.util.Log.i("VotBridge", "download ok via " + names[i]
                            + " bytes=" + d.length);
                    return d;
                }
            } catch (Throwable e) {
                android.util.Log.e("VotBridge", "download " + names[i] + " failed: " + e);
            }
        }
        return null;
    }

    // ---- /audiosrc: full audio track, no playback involved -----------------
    // status=6 means Yandex has no cache entry and cannot pull the track itself,
    // so it asks us for the source file. We ask InnerTube for the audio-only
    // adaptive format (measured on the TV: ANDROID_VR / ANDROID / VISIONOS all
    // return a plain googlevideo url whose Range GET answers 206, with no "n"
    // parameter and without any poToken), Range-download it in 5 295 308-byte
    // pieces and push every piece straight to Yandex. Same contract as the Vox
    // fork's VotYouTubeAudioSource + VotAudioUploader, but the bytes never
    // accumulate in memory and the page/player is not touched at all: the job
    // runs in its own thread and the overlay polls /audiosrc/status.
    private static final Object ASRC_LOCK = new Object();
    private static volatile JSONObject sAsrcState = new JSONObject();
    private static volatile int sAsrcGen;

    // Page-relay for urls the bridge itself cannot download (403 with an empty
    // body). Measured on the TV: in the same minute one video answers 206 to the
    // bridge and another answers 403 for every client and every poToken variant,
    // while the page keeps playing that same media. So when the bridge is
    // blocked, the url is handed to the page, which pulls the parts with its own
    // XHR (its network stack is the one the player uses) and posts them back.
    private static volatile String sPageUrl = "";
    private static volatile String sPageFileId = "";
    private static volatile String sPageVideoUrl = "";
    private static volatile String sPageTid = "";
    private static volatile int sPageItag;
    private static volatile long sPageClen;
    private static volatile int sPageTotal;
    private static volatile long sPageSent;
    private static volatile int sPageLastPart = -1;
    private static volatile int sPageGen;

    private static JSONObject audioSourceStatus() {
        JSONObject o = sAsrcState;
        try {
            return new JSONObject(o.toString());
        } catch (Throwable e) {
            return new JSONObject();
        }
    }

    private static void asrcSet(JSONObject o) {
        sAsrcState = o;
        try {
            // Any successful audio job publishes what the bridge actually gave
            // the player / pushed to Yandex: the overlay reads it over /source.
            if (o != null && "done".equals(o.optString("state", ""))) {
                publishSource(o.optString("videoId", ""), o.optString("client", ""),
                        o.optInt("itag", 0), o.optLong("size", 0L));
            }
        } catch (Throwable e) { }
    }

    // The page's own track choice, in the bridge's terms: the SABR request drops
    // a `dubbed` xtags (the server answers dubs with a policy frame), so the
    // bytes Yandex gets are the plain/original voice.
    private static void publishSource(String videoId, String client, int itag, long size) {
        JSONObject c = sSabrCfg;
        String xt = c == null ? "" : c.optString("xtags", "");
        String xtText = xtagsText(xt);
        TrackMeta m = new TrackMeta();
        try { fillKv(m, xtText); roleOf(m); } catch (Throwable e) { }
        int stripped = xtText.toLowerCase().indexOf("dubbed") >= 0 ? 1 : 0;
        if (stripped == 1) {
            // The job asked for the plain track, so this record says nothing
            // about the original voice: keep the language already known for
            // this video instead of publishing the dub's one as the original.
            JSONObject prev = sSrcInfo;
            String prevVid = prev == null ? "" : prev.optString("videoId", "");
            String prevLang = prev == null ? "" : prev.optString("lang", "");
            if (prev != null && videoId != null && videoId.equals(prevVid)
                    && !prevLang.isEmpty()
                    && !"page".equals(prev.optString("phase", ""))) {
                m.lang = prevLang;
                m.acont = prev.optString("acont", "");
                m.role = roleOfName(prev.optString("role", ""));
            } else {
                m.lang = "";
                m.acont = "";
                m.role = ROLE_PLAIN;
            }
        }
        writeSourceInfo(SRC_RANK_JOB, videoId, client, itag, size, xt, m, stripped);
    }

    // Same record, published the moment the page posts its SABR config: the
    // track the player streams is known before any audio job exists (and even
    // when audioMode=capture, where there is no job at all). Only a hint: the
    // config is the bridge's pick, not proof of what the player renders.
    private static void publishSourceFromPage(JSONObject cfg) {
        if (cfg == null) return;
        String vid = cfg.optString("vid", "");
        String xt = cfg.optString("xtags", "");
        if (vid.isEmpty() || xt.isEmpty()) return;
        TrackMeta m = new TrackMeta();
        try { fillKv(m, xtagsText(xt)); roleOf(m); } catch (Throwable e) { }
        int stripped = xtagsText(xt).toLowerCase().indexOf("dubbed") >= 0 ? 1 : 0;
        writeSourceInfo(SRC_RANK_PAGE, vid, "page", cfg.optInt("itag", 0), 0L, xt, m, stripped);
    }

    // The track the bridge's own player response marks as default. On TV the
    // page often never sees the player response for the next video (the Cobalt
    // client keeps its own copy), so `/source` stayed empty, the overlay held
    // and translation never started. The hint is published as `phase=default`:
    // below the player's own SABR track, above the bridge's page plan.
    private static JSONObject publishBridgedDefault(JSONObject j, String videoId) {
        JSONObject res = new JSONObject();
        try {
            JSONObject sd = j.optJSONObject("streamingData");
            JSONArray fmts = sd == null ? null : sd.optJSONArray("adaptiveFormats");
            JSONObject caps = j.optJSONObject("captions");
            JSONObject rend = caps == null ? null
                    : caps.optJSONObject("playerCaptionsTracklistRenderer");
            JSONArray tracks = rend == null ? null : rend.optJSONArray("audioTracks");
            if (fmts == null || tracks == null || tracks.length() == 0) return res;
            java.util.HashMap<String, TrackMeta> map = new java.util.HashMap<>();
            for (int i = 0; i < fmts.length() && i < 200; i++) {
                JSONObject f = fmts.optJSONObject(i);
                if (f == null) continue;
                TrackMeta tm = parseTrack(f);
                if (tm.id != null && !tm.id.isEmpty() && !tm.lang.isEmpty()) map.put(tm.id, tm);
            }
            int idx = rend.optInt("defaultAudioTrackIndex", 0);
            if (idx < 0 || idx >= tracks.length()) idx = 0;
            JSONObject t = tracks.optJSONObject(idx);
            String tid = t == null ? "" : t.optString("audioTrackId", "");
            TrackMeta m = map.get(tid);
            if (m == null) {
                android.util.Log.i("VotBridge", "bridged default vid=" + videoId
                        + " id=" + tid + " unmapped=1 keys=" + map.keySet());
                return res;
            }
            JSONObject extra = new JSONObject();
            extra.put("mapped", 1);
            extra.put("trackId", tid);
            extra.put("source", "bridged-default");
            writeSourceInfo(SRC_RANK_DEFAULT, videoId, "bridged", 0, 0L, "", m, 0, extra);
            res.put("ok", 1);
            res.put("lang", m.lang);
            res.put("audioTrackId", tid);
            res.put("acont", m.acont == null ? "" : m.acont);
            res.put("role", roleName(m.role));
            android.util.Log.i("VotBridge", "bridged default vid=" + videoId + " id=" + tid
                    + " lang=" + m.lang + " acont=" + res.optString("acont"));
        } catch (Throwable e) {
            android.util.Log.w("VotBridge", "bridged default failed: " + e);
        }
        return res;
    }

    // The audio track the page's own SABR request streams: protobuf field 69 of
    // the POST body carries its id (`en-US.4`). The player never puts xtags in
    // that request, so the page maps the id back to the player response and
    // sends role/acont along (`mapped=1`).
    // mapped=0 is dropped on purpose: on TV that field is a constant
    // (`en-US.4`) that exists in no video, and the language guessed from its
    // prefix turned every Russian original into "English" and sent it to
    // translation. Unknown beats wrong here.
    private static void publishTrackInfo(JSONObject req) {
        if (req.optInt("mapped", 0) != 1) return;
        String vid = req.optString("vid", "");
        String tid = req.optString("trackId", "");
        if (vid.isEmpty() || tid.isEmpty()) return;
        String lang = req.optString("lang", "");
        if (lang.isEmpty()) return;
        TrackMeta m = new TrackMeta();
        m.id = tid;
        m.lang = langBase(lang);
        m.acont = req.optString("acont", "");
        if (req.optInt("dubbed", 0) == 1) {
            m.role = m.acont.toLowerCase().indexOf("auto") >= 0 ? ROLE_AUTODUB : ROLE_DUB;
        } else {
            roleOf(m);
            if (m.role == ROLE_PLAIN) m.role = ROLE_ORIGINAL;
        }
        int stripped = 0;   // nothing was cut here: this is what the player streams
        JSONObject o = new JSONObject();
        try {
            o.put("mapped", req.optInt("mapped", 0));
            o.put("trackId", tid);
        } catch (Throwable e) { }
        writeSourceInfo(srcRank(req.optString("phase", "track")), vid, "player",
                req.optInt("itag", 0), 0L, req.optString("xtags", ""), m, stripped, o);
    }

    // 1 — the bridge's own page config (a plan), 2 — the track the player's
    // player-response marks as default, 3 — the track the SABR request carries
    // (mapped to xtags), 4 — a finished audio job (the bytes Yandex/player
    // really got). A lower rank never overwrites a higher one for one video.
    private static final int SRC_RANK_PAGE = 1;
    private static final int SRC_RANK_DEFAULT = 2;
    private static final int SRC_RANK_TRACK = 3;
    private static final int SRC_RANK_JOB = 4;

    private static int srcRank(String phase) {
        return "job".equals(phase) ? SRC_RANK_JOB
                : "track".equals(phase) ? SRC_RANK_TRACK
                : "default".equals(phase) ? SRC_RANK_DEFAULT : SRC_RANK_PAGE;
    }

    private static String srcPhase(int rank) {
        return rank == SRC_RANK_JOB ? "job"
                : rank == SRC_RANK_TRACK ? "track"
                : rank == SRC_RANK_DEFAULT ? "default" : "page";
    }

    private static synchronized void writeSourceInfo(int rank, String videoId, String client,
                                                     int itag, long size, String xt, TrackMeta m,
                                                     int stripped) {
        writeSourceInfo(rank, videoId, client, itag, size, xt, m, stripped, null);
    }

    private static synchronized void writeSourceInfo(int rank, String videoId, String client,
                                                     int itag, long size, String xt, TrackMeta m,
                                                     int stripped, JSONObject extra) {
        try {
            JSONObject prev = sSrcInfo;
            // unknown beats wrong, в обе стороны:
            //  - запись без языка не блокирует корректный `track lang=en`
            //    (langRescue: язык важнее ранга);
            //  - безъязыкая запись не затирает уже известный язык, кроме
            //    подсказки `phase=page` (её job с вырезанным дублем и должен
            //    заменять на честный `dubStripped=1`).
            String prevPhase = prev == null ? "" : prev.optString("phase", "page");
            boolean newHasLang = m != null && m.lang != null && !m.lang.isEmpty();
            boolean prevHasLang = prev != null && !prev.optString("lang", "").isEmpty();
            boolean prevTrustedLang = prevHasLang && !"page".equals(prevPhase);
            boolean lowerRank = prev != null && rank < srcRank(prevPhase);
            boolean langRescue = !prevHasLang && newHasLang;
            boolean dropsKnownLang = prevTrustedLang && !newHasLang;
            if (prev != null && videoId != null && !videoId.isEmpty()
                    && videoId.equals(prev.optString("videoId", ""))
                    && ((lowerRank && !langRescue) || dropsKnownLang)) {
                return;   // keep the better record we already have
            }
            String phase = srcPhase(rank);
            JSONObject o = new JSONObject();
            o.put("ok", 1);
            o.put("phase", phase);
            o.put("videoId", videoId == null ? "" : videoId);
            o.put("client", client == null ? "" : client);
            o.put("itag", itag);
            o.put("size", size);
            o.put("xtags", xt == null ? "" : xt);
            o.put("acont", m.acont == null ? "" : m.acont);
            o.put("lang", m.lang == null ? "" : m.lang);
            o.put("role", roleName(m.role));
            o.put("dubStripped", stripped);
            o.put("served", stripped == 1 ? "PLAIN" : roleName(m.role));
            if (extra != null) {
                java.util.Iterator<String> it = extra.keys();
                while (it.hasNext()) {
                    String k = it.next();
                    o.put(k, extra.opt(k));
                }
            }
            o.put("at", System.currentTimeMillis());
            srcInfo(o);
            android.util.Log.i("VotBridge", "source id=" + videoId + " client=" + client
                    + " itag=" + itag + " role=" + roleName(m.role)
                    + " lang=" + (m.lang == null || m.lang.isEmpty() ? "-" : m.lang)
                    + " dubStripped=" + stripped + " phase=" + phase);
        } catch (Throwable e) {
            android.util.Log.w("VotBridge", "source info failed: " + e);
        }
    }


    private static JSONObject asrcState(String state, String videoId) {
        JSONObject o = new JSONObject();
        try {
            o.put("state", state);
            o.put("videoId", videoId);
        } catch (Throwable e) { }
        return o;
    }

    // Live view of the job for the page: which phase we are in, which part is on
    // the wire and how many bytes of the whole track are already in. Before this
    // existed the page could only see fully uploaded parts, so the bar stood at
    // 0 % for the entire first chunk (5.3 MB download + upload on this TV).
    private static void asrcProgress(String videoId, String phase, int part, int total,
                                     long bytes, long clen, int itag, String client, long ms) {
        JSONObject st = asrcState("working", videoId);
        try {
            st.put("phase", phase);
            st.put("part", part);
            st.put("chunk", Math.max(0, part - 1));
            st.put("chunks", total);
            st.put("bytes", bytes);
            st.put("total", clen);
            st.put("itag", itag);
            st.put("client", client);
            st.put("ms", ms);
        } catch (Throwable ignored) { }
        asrcSet(st);
    }

    // Throttled byte counter for a single range read: 4 updates a second is
    // enough for a progress bar and cheap enough for a weak TV CPU.
    private interface RangeProgress { void onBytes(int got); }

    private static JSONObject handleAudioSource(JSONObject req) throws Exception {
        String videoId = req.optString("videoId", "");
        String videoUrl = req.optString("videoUrl", "");
        String translationId = req.optString("translationId", "");
        if (videoId.isEmpty()) throw new IOException("missing videoId");
        if (translationId.isEmpty()) throw new IOException("missing translationId");
        if (videoUrl.isEmpty()) videoUrl = "https://www.youtube.com/watch?v=" + videoId;

        // Audio url the page captured from its own player. InnerTube from Java
        // now answers LOGIN_REQUIRED for every client on this TV, while the page
        // keeps streaming the very same track, so its url is the good one.
        final String srcUrl = req.optString("srcUrl", "");
        final int srcItag = req.optInt("srcItag", 0);
        final long srcClen = req.optLong("srcClen", 0L);
        final String srcUa = req.optString("srcUa", "");
        final String pageVd = req.optString("visitorData", "");
        final double durSec = req.optDouble("duration", 0);

        final int gen;
        final String fv = videoId;
        final String fu = videoUrl;
        final String ft = translationId;
        synchronized (ASRC_LOCK) {
            gen = ++sAsrcGen;
            JSONObject st = asrcState("working", videoId);
            st.put("chunk", 0);
            st.put("chunks", 0);
            st.put("bytes", 0L);
            st.put("total", 0L);
            asrcSet(st);
            Thread th = new Thread(new Runnable() {
                public void run() { audioSourceJob(gen, fv, fu, ft, srcUrl, srcItag, srcClen, srcUa, pageVd, durSec); }
            }, "vot-audiosrc");
            th.setDaemon(true);
            th.start();
        }
        android.util.Log.i("VotBridge", "audiosrc start id=" + videoId + " tid=" + translationId
                + " pageSrc=" + (srcUrl.isEmpty() ? 0 : 1) + " clen=" + srcClen);
        JSONObject out = new JSONObject();
        out.put("started", 1);
        out.put("videoId", videoId);
        return out;
    }

    private static void audioSourceJob(int gen, String videoId, String videoUrl, String translationId,
                                       String seedUrl, int seedItag, long seedClen, String seedUa,
                                       String pageVd, double durSec) {
        long t0 = System.currentTimeMillis();
        String lastErr = "";
        // TVHTML5 player response, kept in case every plain url is refused and
        // the audio has to come over SABR instead.
        JSONObject sabrJson = null;
        SabrPick sabrFmt = null;
        // Last signed url we managed to obtain, kept for the page relay below.
        String pageUrl = "";
        int pageItag = 0;
        long pageClen = 0;
        int pageTotal = 0;
        try {
            // 0) SABR on the page's own config — the only path that yields bytes
            // right now, and the fastest: the whole track arrives in seconds.
            // It needs exactly two things from the player: the wire url it POSTs
            // to (captured request, with alr/cpn/cver/rn/spc) and field 5 of its
            // own body. serverAbrStreamingUrl from the player response answers
            // 403, our own ustreamer config — sabr.malformed_config.
            // The wire url and field 5 belong to one player session: a pair
            // captured for another video makes the SABR server answer
            // sabr.malformed_config (31 bytes, nothing at all). The page posts
            // the fresh pair right after it starts playing, so wait a bit
            // instead of sending somebody else's config.
            if (!pageSabrUsable(videoId)) {
                long waitMs = 12000;
                long until = System.currentTimeMillis() + waitMs;
                android.util.Log.i("VotBridge", "audiosrc page-sabr wait cfgVid="
                        + pageCfgVid() + " ucfgVid=" + sSabrUcfgVid + " want=" + videoId);
                while (gen == sAsrcGen && System.currentTimeMillis() < until
                        && !pageSabrUsable(videoId)) {
                    try { Thread.sleep(250); } catch (InterruptedException ignore) { }
                }
                android.util.Log.i("VotBridge", "audiosrc page-sabr wait done ok="
                        + (pageSabrUsable(videoId) ? 1 : 0) + " cfgVid=" + pageCfgVid()
                        + " ucfgVid=" + sSabrUcfgVid + " ms="
                        + (System.currentTimeMillis() - t0));
            }
            JSONObject pcfg = sSabrCfg;
            // The page config may belong to a video the user already left; the
            // player's own captured request (url + body) is a valid second
            // source — see pageSabrUsable.
            if (pcfg != null || sSabrReq != null) {
                if (!pageSabrUsable(videoId)) {
                    lastErr = "page-sabr: no fresh player config (cfg="
                            + pageCfgVid() + " ucfg=" + sSabrUcfgVid + ")";
                    android.util.Log.e("VotBridge", "audiosrc " + lastErr);
                } else {
                    try {
                        Sabr.Params sp = sabrParamsFromCfg(0);
                        if (sp.url.isEmpty()) throw new IOException("no wire url");
                        final int fgen = gen;
                        sp.cancel = new Sabr.Cancel() {
                            public boolean cancelled() { return fgen != sAsrcGen; }
                        };
                        // The length in the page config goes stale (it kept the
                        // size of a track from another video), so it is NOT used
                        // to stop the loop: the download ends when the media
                        // covers the whole video, which the page knows as its
                        // duration, plus a byte ceiling as a hard backstop.
                        // AAC itag 140 measured ~20.5 kB/s on this TV, so the
                        // ceiling must sit above that or a full track gets cut.
                        sp.expectedLength = durSec > 1 ? (long) (durSec * 24000.0) : 0L;
                        sp.expectedEndMs = durSec > 1 ? (long) (durSec * 1000.0) : 0L;
                        sp.maxPosts = 900;   // ~10 s of audio per post
                        // Replay the player's own POST body instead of building
                        // ours: our body is answered with policy frames only
                        // (35/46/47) because the server does not consider our
                        // session the owner of the stream. The player's body
                        // carries its po_token, sabr_contexts and capabilities;
                        // dropping field 3 (buffered_ranges) is what turns it
                        // from "I already have all of it" into "give me the
                        // stream from here" — verified: 7.5 MB / 526 s of media
                        // from one run, where every other body shape gave 0.
                        byte[] tpl = capturedSabrBody(videoId);
                        if (tpl != null) {
                            // Replay the player's own body, but with our audio
                            // format in field 2 (`page-sel140` in /sabrmix).
                            // Both of the other two shapes were verified on the
                            // live capture and both fail on some videos:
                            //   - the unmodified page body selects video too
                            //     (field 22 = 137) and streamed 106 MB of itag
                            //     137 for one 668 s video;
                            //   - our own body with the page's ustreamer config
                            //     answers sabr.malformed_config as soon as that
                            //     config is the large (6 KB) per-session one.
                            // Keeping the page's field 1/16/19 (abr state,
                            // preferred audio formats, streamer context) and
                            // replacing only the selection is accepted for both
                            // sizes; the itag filter below keeps the media audio
                            // only even when the answer is mixed.
                            int audioItag = Sabr.audioItagOf(tpl);
                            if (audioItag <= 0) audioItag = 140;
                            sp.itag = audioItag;
                            // The player's pick may be the auto-dub
                            // (`acont=dubbed`); Yandex needs the original voice,
                            // so ask for the plain track of that itag.
                            sp.lmt = 0;
                            sp.xtags = "";
                            byte[] our = Sabr.requestBody(sp, 0);
                            sp.bodyTpl = Sabr.mix(tpl, our, 2);
                            sp.bodyStrip = true;
                            sp.expectedLength = 0;  // the page's clen belongs to another itag
                            android.util.Log.i("VotBridge", "audiosrc page-sabr selAudio"
                                    + " itag=" + audioItag + " body=" + sp.bodyTpl.length
                                    + " page=" + tpl.length + " our=" + our.length);
                        }
                        int it = sp.itag > 0 ? sp.itag : 140;
                        // Progress hint only: AAC 128 kbps measured ~20 kB/s.
                        long est = durSec > 1 ? (long) (durSec * 20000.0) : 0L;
                        SabrStage stage = new SabrStage(videoId, it, est, t0);
                        byte[] init = mseInitFor(videoId);
                        if (init != null) stage.init(init);
                        android.util.Log.i("VotBridge", "audiosrc page-sabr start itag=" + it
                                + " est=" + est + " dur=" + Math.round(durSec)
                                + " ustreamer=" + sp.ustreamerConfig.length()
                                + " urlLen=" + sp.url.length()
                                + " tpl=" + (sp.bodyTpl == null ? 0 : sp.bodyTpl.length)
                                + " strip=" + (sp.bodyStrip ? 1 : 0)
                                + " init=" + (init == null ? 0 : init.length)
                                + " mime=" + (sMseInitMime.isEmpty() ? "-" : sMseInitMime)
                                + " xt=" + (sp.xtags.isEmpty() ? "-" : sp.xtags)
                                + " cfgXt=" + (pcfg == null || pcfg.optString("xtags", "").isEmpty()
                                        ? "-" : pcfg.optString("xtags", ""))
                                + " src=" + (pcfg != null && videoId.equals(pcfg.optString("vid", ""))
                                        ? "page" : "req")
                                + " at=" + (System.currentTimeMillis() - t0));
                        Sabr.Result sr;
                        long size;
                        try {
                            sr = Sabr.run(sp, stage);
                        } finally {
                            size = stage.close();
                        }
                        int gotItag = sr.itag > 0 ? sr.itag : it;
                        android.util.Log.i("VotBridge", "audiosrc page-sabr " + sr.summary()
                                + " staged=" + size + " est=" + est
                                + " boxes=" + mp4Head(stage.file()));
                        // A failed run still leaves an init segment (723 B) in
                        // the file, which used to be uploaded as a "track": the
                        // page then reported success and played 0 s of audio.
                        // Anything below this is not a usable track.
                        if (size > 100000) {
                            long sent = uploadStaged(gen, videoId, videoUrl, translationId,
                                    gotItag, size, t0);
                            JSONObject ok = asrcState("done", videoId);
                            ok.put("client", "page-sabr");
                            ok.put("itag", gotItag);
                            ok.put("size", sent);
                            ok.put("total", sent);
                            ok.put("chunks", (int) Math.max(1L,
                                    (sent + AUDIO_CHUNK_SIZE - 1) / AUDIO_CHUNK_SIZE));
                            ok.put("bytes", sent);
                            ok.put("ms", System.currentTimeMillis() - t0);
                            asrcSet(ok);
                            android.util.Log.i("VotBridge", "audiosrc done bytes=" + sent
                                    + " itag=" + gotItag + " tid=" + translationId
                                    + " client=page-sabr ms="
                                    + (System.currentTimeMillis() - t0));
                            return;
                        }
                        lastErr = "page-sabr: " + sr.summary();
                        android.util.Log.e("VotBridge", "audiosrc page-sabr short: "
                                + sr.summary());
                    } catch (Throwable e) {
                        lastErr = "page-sabr: " + e;
                        android.util.Log.e("VotBridge", "audiosrc page-sabr failed: " + e);
                    }
                }
            }
            long ts = System.currentTimeMillis();
            YandexSession se = YandexClient.ensureSession();
            if (se == null) throw new IOException("no session");
            android.util.Log.i("VotBridge", "audiosrc session ms="
                    + (System.currentTimeMillis() - ts));
            long tp0 = System.currentTimeMillis();
            PoToken.Tokens t = PoToken.getWithVisitor(sAppCtx, videoId, pageVd);
            android.util.Log.i("VotBridge", "audiosrc pot ms="
                    + (System.currentTimeMillis() - tp0) + " vd=" + t.visitorData.length()
                    + " pageVd=" + pageVd.length());

            // 1) URL от страницы — первым и без InnerTube. Он уже подписан
            // клиентом, которым плеер играет прямо сейчас.
            if (!seedUrl.isEmpty() && seedClen > 0) {
                int st = (int) Math.max(1L, (seedClen + AUDIO_CHUNK_SIZE - 1) / AUDIO_CHUNK_SIZE);
                int it = seedItag > 0 ? seedItag : 140;
                pageUrl = seedUrl;
                pageItag = it;
                pageClen = seedClen;
                pageTotal = st;
                android.util.Log.i("VotBridge", "audiosrc page-src itag=" + it
                        + " clen=" + seedClen + " chunks=" + st + " ua=" + seedUa.length()
                        + " at=" + (System.currentTimeMillis() - t0));
                try {
                    sendTrack(gen, videoId, videoUrl, translationId, se,
                            seedUa.isEmpty() ? C_WEB.uaOrWeb() : seedUa,
                            seedUrl, it, seedClen, st, "page-src", t0);
                    return;
                } catch (Throwable e) {
                    lastErr = "page-src: " + e;
                    android.util.Log.e("VotBridge", "audiosrc page-src failed: " + e);
                }
            }

            for (int ci = 0; ci < AUDIO_CLIENTS.length; ci++) {
                if (gen != sAsrcGen) return; // another video took over
                Client cl = AUDIO_CLIENTS[ci];
                try {
                    long tp = System.currentTimeMillis();
                    JSONObject j = itPlayer(videoId, cl, t.visitorData, t.playerPot);
                    JSONObject f = pickAudio(j);
                    if (f == null) {
                        JSONObject ps = j.optJSONObject("playabilityStatus");
                        lastErr = cl.name + ": no audio format (status="
                                + (ps == null ? "?" : ps.optString("status", "?")) + ")";
                        if (sabrJson == null) {
                            sabrFmt = pickSabrAudio(j);
                            if (sabrFmt != null) sabrJson = j;
                        }
                        android.util.Log.i("VotBridge", "audiosrc " + lastErr);
                        continue;
                    }
                    int itag = f.optInt("itag", 0);
                    String url = f.optString("url", "");
                    long clen = f.optLong("contentLength", 0L);
                    if (clen <= 0) clen = qclen(url);
                    if (clen <= 0) {
                        lastErr = cl.name + ": no content length";
                        continue;
                    }
                    int total = (int) Math.max(1L,
                            (clen + AUDIO_CHUNK_SIZE - 1) / AUDIO_CHUNK_SIZE);
                    pageUrl = url;
                    pageItag = itag;
                    pageClen = clen;
                    pageTotal = total;
                    android.util.Log.i("VotBridge", "audiosrc " + videoId + " " + cl.name
                            + " itag=" + itag + " clen=" + clen + " chunks=" + total
                            + " playerMs=" + (System.currentTimeMillis() - tp)
                            + " at=" + (System.currentTimeMillis() - t0));
                    sendTrack(gen, videoId, videoUrl, translationId, se, cl.uaOrWeb(),
                            url, itag, clen, total, cl.name, t0);
                    return;
                } catch (Throwable e) {
                    lastErr = cl.name + ": " + e;
                    android.util.Log.e("VotBridge", "audiosrc " + cl.name + " failed: " + e);
                }
            }
            // 3) SABR. TVHTML5 is the one client the bot gate does not stop, but
            // it only serves serverAbrStreamingUrl: the bytes have to be pulled
            // frame by frame, exactly like the TV player does. Yandex still gets
            // ordinary 5.3 MB parts, so nothing changes on that side.
            if (sabrJson != null && sabrFmt != null) {
                try {
                    Sabr.Params sp = sabrParams(videoId, sabrJson, t, sabrFmt);
                    final int fgen = gen;
                    sp.cancel = new Sabr.Cancel() {
                        public boolean cancelled() { return fgen != sAsrcGen; }
                    };
                    long clen = sabrFmt.clen;
                    int total = clen <= 0 ? 0 : (int) Math.max(1L,
                            (clen + AUDIO_CHUNK_SIZE - 1) / AUDIO_CHUNK_SIZE);
                    if (total <= 0) {
                        // No contentLength in the player response: fall back to a
                        // maximum-length guestimate so parts still get numbered.
                        total = Math.max(1, (int) (60L * 1024 * 1024 / AUDIO_CHUNK_SIZE));
                        clen = (long) total * AUDIO_CHUNK_SIZE;
                    }
                    String fileId = YandexClient.buildFileId(sabrFmt.itag, String.valueOf(clen));
                    SabrUpload up = new SabrUpload(gen, videoId, videoUrl, translationId, fileId,
                            sabrFmt.itag, clen, total, t0);
                    android.util.Log.i("VotBridge", "audiosrc sabr start itag=" + sabrFmt.itag
                            + " clen=" + clen + " chunks=" + total
                            + " ustreamer=" + sp.ustreamerConfig.length()
                            + " pot=" + sp.poToken.length() + " at=" + (System.currentTimeMillis() - t0));
                    Sabr.Result sr = Sabr.run(sp, up);
                    long sent = up.finish();
                    android.util.Log.i("VotBridge", "audiosrc sabr " + sr.summary()
                            + " sent=" + sent + " parts=" + up.partsUploaded());
                    if (sent > 0 && up.partsUploaded() >= Math.min(total, 1)) {
                        JSONObject ok = asrcState("done", videoId);
                        ok.put("client", "sabr");
                        ok.put("itag", sr.itag > 0 ? sr.itag : sabrFmt.itag);
                        ok.put("size", sent);
                        ok.put("total", clen);
                        ok.put("chunks", up.partsUploaded());
                        ok.put("bytes", sent);
                        ok.put("ms", System.currentTimeMillis() - t0);
                        asrcSet(ok);
                        android.util.Log.i("VotBridge", "audiosrc done bytes=" + sent + " itag="
                                + (sr.itag > 0 ? sr.itag : sabrFmt.itag) + " tid=" + translationId
                                + " client=sabr ms=" + (System.currentTimeMillis() - t0));
                        return;
                    }
                    lastErr = "sabr: " + sr.summary();
                    android.util.Log.e("VotBridge", "audiosrc sabr short: " + sr.summary());
                } catch (Throwable e) {
                    lastErr = "sabr: " + e;
                    android.util.Log.e("VotBridge", "audiosrc sabr failed: " + e);
                }
            }
            // Nothing downloadable from the bridge. Hand the url to the page: its
            // network stack is the same one the player streams with, so it is
            // accepted where Java is not. The page pulls one part at a time and
            // posts it back to /audiosrc/raw, which does the Yandex upload here.
            if (!pageUrl.isEmpty() && pageTotal > 0) {
                synchronized (ASRC_LOCK) {
                    sPageUrl = pageUrl;
                    sPageFileId = YandexClient.buildFileId(pageItag, String.valueOf(pageClen));
                    sPageVideoUrl = videoUrl;
                    sPageTid = translationId;
                    sPageItag = pageItag;
                    sPageClen = pageClen;
                    sPageTotal = pageTotal;
                    sPageSent = 0L;
                    sPageLastPart = -1;
                    sPageGen = gen;
                }
                JSONObject st = asrcState("need_page", videoId);
                st.put("phase", "page");
                st.put("url", pageUrl);
                st.put("itag", pageItag);
                st.put("clen", pageClen);
                st.put("total", pageClen);
                st.put("chunks", pageTotal);
                st.put("chunk", 0);
                st.put("bytes", 0L);
                st.put("part", 0);
                st.put("err", lastErr);
                st.put("ms", System.currentTimeMillis() - t0);
                asrcSet(st);
                android.util.Log.i("VotBridge", "audiosrc need_page itag=" + pageItag
                        + " clen=" + pageClen + " chunks=" + pageTotal + " why=" + lastErr);
                return;
            }
            JSONObject err = asrcState("error", videoId);
            err.put("err", lastErr);
            err.put("ms", System.currentTimeMillis() - t0);
            asrcSet(err);
            android.util.Log.e("VotBridge", "audiosrc failed: " + lastErr);
        } catch (Throwable e) {
            JSONObject err = asrcState("error", videoId);
            try {
                err.put("err", String.valueOf(e));
                err.put("ms", System.currentTimeMillis() - t0);
            } catch (Throwable ignored) { }
            asrcSet(err);
            android.util.Log.e("VotBridge", "audiosrc job failed: " + e);
        }
    }

    // Downloads the whole track window-by-window from one signed url and pushes
    // each window straight into the Yandex cache. Shared by the page-supplied
    // url and the InnerTube clients, so both paths upload identically.
    private static void sendTrack(int gen, String videoId, String videoUrl, String translationId,
                                  YandexSession se, String ua, String url, int itag, long clen,
                                  int total, String who, long t0) throws Exception {
        String fileId = YandexClient.buildFileId(itag, String.valueOf(clen));
        long sent = 0;
        for (int i = 0; i < total; i++) {
            if (gen != sAsrcGen) return;
            long from = (long) i * AUDIO_CHUNK_SIZE;
            long to = Math.min(clen, from + AUDIO_CHUNK_SIZE) - 1;
            final long baseSent = sent;
            final int partNo = i;
            byte[] chunk = rangeGet(url, ua, from, to, new RangeProgress() {
                public void onBytes(int got) {
                    asrcProgress(videoId, "download", partNo + 1, total,
                            baseSent + got, clen, itag, who, System.currentTimeMillis() - t0);
                }
            });
            // A final part carries the number of parts, the ones in the middle
            // carry 0 — exactly what the real client sends.
            int parts = total <= 1 ? 0 : (i == total - 1 ? total : 0);
            asrcProgress(videoId, "upload", i + 1, total, sent, clen, itag, who,
                    System.currentTimeMillis() - t0);
            if (total <= 1) {
                YandexClient.uploadSingleAudio(se, videoUrl, translationId, fileId, chunk);
            } else {
                YandexClient.uploadChunkAudio(se, videoUrl, translationId, fileId, i, parts, chunk);
            }
            sent += chunk.length;
            android.util.Log.i("VotBridge", "audiosrc chunk " + (i + 1) + "/" + total
                    + " bytes=" + chunk.length + " sent=" + sent
                    + " at=" + (System.currentTimeMillis() - t0));
            asrcProgress(videoId, "download", i + 1, total, sent, clen, itag, who,
                    System.currentTimeMillis() - t0);
        }
        JSONObject ok = asrcState("done", videoId);
        ok.put("client", who);
        ok.put("itag", itag);
        ok.put("size", sent);
        ok.put("total", clen);
        ok.put("chunks", total);
        ok.put("bytes", sent);
        ok.put("ms", System.currentTimeMillis() - t0);
        asrcSet(ok);
        android.util.Log.i("VotBridge", "audiosrc done bytes=" + sent + " itag=" + itag
                + " tid=" + translationId + " client=" + who + " ms="
                + (System.currentTimeMillis() - t0));
    }

    // ---- /audiosrc/raw?part=i: page-relayed part --------------------------
    // The page fetched one part with its own XHR (because googlevideo rejected
    // the bridge) and posts the bytes here; the Yandex upload stays in Java.
    private static JSONObject handleAudioRaw(int part, byte[] data) throws Exception {
        String videoUrl;
        String tid;
        String fileId;
        int itag;
        long clen;
        int total;
        int gen;
        synchronized (ASRC_LOCK) {
            if (sPageUrl.isEmpty() || sPageTotal <= 0) throw new IOException("no page relay active");
            videoUrl = sPageVideoUrl;
            tid = sPageTid;
            fileId = sPageFileId;
            itag = sPageItag;
            clen = sPageClen;
            total = sPageTotal;
            gen = sPageGen;
        }
        // The page may still be flushing parts of the previous video while a new
        // one is already staged: those bytes belong to another translationId and
        // fileId, so uploading them would silently corrupt the wrong track.
        if (gen != sAsrcGen) throw new IOException("stale page gen " + gen + "/" + sAsrcGen);
        if (part < 0 || part >= total) throw new IOException("bad part " + part + "/" + total);
        if (data == null || data.length == 0) throw new IOException("empty part " + part);

        YandexSession se = YandexClient.ensureSession();
        if (se == null) throw new IOException("no session");
        int parts = total <= 1 ? 0 : (part == total - 1 ? total : 0);
        if (total <= 1) {
            YandexClient.uploadSingleAudio(se, videoUrl, tid, fileId, data);
        } else {
            YandexClient.uploadChunkAudio(se, videoUrl, tid, fileId, part, parts, data);
        }
        long sent;
        synchronized (ASRC_LOCK) {
            sent = sPageSent + data.length;
            sPageSent = sent;
            sPageLastPart = part;
        }
        boolean last = part == total - 1;
        JSONObject st = asrcState(last ? "done" : "working", videoIdOfPage());
        if (last) {
            st.put("client", "page");
            st.put("itag", itag);
            st.put("size", sent);
            st.put("total", clen);
            st.put("chunks", total);
            st.put("part", total);
            st.put("chunk", total);
            st.put("bytes", sent);
            asrcSet(st);
            android.util.Log.i("VotBridge", "audiosrc page done bytes=" + sent + " itag=" + itag
                    + " tid=" + tid + " gen=" + gen);
        } else {
            st.put("phase", "download");
            st.put("part", part + 1);
            st.put("chunk", part + 1);
            st.put("chunks", total);
            st.put("bytes", sent);
            st.put("total", clen);
            st.put("itag", itag);
            st.put("client", "page");
            asrcSet(st);
            android.util.Log.i("VotBridge", "audiosrc page part " + (part + 1) + "/" + total
                    + " bytes=" + data.length + " sent=" + sent);
        }
        JSONObject out = new JSONObject();
        out.put("ok", 1);
        out.put("part", part);
        out.put("sent", sent);
        out.put("last", last ? 1 : 0);
        return out;
    }

    private static String videoIdOfPage() {
        try {
            return sAsrcState.optString("videoId", "");
        } catch (Throwable e) {
            return "";
        }
    }

    // The non-WEB clients need no token at all, so the bare url goes first; the
    // "&pot=" variant is only a second chance for a client that does want it.
    private static byte[] rangeGetAny(String url, Client cl, PoToken.Tokens t, long from, long to,
                                      RangeProgress p) throws IOException {
        String withPot = withPotParam(url, t == null ? "" : t.playerPot);
        IOException err = null;
        String[] cands = withPot.equals(url) ? new String[]{url} : new String[]{url, withPot};
        for (int i = 0; i < cands.length; i++) {
            try {
                return rangeGet(cands[i], cl.uaOrWeb(), from, to, p);
            } catch (IOException e) {
                err = e;
            }
        }
        throw err == null ? new IOException("range failed") : err;
    }

    // Exact byte window from googlevideo, retried: a truncated read means the
    // connection died mid-chunk, 416 means the window is past the end.
    private static byte[] rangeGet(String url, String ua, long from, long to, RangeProgress p)
            throws IOException {
        int want = (int) (to - from + 1);
        IOException last = null;
        for (int attempt = 0; attempt < 3; attempt++) {
            HttpURLConnection c = null;
            try {
                c = (HttpURLConnection) new URL(url).openConnection();
                c.setConnectTimeout(10000);
                c.setReadTimeout(30000);
                c.setRequestProperty("User-Agent", ua);
                c.setRequestProperty("Accept", "*/*");
                c.setRequestProperty("Range", "bytes=" + from + "-" + to);
                int code = c.getResponseCode();
                if (code == 416) throw new IOException("range 416 at " + from);
                if (code != 206 && code != 200) {
                    throw new IOException("http " + code + " " + errBodySnippet(c));
                }
                if (code == 200 && from > 0) {
                    throw new IOException("range ignored (200) at " + from);
                }
                byte[] buf = new byte[want];
                InputStream in = c.getInputStream();
                int off = 0;
                int repBytes = -1;
                long repMs = 0L;
                while (off < want) {
                    int r = in.read(buf, off, want - off);
                    if (r <= 0) break;
                    off += r;
                    if (p != null) {
                        long nowMs = System.currentTimeMillis();
                        if (repBytes < 0 || off - repBytes >= 262144 || nowMs - repMs >= 250L) {
                            repBytes = off;
                            repMs = nowMs;
                            try { p.onBytes(off); } catch (Throwable ignored) { }
                        }
                    }
                }
                try { in.close(); } catch (Throwable ignored) { }
                if (off == want) return buf;
                throw new IOException("short read " + off + "/" + want);
            } catch (IOException e) {
                last = e;
                android.util.Log.i("VotBridge", "range " + from + "-" + to + " try "
                        + (attempt + 1) + ": " + e.getMessage());
                // 403 is not transient: the url is bound to another client/UA, a
                // retry just burns 12 s of the ladder — let the next client try.
                if (String.valueOf(e.getMessage()).startsWith("http 403")) break;
                try {
                    Thread.sleep(300L * (attempt + 1));
                } catch (InterruptedException ie) {
                    Thread.currentThread().interrupt();
                }
            } finally {
                if (c != null) try { c.disconnect(); } catch (Throwable e) { }
            }
        }
        throw last == null ? new IOException("range failed") : last;
    }


    // Port of dev_server/yt_lang.py: original language in ~0.5 s without the PC.
    private static String metaLocal(String videoId, String pageVd, boolean retry, boolean basic) {
        if (!retry) synchronized (META_CACHE) {
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
            // Без po-токена InnerTube отвечает LOGIN_REQUIRED «Sign in to
            // confirm you're not a bot» почти на каждом ролике, поэтому язык из
            // собственного запроса моста не определялся. Аудио-задача токен
            // минтит (pot=1), здесь его не было (pot=0).
            // visitorData страницы (если JS его прислал) лучше собственного:
            // гейт привязан к visitor id, а страница этим же id спокойно
            // стримит видео. Свой свежий visitor Яндекс быстро помечает ботом.
            PoToken.Tokens pt = null;
            String haveVd = (pageVd == null) ? "" : pageVd;
            try { pt = PoToken.getWithVisitor(sAppCtx, videoId, haveVd); } catch (Throwable ignore) { }
            if (!haveVd.isEmpty()) {
                android.util.Log.i("VotBridge", "meta vd page=" + haveVd.length());
            }
            String pvd = pt == null ? null : pt.visitorData;
            String ppo = pt == null ? null : pt.playerPot;
            // Перебираем клиентов, пока хоть один не даст язык. Ответ с
            // LOGIN_REQUIRED тоже годится: videoDetails/captions в нём бывают,
            // а играть этим ответом не нужно — нужна только мета. Раньше
            // первый «OK» обрывал поиск, и ролик без audioTracks уходил в hold,
            // хотя у другого клиента язык был.
            // Больше клиентов = больше шансов, что хоть один отдаст мету:
            // у части роликов WEB/TV упираются в бот-гейт или не содержат
            // captions, а ANDROID/IOS/embedded их отдают. Порядок: сначала
            // мобильные (реже гейтятся и обычно отдают audioTrack/captions),
            // WEB/VR/TV — как раньше в конце.
            Client[] clients = basic
                    ? new Client[]{C_ANDROID, C_IOS}
                    : new Client[]{C_ANDROID, C_IOS, C_TV_EMB,
                    C_WEB, C_VR, C_TV};
            String used = "";
            String lastStatus = "";
            String lastReason = "";
            int gate = 0;
            JSONObject j = null;
            JSONObject meta = null;
            String lang = "";
            for (int i = 0; i < clients.length; i++) {
                used = clients[i].name;
                j = itPlayer(videoId, clients[i], pvd, ppo);
                String st = playability(j);
                String rs = playReason(j);
                JSONObject probe = new JSONObject();
                String got = fillLang(j, probe);
                // Диагностика: какой клиент что отдал (без самих форматов).
                android.util.Log.i("VotBridge", "meta probe " + videoId + " " + clients[i].name
                        + " st=" + st + " lang=" + got
                        + (got.isEmpty() ? "" : "/" + probe.optString("langFrom", ""))
                        + " atid=" + probe.optString("audioTrackId", "")
                        + " tracks=" + probe.optJSONArray("audioTracks")
                        + " caps=" + probe.optJSONArray("captionLangs")
                        + (rs.isEmpty() ? "" : " why=" + rs));
                // Статусы по именам клиентов, а не по индексу: порядок перебора
                // теперь не совпадает с «web/vr/tv».
                out.put(clients[i].name.toLowerCase() + "Status", st);
                lastStatus = st;
                lastReason = rs;
                // Бот-гейт отвечает одинаково всем клиентам: три первых отказа
                // подряд означают, что остальные три тоже не помогут, а каждый
                // лишний заход только продлевает пометку visitor'а.
                if ("LOGIN_REQUIRED".equals(st)) {
                    if (++gate >= 3) break;
                } else {
                    gate = 0;
                }
                if (got.isEmpty()) continue;
                meta = probe;
                lang = got;
                break;
            }
            out.put("client", used);
            out.put("videoId", videoId);
            out.put("login", sCookieLoggedIn ? 1 : 0);
            if (lang.isEmpty()) {
                out.put("ok", false);
                out.put("err", ("no confirmed selected audio language (" + lastStatus + ")").trim());
                // Причина от Яндекса отличает «подтвердите, что вы не бот»
                // (гейт по частоте — проходит сам) от «нужен вход» (возраст/
                // регион): во втором случае HOLD навсегда, и это честно.
                if (!lastReason.isEmpty()) out.put("why", lastReason);
            } else {
                if (meta != null) {
                    java.util.Iterator<String> it = meta.keys();
                    while (it.hasNext()) {
                        String k = it.next();
                        out.put(k, meta.opt(k));
                    }
                }
                // Публикуем «дорожку по умолчанию» из собственного ответа моста:
                // на ТВ страница часто не видит player-ответ следующего ролика,
                // и без этого /source остаётся пустым (оверлей держит hold).
                // Публикуем только по играбельному ответу: в LOGIN_REQUIRED
                // форматов нет.
                if ("OK".equals(lastStatus)) {
                    JSONObject bd = publishBridgedDefault(j, videoId);
                    if (bd.optInt("ok", 0) == 1) out.put("bridged", bd);
                }
                ok = true;
                out.put("ok", true);
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
                + (ok ? "lang=" + out.optString("lang") + " from=" + out.optString("langFrom", "audio")
                : "err=" + out.optString("err"))
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

    // ASR caption language: detected from the audio track, so it is a valid hint
    // for the original language. Manual captions are authored and may be
    // translated, so they are not used (unknown beats wrong).
    private static String[] captionLangHint(JSONObject rend) {
        if (rend == null) return null;
        JSONArray ct = rend.optJSONArray("captionTracks");
        if (ct == null) return null;
        for (int i = 0; i < ct.length() && i < 40; i++) {
            JSONObject t = ct.optJSONObject(i);
            if (t == null) continue;
            String vss = t.optString("vssId", "");
            boolean asr = "asr".equalsIgnoreCase(t.optString("kind", "")) || vss.startsWith("a-");
            if (!asr) continue;
            String code = langBase(t.optString("languageCode", ""));
            if (code.isEmpty() || "und".equals(code)) continue;
            return new String[]{code, "captions-asr"};
        }
        return null;
    }

    // audioTrack.id в adaptiveFormats — тег дорожки вида "en-US.4" (язык-регион.
    // роль). Он объявлен самим player-ответом, поэтому годится как подсказка для
    // роликов с единственной дорожкой: у них массива audioTracks в captions нет,
    // ASR-субтитров может не быть, и раньше такие уходили в hold с unknown.
    private static String[] audioFormatLang(JSONObject j) throws Exception {
        JSONObject sd = j.optJSONObject("streamingData");
        JSONArray fmts = sd == null ? null : sd.optJSONArray("adaptiveFormats");
        if (fmts == null) return null;
        String first = "";
        for (int i = 0; i < fmts.length() && i < 200; i++) {
            JSONObject f = fmts.optJSONObject(i);
            JSONObject at = f == null ? null : f.optJSONObject("audioTrack");
            if (at == null) continue;
            // `audioIsDefault` у TV-плеера часто стоит на автодубле (ru), а не
            // на оригинале: ролик с английским оригиналом уходил в «русский» и
            // перевод молча пропускался. Дубль не может быть языком оригинала.
            TrackMeta tm = parseTrack(f);
            if (tm.role == ROLE_DUB || tm.role == ROLE_AUTODUB) continue;
            String id = at.optString("id", "").toLowerCase();
            int cut = id.length();
            int p = id.indexOf('.');
            if (p > 0) cut = p;
            p = id.indexOf('-');
            if (p > 0 && p < cut) cut = p;
            String code = id.substring(0, cut).trim();
            if (code.length() < 2 || code.length() > 3) continue;
            boolean letters = true;
            for (int k = 0; k < code.length(); k++) {
                char c = code.charAt(k);
                if (c < 'a' || c > 'z') { letters = false; break; }
            }
            if (!letters) continue;
            if ("und".equals(code) || "mis".equals(code) || "zxx".equals(code)) continue;
            if (at.optBoolean("audioIsDefault", false)) return new String[]{code, "audioTrack"};
            if (first.isEmpty()) first = code;
        }
        return first.isEmpty() ? null : new String[]{first, "audioTrack"};
    }

    // defaultAudioTrackIndex — диагностическая подсказка, не выбранная дорожка.
    // Ни этот индекс, ни субтитры не подтверждают язык звучащего звука.
    // Язык ОРИГИНАЛЬНОЙ дорожки из самих аудиоформатов (role ORIGINAL по
    // xtags/audioTrack). Если в ответе только дубли — возвращаем null и
    // помечаем out.dubOnly=1: defaultAudioLanguage в этом случае описывает
    // дубль, а не оригинал, и решать по нему «ролик на моём языке» нельзя.
    private static String[] originalFormatLang(JSONObject j, JSONObject out) {
        String[] arrays = new String[]{"adaptiveFormats", "formats"};
        JSONObject sd = j.optJSONObject("streamingData");
        boolean dub = false;
        String lang = "";
        String id = "";
        for (int a = 0; a < arrays.length; a++) {
            // In a player response the tracks live under `streamingData`; the
            // top-level arrays are only a fallback for already-unwrapped JSON.
            JSONArray arr = j.optJSONArray(arrays[a]);
            if (arr == null && sd != null) arr = sd.optJSONArray(arrays[a]);
            if (arr == null) continue;
            // Форматов бывает >100 (оригинал + десятки автодублей), и
            // оригинальная дорожка часто лежит далеко за первыми 80.
            for (int i = 0; i < arr.length() && i < 200; i++) {
                JSONObject f = arr.optJSONObject(i);
                if (f == null) continue;
                if (f.optString("mimeType", "").indexOf("audio") < 0) continue;
                if (f.optJSONObject("audioTrack") == null && f.optString("xtags", "").isEmpty()) continue;
                TrackMeta m = parseTrack(f);
                if (m.lang.isEmpty()) continue;
                // PLAIN — дорожка без пометки роли: в player-ответе это и есть
                // основная/оригинальная. Дубли всегда несут `acont=dubbed*`.
                if (m.role == ROLE_ORIGINAL || m.role == ROLE_PLAIN) {
                    if (lang.isEmpty()) { lang = m.lang; id = m.id; }
                } else if (m.role == ROLE_DUB || m.role == ROLE_AUTODUB) {
                    dub = true;
                }
            }
            if (!lang.isEmpty()) break;
        }
        if (!lang.isEmpty()) {
            if (out != null) {
                try { out.put("origTrackId", id); } catch (Throwable ignored) { }
            }
            return new String[]{lang, "xtags-original"};
        }
        if (dub && out != null) {
            try { out.put("dubOnly", 1); } catch (Throwable ignored) { }
        }
        return null;
    }

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
        // Сохраняем default track лишь для диагностики. Язык звука не известен
        // даже при одном объявленном треке без подтверждения фактического выбора.
        // Exception: a video with no audioTrack at all (InnerTube returns
        // `audioTracks:[""]`). Then the language comes from ASR captions: it is
        // recognized from the audio itself. That is a meta_local hint (MEDIUM in
        // TrackDecision), not proof of the track role.
        String lang = "";
        String langFrom = "";
        boolean dubOnly = false;
        // Сначала роль дорожки из самих форматов: explicit ORIGINAL или PLAIN.
        // Это прямой ответ player-ответа, а ASR-субтитры распознаются из ТОГО
        // звука, который играет плеер, — у автодублированных роликов они на
        // языке дубля (ar) и не должны перебивать оригинал (en).
        String[] ol = originalFormatLang(j, out);
        if (ol != null) {
            lang = ol[0];
            langFrom = ol[1];
        } else {
            dubOnly = out.optInt("dubOnly", 0) == 1;
            if (!dubOnly) {
                String[] hint = captionLangHint(rend);
                if (hint != null) {
                    lang = hint[0];
                    langFrom = hint[1];
                }
            }
        }
        // Последний шанс для роликов с единственной дорожкой: у них массива
        // audioTracks нет вовсе, и раньше такие уходили в hold. Поле
        // defaultAudioLanguage объявляет сам player-ответ (это не догадка по
        // названию ролика), поэтому принимаем его как подсказку MEDIUM.
        // Но если в ответе есть только дубли — это язык дубля, не оригинала.
        if (lang.isEmpty() && !dubOnly) {
            JSONObject vd0 = j.optJSONObject("videoDetails");
            String dal = vd0 == null ? "" : langBase(vd0.optString("defaultAudioLanguage", ""));
            if (!dal.isEmpty() && !"und".equals(dal)) {
                lang = dal;
                langFrom = "defaultLanguage";
            }
        }
        if (lang.isEmpty()) {
            String[] at = audioFormatLang(j);
            if (at != null) {
                lang = at[0];
                langFrom = at[1];
            }
        }
        out.put("lang", lang);
        if (!langFrom.isEmpty()) out.put("langFrom", langFrom);
        out.put("audioTrackId", atid);
        out.put("audioIndex", idx);
        out.put("audioTracks", ids);
        JSONArray capLangs = new JSONArray();
        if (rend != null) {
            JSONArray ct = rend.optJSONArray("captionTracks");
            int nct = ct == null ? 0 : ct.length();
            for (int i = 0; i < nct && i < 6; i++) {
                JSONObject t = ct.optJSONObject(i);
                if (t == null) continue;
                capLangs.put(t.optString("languageCode", "") + ":"
                        + (t.optString("kind", "").isEmpty() ? "manual" : t.optString("kind", "")));
            }
        }
        out.put("captionLangs", capLangs);
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
            // Короткие пути логируем целиком, но длинные параметры (visitorData
            // бывает по 400+ символов) только обрезаем — иначе logcat пухнет.
            String logPath = path.length() > 120 ? (path.substring(0, 120) + "…") : path;
            android.util.Log.i("VotBridge", "req " + method + " " + logPath);

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
            // 12 MB: the page relays one 5.3 MB audio part at a time to
            // /audiosrc/raw, and the old 4 MB cap silently dropped the body,
            // which surfaced as "empty part 0".
            if (contentLength > 0 && contentLength < (12 * 1024 * 1024)) {
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
                } else if (path.startsWith("/audiosrc/status")) {
                    resp = audioSourceStatus().toString();
                } else if (path.startsWith("/mseinit")) {
                    resp = handleMseInit(body, queryParam(path, "vid"),
                            queryParam(path, "mime")).toString();
                } else if (path.startsWith("/audiosrc/raw")) {
                    int part = -1;
                    try {
                        part = Integer.parseInt(queryParam(path, "part"));
                    } catch (Throwable ignore) { }
                    resp = handleAudioRaw(part, body).toString();
                } else if (path.startsWith("/audiosrc")) {
                    JSONObject req = body.length > 0 ? new JSONObject(new String(body, StandardCharsets.UTF_8)) : new JSONObject();
                    resp = handleAudioSource(req).toString();
                } else if (path.startsWith("/sabrreq")) {
                    resp = handleSabrReq(body).toString();
                } else if (path.startsWith("/sabrmix")) {
                    int it = 0;
                    try {
                        it = Integer.parseInt(queryParam(path, "itag"));
                    } catch (Throwable ignore) { }
                    resp = handleSabrMix(it).toString();
                } else if (path.startsWith("/sabrbody")) {
                    int it = 0;
                    try {
                        it = Integer.parseInt(queryParam(path, "itag"));
                    } catch (Throwable ignore) { }
                    resp = handleSabrBody(it).toString();
                } else if (path.startsWith("/sabrreplay")) {
                    int it = 0;
                    try {
                        it = Integer.parseInt(queryParam(path, "itag"));
                    } catch (Throwable ignore) { }
                    resp = handleSabrReplay(queryParam(path, "mode"), queryParam(path, "videoId"),
                            it, queryParam(path, "visitorData")).toString();
                } else if (path.startsWith("/sabrcfg")) {
                    resp = handleSabrCfg(body).toString();
                } else if (path.startsWith("/track")) {
                    // Что плеер реально стримит (audioTrackId из его SABR-запроса).
                    if (body.length == 0) throw new IOException("empty body");
                    publishTrackInfo(new JSONObject(new String(body, StandardCharsets.UTF_8)));
                    resp = "{\"ok\":1}";
                } else if (path.startsWith("/sabrdiag")) {
                    int it = 0;
                    try {
                        it = Integer.parseInt(queryParam(path, "itag"));
                    } catch (Throwable ignore) { }
                    resp = handleSabrDiag(it).toString();
                } else if (path.startsWith("/sabrfile")) {
                    long from = 0;
                    int max = 4194304;
                    try { from = Long.parseLong(queryParam(path, "from")); } catch (Throwable ignore) { }
                    try {
                        String mv = queryParam(path, "max");
                        if (!mv.isEmpty()) max = Integer.parseInt(mv);
                    } catch (Throwable ignore) { }
                    resp = handleSabrFile(from, max).toString();
                } else if (path.startsWith("/sabrtest")) {
                    String vid = queryParam(path, "videoId");
                    int it = 0;
                    try {
                        it = Integer.parseInt(queryParam(path, "itag"));
                    } catch (Throwable ignore) { }
                    if (!queryParam(path, "page").isEmpty()) {
                        resp = handleSabrTestPage(it, queryParam(path, "xtags"),
                                (int) longOf(queryParam(path, "raw"))).toString();
                    } else if (!queryParam(path, "wire").isEmpty()) {
                        resp = handleSabrTestWire(it).toString();
                    } else {
                        if (vid.isEmpty()) throw new IOException("missing videoId");
                        resp = handleSabrTest(vid, it, queryParam(path, "visitorData")).toString();
                    }
                } else if (path.startsWith("/audiotest")) {
                    String vid = queryParam(path, "videoId");
                    if (vid.isEmpty()) throw new IOException("missing videoId");
                    resp = "1".equals(queryParam(path, "all"))
                            ? handleAudioTestAll(vid).toString()
                            : handleAudioTest(vid, queryParam(path, "client")).toString();
                } else if (path.startsWith("/potest")) {
                    String vid = queryParam(path, "videoId");
                    if (vid.isEmpty()) throw new IOException("missing videoId");
                    resp = handlePotest(vid).toString();
                } else if (path.startsWith("/audio")) {
                    JSONObject req = body.length > 0 ? new JSONObject(new String(body, StandardCharsets.UTF_8)) : new JSONObject();
                    resp = handleAudio(req).toString();
                } else if (path.startsWith("/fill_status") || path.startsWith("/fill")) {
                    // The LAN filler is gone: the box fetches the track itself.
                    code = 410;
                    resp = "{\"state\":\"none\",\"res\":{},\"err\":\"no pc\"}";
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
                    Client urlClient = clientByName(queryParam(path, "client"));
                    resp = handleYtUrl(vid, urlClient == null ? C_VR : urlClient,
                            "1".equals(queryParam(path, "pot"))).toString();
                } else if (path.startsWith("/source")) {
                    JSONObject si = sSrcInfo;
                    String vid = queryParam(path, "videoId");
                    if (si == null) {
                        resp = "{\"ok\":0,\"why\":\"no audio job yet\"}";
                    } else if (!vid.isEmpty() && !vid.equals(si.optString("videoId", ""))) {
                        resp = "{\"ok\":0,\"why\":\"other video\"}";
                    } else {
                        resp = si.toString();
                    }
                } else if (path.startsWith("/meta_local")) {
                    String vid = queryParam(path, "videoId");
                    if (vid.isEmpty()) throw new IOException("missing videoId");
                    resp = metaLocal(vid, queryParam(path, "visitorData"),
                            "1".equals(queryParam(path, "retry")),
                            "1".equals(queryParam(path, "basic")));
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
        o.put("aac", sAac);
        // Диагностический/сервисный рычаг: язык, который не переводим. Пусто —
        // страница оставляет своё значение из настроек.
        o.put("skipLang", sSkipLang == null ? "" : sSkipLang);
        o.put("dubPick", sDubPick == null ? "" : sDubPick);
        // Видеокодек AV1: на этом боксе аппаратный декодер не отдаёт кадры
        // (чёрный экран), поэтому страница по умолчанию av01 отклоняет.
        // true — вернуть выбор кодека плееру (для проверок).
        o.put("av1", sAv1);
        // Предпочтение видеокодека: "auto" (как выбирает плеер) или "avc"
        // (только H.264 — обход чёрного экрана на этом боксе).
        o.put("vcodec", sVcodec == null ? "avc" : sVcodec);
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
            if (req.has("aac")) sAac = req.optBoolean("aac", false);
            if (req.has("skipLang")) sSkipLang = req.optString("skipLang", "");
            if (req.has("dubPick")) sDubPick = req.optString("dubPick", "");
            if (req.has("av1")) sAv1 = req.optBoolean("av1", false);
            if (req.has("vcodec")) sVcodec = req.optString("vcodec", "avc");
            // Осознанная настройка из UI: помечаем версией, чтобы следующий
            // старт принял её (а не отбросил как legacy), и кладём на диск.
            try {
                JSONObject keep = new JSONObject(configJson().toString());
                keep.remove("hasToken");
                // Токен живёт только в памяти/кэше и отдаётся наружу лишь как
                // флаг hasToken — в файл его кладём, иначе lively умрёт после
                // перезапуска.
                if (sOauthToken != null && !sOauthToken.isEmpty()) keep.put("token", sOauthToken);
                keep.put("v", 2);
                sLastConfig = keep.toString();
                saveConfigCache(sLastConfig);
            } catch (Throwable e) {
                android.util.Log.w("VotBridge", "config cache save failed: " + e);
            }
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
            if (r <= 0) break;
            off += r;
        }
        // Truncate: the caller must see the real length, otherwise a 31-byte
        // error frame looks like `n` bytes of zeros and the part parser drowns
        // in fake type-0 parts.
        return off == n ? b : java.util.Arrays.copyOf(b, off);
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

        // chunk: {1: translationId, 2: videoUrl, 4: {1:{1:idx,2:data}, 2:audioPartsLength, 3:fileId, 4:1}}
        // audioPartsLength is 0 for every part in the middle and equals the
        // total part count on the last one — that is what the real client sends
        // (Vox fork: VotAudioUploader), and the TV run confirmed it is accepted.
        static byte[] encodeChunkAudioRequest(String videoUrl, String translationId, String fileId,
                                              int chunkIndex, int audioPartsLength, byte[] data) throws IOException {
            ByteArrayOutputStream b = new ByteArrayOutputStream();
            writeString(b, 1, translationId);
            writeString(b, 2, videoUrl);
            ByteArrayOutputStream part = new ByteArrayOutputStream();
            writeInt(part, 1, chunkIndex);
            writeBytes(part, 2, data);
            ByteArrayOutputStream wrap = new ByteArrayOutputStream();
            writeMessage(wrap, 1, part.toByteArray());
            writeInt(wrap, 2, audioPartsLength);
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
                                     String fileId, int chunkIndex, int audioPartsLength, byte[] data) throws Exception {
            byte[] body = encodeChunkAudioRequest(videoUrl, translationId, fileId, chunkIndex, audioPartsLength, data);
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
                uploadChunkAudio(se, videoUrl, translationId, fileId, i,
                        i == total - 1 ? total : 0, chunk);
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
