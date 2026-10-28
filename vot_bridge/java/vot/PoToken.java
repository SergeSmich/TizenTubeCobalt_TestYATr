package vot;

import android.content.Context;
import android.os.Handler;
import android.os.Looper;
import android.util.Base64;
import android.webkit.ConsoleMessage;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

/**
 * Port of SmartTube's "potokennp2" poToken generator (PoTokenWebView.kt +
 * JavaScriptUtil.kt + VisitorApi.kt) into plain Java, so the Cobalt process can
 * mint YouTube "poTokens" itself and therefore download googlevideo audio.
 *
 * Why: without a poToken googlevideo answers 403 on any UA (verified for IOS /
 * ANDROID_VR / WEB from both the PC and the TV). With pot the fork downloads
 * itag=251 fine, which is what enables the Yandex VOT audio upload at all.
 *
 * The WebView is only used as a JS sandbox for BotGuard: network is blocked in
 * it (blockNetworkLoads) and every HTTP call is done from Java.
 */
public final class PoToken {

    private static final String TAG = "VotBridge";
    // Asset injected into the APK by build_bridge.ps1 (copy of SmartTube's
    // potokennp2/po_token.html).
    private static final String HTML_ASSET = "po_token.html";

    private static final String BG_BASE = "https://www.youtube.com/api/jnn/v1/";
    // Public BotGuard request key (same value SmartTube uses).
    private static final String REQUEST_KEY = "O43z0dpjhgX20SCx4KAo";
    private static final String GOOGLE_API_KEY = "AIzaSyDyT5W0Jh49F30Pqqtyfdf7pDLFKLJoAnw";
    // BotGuard checks this UA shape; keep it identical to SmartTube.
    private static final String BG_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
            + "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.3";
    private static final String API_KEY = "AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8";
    private static final String VISITOR_VERSION = "2.20250213.05.00";
    private static final String VISITOR_UA =
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:128.0) Gecko/20100101 Firefox/128.0";

    /** playerPot goes to serviceIntegrityDimensions, streamingPot to the URL. */
    public static final class Tokens {
        public final String visitorData;
        public final String playerPot;
        public final String streamingPot;

        Tokens(String visitorData, String playerPot, String streamingPot) {
            this.visitorData = visitorData == null ? "" : visitorData;
            this.playerPot = playerPot == null ? "" : playerPot;
            this.streamingPot = streamingPot == null ? "" : streamingPot;
        }

        /** "&pot=..." suffix for a googlevideo URL ("" when unavailable). */
        public String urlSuffix() {
            if (streamingPot.isEmpty()) return "";
            return "&pot=" + urlEnc(streamingPot);
        }
    }

    private static final Object LOCK = new Object();
    private static final Map<String, String> POT_CACHE = new HashMap<>();
    private static Gen sGen;
    private static String sVisitorData;
    private static String sStreamingPot;

    private PoToken() { }

    /** Drops everything (used when the WebView turns out to be unusable). */
    public static void reset() {
        synchronized (LOCK) {
            closeGenLocked();
        }
    }

    /**
     * Returns visitorData + player/streaming pot for a video. Blocking: the
     * first call runs the whole BotGuard init (WebView) and takes seconds, the
     * following ones only mint the player token (~0.5 s).
     */
    public static Tokens get(Context ctx, String videoId) throws Exception {
        if (ctx == null) throw new IOException("no context");
        synchronized (LOCK) {
            Throwable last = null;
            for (int attempt = 0; attempt < 2; attempt++) {
                try {
                    if (needRecreate()) {
                        closeGenLocked();
                        long t0 = System.currentTimeMillis();
                        String vd = fetchVisitorData();
                        Gen g = Gen.create(ctx);
                        // The streaming token must be the first one minted by a
                        // fresh generator (SmartTube does the same).
                        String stream = g.generate(vd);
                        sVisitorData = vd;
                        sStreamingPot = stream;
                        sGen = g;
                        POT_CACHE.clear();
                        android.util.Log.i(TAG, "pot: generator ready in "
                                + (System.currentTimeMillis() - t0) + "ms vd=" + cut(vd, 24)
                                + " stream=" + cut(stream, 16));
                    }
                    String pot = "";
                    if (videoId != null && !videoId.isEmpty()) {
                        pot = POT_CACHE.get(videoId);
                        if (pot == null) {
                            long t0 = System.currentTimeMillis();
                            pot = sGen.generate(videoId);
                            POT_CACHE.put(videoId, pot);
                            if (POT_CACHE.size() > 8) POT_CACHE.clear();
                            android.util.Log.i(TAG, "pot: playerPot " + videoId + " in "
                                    + (System.currentTimeMillis() - t0) + "ms " + cut(pot, 16));
                        }
                    }
                    return new Tokens(sVisitorData, pot, sStreamingPot);
                } catch (Throwable e) {
                    last = e;
                    android.util.Log.e(TAG, "pot: attempt " + (attempt + 1) + " failed: " + e);
                    closeGenLocked();
                }
            }
            throw new IOException("poToken failed: " + last);
        }
    }

    private static boolean needRecreate() {
        if (sGen == null || sVisitorData == null || sStreamingPot == null) return true;
        return sGen.isExpired();
    }

    private static void closeGenLocked() {
        Gen g = sGen;
        sGen = null;
        sVisitorData = null;
        sStreamingPot = null;
        POT_CACHE.clear();
        if (g != null) {
            try { g.close(); } catch (Throwable ignored) { }
        }
    }

    // ---------------------------------------------------------------- visitor

    private static String fetchVisitorData() throws Exception {
        JSONObject client = new JSONObject();
        client.put("clientName", "WEB");
        client.put("clientVersion", VISITOR_VERSION);
        client.put("hl", "en");
        client.put("gl", "US");
        JSONObject ctx = new JSONObject();
        ctx.put("client", client);
        JSONObject body = new JSONObject();
        body.put("context", ctx);

        byte[] payload = body.toString().getBytes(StandardCharsets.UTF_8);
        HttpURLConnection c = (HttpURLConnection) new URL(
                "https://www.youtube.com/youtubei/v1/visitor_id?key=" + API_KEY
                        + "&prettyPrint=false").openConnection();
        c.setConnectTimeout(10000);
        c.setReadTimeout(15000);
        c.setRequestMethod("POST");
        c.setDoOutput(true);
        c.setRequestProperty("Content-Type", "application/json");
        c.setRequestProperty("Accept-Language", "en-US, en;q=0.9");
        c.setRequestProperty("User-Agent", VISITOR_UA);
        c.setRequestProperty("X-Youtube-Client-Name", "1");
        c.setRequestProperty("X-Youtube-Client-Version", VISITOR_VERSION);
        c.setRequestProperty("Origin", "https://www.youtube.com");
        c.setRequestProperty("Referer", "https://www.youtube.com");
        c.setRequestProperty("Cookie", "SOCS=CAE=");
        String raw;
        try {
            OutputStream os = c.getOutputStream();
            os.write(payload);
            os.close();
            int code = c.getResponseCode();
            if (code != 200) throw new IOException("visitor_id HTTP " + code);
            raw = new String(readAll(c.getInputStream()), StandardCharsets.UTF_8);
        } finally {
            try { c.disconnect(); } catch (Throwable ignored) { }
        }
        JSONObject j = new JSONObject(raw);
        JSONObject rc = j.optJSONObject("responseContext");
        String vd = rc == null ? "" : rc.optString("visitorData", "");
        if (vd.isEmpty()) throw new IOException("visitor_id returned no visitorData");
        android.util.Log.i(TAG, "pot: visitorData " + cut(vd, 24));
        return vd;
    }

    // ------------------------------------------------------------ botguard net

    private static String bgPost(String method, String body) throws Exception {
        byte[] payload = body.getBytes(StandardCharsets.UTF_8);
        HttpURLConnection c = (HttpURLConnection) new URL(BG_BASE + method).openConnection();
        c.setConnectTimeout(10000);
        c.setReadTimeout(25000);
        c.setRequestMethod("POST");
        c.setDoOutput(true);
        c.setRequestProperty("User-Agent", BG_UA);
        c.setRequestProperty("Accept", "application/json");
        c.setRequestProperty("Content-Type", "application/json+protobuf");
        c.setRequestProperty("x-goog-api-key", GOOGLE_API_KEY);
        c.setRequestProperty("x-user-agent", "grpc-web-javascript/0.1");
        try {
            OutputStream os = c.getOutputStream();
            os.write(payload);
            os.close();
            int code = c.getResponseCode();
            if (code != 200) throw new IOException("botguard " + method + " HTTP " + code);
            byte[] raw = readAll(c.getInputStream());
            android.util.Log.i(TAG, "pot: botguard " + method + " ok " + raw.length + "B");
            return new String(raw, StandardCharsets.UTF_8);
        } finally {
            try { c.disconnect(); } catch (Throwable ignored) { }
        }
    }

    // -------------------------------------------------------------- challenge

    /** Port of JavaScriptUtil.parseChallengeData(). */
    static String parseChallengeData(String raw) throws Exception {
        JSONArray scrambled = new JSONArray(raw);
        JSONArray cd;
        if (scrambled.length() > 1 && scrambled.opt(1) instanceof String) {
            cd = new JSONArray(descramble(scrambled.getString(1)));
        } else {
            cd = scrambled.optJSONArray(0);
        }
        if (cd == null) throw new IOException("bad challenge data");

        JSONObject interpreter = new JSONObject();
        interpreter.put("privateDoNotAccessOrElseSafeScriptWrappedValue", firstString(cd.optJSONArray(1)));
        interpreter.put("privateDoNotAccessOrElseTrustedResourceUrlWrappedValue", firstString(cd.optJSONArray(2)));

        JSONObject out = new JSONObject();
        out.put("messageId", cd.optString(0, ""));
        out.put("interpreterJavascript", interpreter);
        out.put("interpreterHash", cd.optString(3, ""));
        out.put("program", cd.optString(4, ""));
        out.put("globalName", cd.optString(5, ""));
        out.put("clientExperimentsStateBlob", cd.optString(7, ""));
        return out.toString();
    }

    private static Object firstString(JSONArray a) {
        if (a == null) return JSONObject.NULL;
        for (int i = 0; i < a.length(); i++) {
            Object o = a.opt(i);
            if (o instanceof String) return o;
        }
        return JSONObject.NULL;
    }

    /** base64 -> bytes, +97 each -> UTF-8 string. */
    private static String descramble(String scrambled) throws IOException {
        byte[] b = b64dec(scrambled);
        for (int i = 0; i < b.length; i++) b[i] = (byte) ((b[i] & 0xFF) + 97);
        return new String(b, StandardCharsets.UTF_8);
    }

    /** YouTube-style base64 (-_ alphabet, '.' used as padding sometimes). */
    static byte[] b64dec(String s) throws IOException {
        if (s == null) throw new IOException("null base64");
        String t = s.replace('-', '+').replace('_', '/').replace('.', '=');
        int eq = t.indexOf('=');
        if (eq >= 0) t = t.substring(0, eq);
        int pad = (4 - (t.length() % 4)) % 4;
        StringBuilder sb = new StringBuilder(t);
        for (int i = 0; i < pad; i++) sb.append('=');
        try {
            return Base64.decode(sb.toString(), Base64.DEFAULT);
        } catch (Throwable e) {
            throw new IOException("base64 decode failed: " + e);
        }
    }

    /** "97,98,99" -> poToken base64 (url-safe alphabet, keeps padding). */
    static String u8ToBase64(String csv) throws IOException {
        String[] parts = csv.split(",");
        // Empty parts must be skipped, not turned into zero bytes: a stray ",,"
        // in the CSV would otherwise silently corrupt the token.
        int[] vals = new int[parts.length];
        int len = 0;
        for (int i = 0; i < parts.length; i++) {
            String p = parts[i].trim();
            if (p.isEmpty()) continue;
            try {
                vals[len++] = Integer.parseInt(p) & 0xFF;
            } catch (NumberFormatException e) {
                throw new IOException("bad poToken byte: " + p);
            }
        }
        byte[] b = new byte[len];
        for (int i = 0; i < len; i++) b[i] = (byte) vals[i];
        return Base64.encodeToString(b, Base64.NO_WRAP | Base64.URL_SAFE);
    }

    static String newUint8Array(byte[] data) {
        StringBuilder sb = new StringBuilder("new Uint8Array([");
        for (int i = 0; i < data.length; i++) {
            if (i != 0) sb.append(',');
            sb.append(data[i] & 0xFF);
        }
        return sb.append("])").toString();
    }

    static String stringToU8(String s) {
        try {
            return newUint8Array(s.getBytes("UTF-8"));
        } catch (Throwable e) {
            return newUint8Array(s.getBytes(StandardCharsets.UTF_8));
        }
    }

    static String urlEnc(String s) {
        try {
            return URLEncoder.encode(s, "UTF-8");
        } catch (Throwable e) {
            return s;
        }
    }

    private static String cut(String s, int n) {
        if (s == null) return "null";
        return s.length() <= n ? s : s.substring(0, n) + "...";
    }

    private static byte[] readAll(InputStream in) throws IOException {
        ByteArrayOutputStream b = new ByteArrayOutputStream();
        byte[] buf = new byte[8192];
        int r;
        while ((r = in.read(buf)) != -1) b.write(buf, 0, r);
        return b.toByteArray();
    }

    // ------------------------------------------------------------ webview gen

    /**
     * One WebView that has BotGuard loaded and can mint poTokens. Public because
     * android.webkit reflects over the @JavascriptInterface methods.
     */
    public static final class Gen {
        private static final String JS = "PoTokenWebView";

        private final WebView wv;
        private final Handler main;
        private final CountDownLatch initLatch = new CountDownLatch(1);
        volatile long expirationMs = -1;
        volatile Throwable initError;

        private final Object potLock = new Object();
        private String potIdent;
        private String potVal;
        private Throwable potErr;
        private boolean potReady;

        private Gen(Context ctx) {
            main = new Handler(Looper.getMainLooper());
            wv = new WebView(ctx);
            WebSettings s = wv.getSettings();
            s.setJavaScriptEnabled(true);
            s.setUserAgentString(BG_UA);
            // The page never needs the network: all HTTP happens in Java.
            s.setBlockNetworkLoads(true);
            wv.addJavascriptInterface(this, JS);
            wv.setWebChromeClient(new WebChromeClient() {
                @Override
                public boolean onConsoleMessage(ConsoleMessage m) {
                    String msg = m == null ? "" : String.valueOf(m.message());
                    if (msg.contains("Uncaught")) {
                        android.util.Log.e(TAG, "pot: broken webview: " + cut(msg, 200)
                                + " @" + (m == null ? -1 : m.lineNumber()));
                        failInit(new IOException("webview JS error: " + cut(msg, 200)));
                    } else if (!msg.isEmpty()) {
                        android.util.Log.d(TAG, "pot js: " + cut(msg, 200));
                    }
                    return true;
                }
            });
        }

        static Gen create(Context ctx) throws Exception {
            final Gen[] out = new Gen[1];
            final Throwable[] err = new Throwable[1];
            final CountDownLatch made = new CountDownLatch(1);
            boolean posted = new Handler(Looper.getMainLooper()).post(new Runnable() {
                public void run() {
                    try {
                        out[0] = new Gen(ctx);
                    } catch (Throwable t) {
                        err[0] = t;
                    } finally {
                        made.countDown();
                    }
                }
            });
            if (!posted) throw new IOException("main looper unavailable");
            if (!made.await(20, TimeUnit.SECONDS)) throw new IOException("webview create timeout");
            if (err[0] != null) throw new IOException("webview create failed: " + err[0]);
            final Gen g = out[0];
            if (g == null) throw new IOException("webview not created");

            g.load();
            if (!g.initLatch.await(40, TimeUnit.SECONDS)) {
                g.close();
                throw new IOException("botguard init timeout");
            }
            if (g.initError != null) {
                Throwable t = g.initError;
                g.close();
                throw new IOException("botguard init failed: " + t);
            }
            android.util.Log.i(TAG, "pot: botguard ready, expires in "
                    + Math.max(0, (g.expirationMs - System.currentTimeMillis()) / 1000) + "s");
            return g;
        }

        private void load() throws Exception {
            final CountDownLatch done = new CountDownLatch(1);
            final Throwable[] err = new Throwable[1];
            postMain(new Runnable() {
                public void run() {
                    try {
                        String html = readAsset();
                        // Same trick as SmartTube: kick off BotGuard right after
                        // the page script has been parsed.
                        html = html.replaceFirst("</script>",
                                "\n" + JS + ".downloadAndRunBotguard()</script>");
                        wv.loadDataWithBaseURL("https://www.youtube.com", html,
                                "text/html", "utf-8", null);
                    } catch (Throwable t) {
                        err[0] = t;
                    } finally {
                        done.countDown();
                    }
                }
            });
            if (!done.await(15, TimeUnit.SECONDS)) throw new IOException("load timeout");
            if (err[0] != null) throw new IOException("load failed: " + err[0]);
        }

        private String readAsset() throws IOException {
            // Reach the AssetManager through the WebView's context.
            android.content.Context ctx = wv.getContext();
            InputStream in = ctx.getAssets().open(HTML_ASSET);
            try {
                return new String(readAll(in), StandardCharsets.UTF_8);
            } finally {
                try { in.close(); } catch (Throwable ignored) { }
            }
        }

        /** Mints a poToken for identifier. Blocking, must not run on main. */
        String generate(String identifier) throws Exception {
            if (identifier == null || identifier.isEmpty()) throw new IOException("empty identifier");
            if (Looper.myLooper() == Looper.getMainLooper()) {
                throw new IOException("generate() must not run on the main thread");
            }
            if (initError != null) throw new IOException("generator broken: " + initError);

            synchronized (potLock) {
                potIdent = identifier;
                potVal = null;
                potErr = null;
                potReady = false;
            }

            String js = "try { identifier = " + JSONObject.quote(identifier)
                    + "; u8Identifier = " + stringToU8(identifier)
                    + "; poTokenU8 = obtainPoToken(webPoSignalOutput, integrityToken, u8Identifier);"
                    + " poTokenU8String = \"\";"
                    + " for (i = 0; i < poTokenU8.length; i++) {"
                    + " if (i != 0) poTokenU8String += \",\"; poTokenU8String += poTokenU8[i]; }"
                    + " " + JS + ".onObtainPoTokenResult(identifier, poTokenU8String);"
                    + " } catch (error) {"
                    + " " + JS + ".onObtainPoTokenError(identifier, error + \"\\n\" + error.stack); }";
            evalJs(js);

            long deadline = System.currentTimeMillis() + 25000;
            synchronized (potLock) {
                while (!potReady && potErr == null) {
                    long left = deadline - System.currentTimeMillis();
                    if (left <= 0) throw new IOException("poToken timeout for " + identifier);
                    potLock.wait(left);
                }
                if (potErr != null) throw new IOException("poToken error: " + potErr);
                return potVal;
            }
        }

        boolean isExpired() {
            return expirationMs <= 0 || System.currentTimeMillis() > expirationMs;
        }

        void close() {
            try {
                postMain(new Runnable() {
                    public void run() {
                        try { wv.stopLoading(); } catch (Throwable ignored) { }
                        try { wv.loadUrl("about:blank"); } catch (Throwable ignored) { }
                        try { wv.clearHistory(); } catch (Throwable ignored) { }
                        try { wv.destroy(); } catch (Throwable ignored) { }
                    }
                });
            } catch (Throwable ignored) { }
        }

        // ------------------------------------------------------ JS callbacks

        @JavascriptInterface
        public void downloadAndRunBotguard() {
            try {
                String resp = bgPost("Create", "[ \"" + REQUEST_KEY + "\" ]");
                String data = parseChallengeData(resp);
                evalJs("try { data = " + data + ";"
                        + " runBotGuard(data).then(function (result) {"
                        + " this.webPoSignalOutput = result.webPoSignalOutput;"
                        + " " + JS + ".onRunBotguardResult(result.botguardResponse);"
                        + " }, function (error) {"
                        + " " + JS + ".onJsInitializationError(error + \"\\n\" + error.stack); });"
                        + " } catch (error) {"
                        + " " + JS + ".onJsInitializationError(error + \"\\n\" + error.stack); }");
            } catch (Throwable t) {
                failInit(t);
            }
        }

        @JavascriptInterface
        public void onJsInitializationError(String error) {
            failInit(new IOException("js init error: " + cut(error, 300)));
        }

        @JavascriptInterface
        public void onRunBotguardResult(String botguardResponse) {
            try {
                JSONArray req = new JSONArray();
                req.put(REQUEST_KEY);
                req.put(botguardResponse == null ? "" : botguardResponse);
                String resp = bgPost("GenerateIT", req.toString());
                JSONArray t = new JSONArray(resp);
                byte[] integrity = b64dec(t.getString(0));
                long exp = t.optLong(1, 0);
                // 10 minutes of margin, like SmartTube.
                expirationMs = System.currentTimeMillis() + ((exp - 600) * 1000L);
                evalJs("this.integrityToken = " + newUint8Array(integrity) + ";"
                        + JS + ".onJsInitializationDone(" + exp + ");");
            } catch (Throwable e) {
                failInit(e);
            }
        }

        @JavascriptInterface
        public void onJsInitializationDone(long expirationTimeInSeconds) {
            android.util.Log.i(TAG, "pot: webview init done, token lives "
                    + expirationTimeInSeconds + "s");
            initLatch.countDown();
        }

        @JavascriptInterface
        public void onObtainPoTokenResult(String identifier, String poTokenU8) {
            String pot;
            try {
                pot = u8ToBase64(poTokenU8);
            } catch (Throwable e) {
                failPot(identifier, e);
                return;
            }
            android.util.Log.i(TAG, "pot: minted " + cut(identifier, 20) + " bytes="
                    + (poTokenU8 == null ? 0 : poTokenU8.split(",").length) + " pot=" + cut(pot, 16));
            synchronized (potLock) {
                if (potIdent != null && potIdent.equals(identifier)) {
                    potVal = pot;
                    potReady = true;
                    potLock.notifyAll();
                }
            }
        }

        @JavascriptInterface
        public void onObtainPoTokenError(String identifier, String error) {
            failPot(identifier, new IOException("js mint error: " + cut(error, 300)));
        }

        private void failPot(String identifier, Throwable e) {
            android.util.Log.e(TAG, "pot: mint failed " + cut(identifier, 20) + ": " + e);
            synchronized (potLock) {
                if (potIdent != null && potIdent.equals(identifier)) {
                    potErr = e;
                    potLock.notifyAll();
                }
            }
        }

        private void failInit(Throwable e) {
            if (initError == null) initError = e;
            android.util.Log.e(TAG, "pot: init failure: " + e);
            synchronized (potLock) {
                if (potErr == null) potErr = e;
                potLock.notifyAll();
            }
            // The WebView has to go away on the main thread.
            close();
            initLatch.countDown();
        }

        private void evalJs(final String js) {
            try {
                postMain(new Runnable() {
                    public void run() {
                        try {
                            wv.evaluateJavascript(js, null);
                        } catch (Throwable e) {
                            failInit(e);
                        }
                    }
                });
            } catch (Throwable e) {
                failInit(e);
            }
        }

        private void postMain(Runnable r) {
            if (!main.post(r)) throw new IllegalStateException("cannot post to main thread");
        }
    }
}
