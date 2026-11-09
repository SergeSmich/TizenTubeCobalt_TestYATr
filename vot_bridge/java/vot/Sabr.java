package vot;

import android.util.Base64;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.HashMap;
import java.util.Map;

/**
 * Minimal YouTube SABR (Server Adaptive Bitrate) client, ported from the
 * SmartTube-Vox fork of ExoPlayer (library/sabr). The TV page plays as TVHTML5
 * and that is the only client InnerTube does not send to the "confirm you're
 * not a bot" gate, but TVHTML5 answers with serverAbrStreamingUrl only: no
 * plain googlevideo url at all. So the audio has to be pulled the same way the
 * player pulls it: POST a VideoPlaybackAbrRequest, read UMP frames, keep the
 * media bytes.
 *
 * Scope: AUDIO_ONLY, one itag, from 0 to the end of the track. The bytes arrive
 * sequentially (init segment first, then media segments), which is exactly the
 * layout googlevideo would have returned for the same itag.
 */
public final class Sabr {
    private static final String TAG = "VotBridge";

    // UMP part ids (UMPPartId.java in the fork).
    private static final int P_MEDIA_HEADER = 20;
    private static final int P_MEDIA = 21;
    private static final int P_MEDIA_END = 22;
    private static final int P_NEXT_REQUEST_POLICY = 35;
    private static final int P_FORMAT_INIT = 42;
    private static final int P_REDIRECT = 43;
    private static final int P_ERROR = 44;
    private static final int P_STREAM_PROTECTION = 58;
    private static final int P_END_OF_TRACK = 62;

    // EnabledTrackTypes.AUDIO_ONLY
    private static final int AUDIO_ONLY = 1;

    private static final int MAX_RESPONSE = 48 * 1024 * 1024;

    /** Sequential consumer of media bytes (init segment first). */
    public interface Sink {
        void onBytes(byte[] data, int off, int len) throws Exception;
    }

    /** Lets the caller abort a run (another video took over). */
    public interface Cancel {
        boolean cancelled();
    }

    /** Holds one post's media so a replay never reaches the file. */
    private static final class Buf implements Sink {
        private final ByteArrayOutputStream o = new ByteArrayOutputStream(1 << 17);

        public void onBytes(byte[] d, int off, int len) {
            o.write(d, off, len);
        }

        byte[] data() {
            return o.toByteArray();
        }

        int size() {
            return o.size();
        }
    }

    public static final class Params {
        public String videoId = "";
        public String url = "";
        public String ustreamerConfig = ""; // base64url, playerConfig...videoPlaybackUstreamerConfig
        public String poToken = "";         // base64url player pot
        public String visitorData = "";
        public int clientName = 7;          // TVHTML5
        public String clientVersion = "";
        public String osName = "";
        public String osVersion = "";
        public String ua = "";
        public String hl = "en";
        public String gl = "US";
        public int itag = 0;                // 0 = take whatever audio the server picks
        public long lmt = 0;
        public String xtags = "";
        public String audioTrackId = "";
        public long bandwidth = 128000L;
        public long expectedLength = 0;     // stop once this many bytes are in
        public long expectedEndMs = 0;      // stop once media covers this much time
        public int maxPosts = 80;
        public boolean urlPot;              // append &pot=<poToken> to the abr url
        public Cancel cancel;
        // The page's own POST body for this very stream. When set, it is replayed
        // byte for byte (only player_time_ms is patched) instead of building our
        // own request: the server answers a hand-built request from a stranger
        // session with policy frames only.
        public byte[] bodyTpl;
        public boolean bodyStrip;           // drop buffered_ranges (field 3) from bodyTpl

        public Params copy() {
            Params p = new Params();
            p.videoId = videoId;
            p.url = url;
            p.ustreamerConfig = ustreamerConfig;
            p.poToken = poToken;
            p.visitorData = visitorData;
            p.clientName = clientName;
            p.clientVersion = clientVersion;
            p.osName = osName;
            p.osVersion = osVersion;
            p.ua = ua;
            p.hl = hl;
            p.gl = gl;
            p.itag = itag;
            p.lmt = lmt;
            p.xtags = xtags;
            p.audioTrackId = audioTrackId;
            p.bandwidth = bandwidth;
            p.expectedLength = expectedLength;
            p.expectedEndMs = expectedEndMs;
            p.maxPosts = maxPosts;
            p.urlPot = urlPot;
            p.cancel = cancel;
            p.bodyTpl = bodyTpl;
            p.bodyStrip = bodyStrip;
            return p;
        }
    }

    public static final class Result {
        public long bytes;
        public long mediaBytes;
        public int posts;
        public int segments;
        public int initSegs;      // init segments (ftyp/moov) written to the sink
        public int dupInitSegs;   // init segments the server repeated mid-track, skipped
        public long droppedBytes;  // bytes the server replayed and we refused to append
        public int replayStop;    // loop ended because the stream restarted from 0
        public long postEndMs;    // media end of the last parsed post (0 = unknown)
        public long declaredMs;   // duration the server declared in P_FORMAT_INIT
        public int endOfTrack;
        public long nextDelayMs;  // ms the streamer asked us to wait before the next post
        public long lastDelayMs;  // most recent hint (used for pacing)
        public String pol = "";   // raw NEXT_REQUEST_POLICY numbers, diagnostics
        public long endMs;
        public int itag;
        public long contentLength;
        public long firstByteMs;
        public String err = "";
        public final HashMap<Integer, Integer> parts = new HashMap<>();
        // Media bytes per itag: a replayed body that still selects a video
        // format answers with both streams, and this is how we tell a truly
        // audio-only answer from a mixed one.
        public final java.util.LinkedHashMap<Integer, Long> mediaByItag =
                new java.util.LinkedHashMap<>();
        // xtags из media header (поле 5): роль и язык реально отдаваемой
        // дорожки, например `acont=original:lang=en-US`. Это единственный
        // источник языка, который не зависит от InnerTube и его бот-гейта.
        public final java.util.LinkedHashMap<Integer, String> trackXtags =
                new java.util.LinkedHashMap<>();
        final java.util.HashSet<Integer> inited = new java.util.HashSet<>();
        Hdr lastHdr;
        byte[] cookie;

        public String summary() {
            return "itag=" + itag + " bytes=" + bytes + " segs=" + segments
                    + " posts=" + posts + " endMs=" + endMs + " eot=" + endOfTrack
                    + " clen=" + contentLength + " firstMs=" + firstByteMs
                    + " inits=" + initSegs + " dupInit=" + dupInitSegs
                    + (declaredMs > 0 ? " declMs=" + declaredMs : "")
                    + (pol.isEmpty() ? "" : " pol=" + pol)
                    + (droppedBytes > 0 ? " dropped=" + droppedBytes : "")
                    + (mediaByItag.isEmpty() ? "" : " byItag=" + mediaByItag)
                    + (trackXtags.isEmpty() ? "" : " xt=" + trackXtags)
                    + (err.isEmpty() ? "" : " err=" + err);
        }
    }

    private Sabr() { }

    // Body for the first POST, built exactly like run() does. Exposed so
    // /sabrreplay can send our own encoder down the player's URL.
    public static byte[] requestBody(Params p, long playerTimeMs) throws IOException {
        return build(p, playerTimeMs, 0, 0, null, b64(p.ustreamerConfig), b64(p.poToken));
    }

    // Parse one UMP response and report what is in it. Used by /sabrreplay to
    // tell "the replayed request really returns media" from "it returns the
    // same 403/error frame as ours".
    public static org.json.JSONObject inspect(byte[] resp) {
        org.json.JSONObject o = new org.json.JSONObject();
        try {
            Result r = new Result();
            HashMap<Integer, Hdr> hdrs = new HashMap<>();
            parse(resp, r, hdrs, 0, null, new boolean[]{false}, new long[]{0});
            o.put("itag", r.itag);
            o.put("media", r.mediaBytes);
            o.put("bytes", r.bytes);
            o.put("segs", r.segments);
            o.put("eot", r.endOfTrack);
            o.put("clen", r.contentLength);
            o.put("endMs", r.endMs);
            o.put("parts", r.parts.toString());
            o.put("byItag", r.mediaByItag.toString());
            if (!r.trackXtags.isEmpty()) o.put("xtags", r.trackXtags.toString());
            if (!r.err.isEmpty()) o.put("err", r.err);
        } catch (Throwable e) {
            try { o.put("err", String.valueOf(e)); } catch (Throwable ignored) { }
        }
        return o;
    }

    // ---------------------------------------------------------------- driver

    public static Result run(Params p, Sink sink) throws Exception {
        if (p == null || p.url == null || p.url.isEmpty()) throw new IOException("no sabr url");
        Result r = new Result();
        long t0 = System.currentTimeMillis();
        byte[] ustreamer = b64(p.ustreamerConfig);
        byte[] pot = b64(p.poToken);
        Map<Integer, Hdr> hdrs = new HashMap<>();

        String url = p.url;
        if (p.urlPot && !p.poToken.isEmpty() && !p.url.contains("pot=")) {
            url = p.url + (p.url.indexOf('?') < 0 ? "?" : "&") + "pot=" + PoToken.urlEnc(p.poToken);
        }
        long playerTimeMs = 0;
        long endTimeMs = 0;
        int lastSeq = 0;
        long lastDurMs = 0;
        byte[] cookie = null;
        int target = p.itag;   // 0 = take whatever the stream carries
        long prevBytes = -1;
        long prevEnd = 0;
        int stuck = 0;
        int replay = 0;
        // A replayed body gets an acknowledgement first (52 REQUEST_IDENTIFIER,
        // 53 REQUEST_CANCELLATION_POLICY with 1000/5000 ms timings) and only then
        // media, so give it more posts and a pause; our own body is answered
        // deterministically and needs no patience.
        int stuckLimit = p.bodyTpl != null ? 20 : 2;
        long postGapMs = p.bodyTpl != null ? 900 : 0;
        int replayLimit = p.bodyTpl != null ? 4 : 2;
        long paceMs = 0;   // wait the streamer asked for after the previous post

        for (int postNum = 1; postNum <= p.maxPosts; postNum++) {
            if (p.cancel != null && p.cancel.cancelled()) {
                r.err = "cancelled";
                break;
            }
            byte[] body = p.bodyTpl != null
                    ? replayBody(p.bodyTpl, playerTimeMs, p.bodyStrip)
                    : build(p, playerTimeMs, lastSeq, lastDurMs, cookie, ustreamer, pot);
            byte[] resp = post(withRn(url, postNum), body, p);
            r.posts = postNum;

            boolean[] gotMedia = new boolean[]{false};
            long[] maxEnd = new long[]{endTimeMs};
            int before = r.segments;
            // Media of this post is held back until we know it moves forward in
            // time. Past the last segment the server restarts the stream from
            // zero instead of signalling the end: appending that replay is what
            // turned a 6 MB track into 109 MB once.
            Buf buf = new Buf();
            parse(resp, r, hdrs, target, buf, gotMedia, maxEnd);
            if (p.bodyTpl == null && target <= 0 && r.itag > 0) target = r.itag;
            endTimeMs = maxEnd[0];
            if (r.cookie != null) cookie = r.cookie;

            boolean advanced = r.postEndMs <= 0 || r.postEndMs > prevEnd;
            if (buf.size() > 0 && advanced) {
                if (sink != null) sink.onBytes(buf.data(), 0, buf.size());
                r.bytes += buf.size();
                prevEnd = Math.max(prevEnd, r.postEndMs);
                replay = 0;
            } else if (buf.size() > 0) {
                r.droppedBytes += buf.size();
                if (r.err.isEmpty()) r.err = "replay at " + prevEnd + "ms";
                if (++replay >= replayLimit) {
                    r.replayStop = 1;
                    break;
                }
                // The streamer repeated a range we already have; do not hammer
                // it, wait whatever it asked for.
                if (paceMs > 0) Thread.sleep(Math.min(paceMs, 5000));
            }

            if (r.firstByteMs == 0 && gotMedia[0]) r.firstByteMs = System.currentTimeMillis() - t0;

            Hdr last = r.lastHdr;
            if (last != null) {
                lastSeq = last.seq;
                lastDurMs = last.durationMs;
                if (last.startMs + last.durationMs > playerTimeMs) {
                    playerTimeMs = last.startMs + last.durationMs;
                }
                r.endMs = playerTimeMs;
                if (last.contentLength > 0) r.contentLength = last.contentLength;
            }

            android.util.Log.i(TAG, "sabr post " + postNum + " rn=" + postNum + " t=" + playerTimeMs
                    + " bytes=" + r.bytes + " segs=" + r.segments + " resp=" + resp.length
                    + (p.bodyTpl != null ? " raw=" + (p.bodyStrip ? 2 : 1) : "")
                    + (r.lastDelayMs > 0 ? " d=" + r.lastDelayMs : "")
                    + " parts=" + r.parts
                    + (r.segments == 0 && postNum <= 2 && resp.length <= 400
                            ? " hex=" + hexHead(resp, 240) : ""));
            if (postNum == 1) {
                android.util.Log.i(TAG, "sabr req itag=" + p.itag + " xt="
                        + (p.xtags == null || p.xtags.isEmpty() ? "-" : p.xtags)
                        + " lmt=" + p.lmt + " seq=" + lastSeq);
            }

            if (r.endOfTrack != 0) break;
            if (p.expectedLength > 0 && r.bytes >= p.expectedLength) break;
            // Coverage is what we actually appended, not what the response
            // declares: P_FORMAT_INIT carries the duration of the *whole* track,
            // so comparing against it stopped the run after the first segment
            // (163 KB of a 5.7 MB track). `prevEnd` only moves when a post really
            // advanced the timeline, so it is the honest "we have the video up to
            // here" marker.
            if (p.expectedEndMs > 0 && prevEnd >= p.expectedEndMs - 500) break;
            if (r.lastDelayMs > 0) paceMs = r.lastDelayMs;
            if (r.bytes == prevBytes && r.segments == before) {
                if (++stuck >= stuckLimit) {
                    if (r.err.isEmpty()) {
                        r.err = "no progress at " + playerTimeMs + "ms";
                    } else {
                        r.err = r.err + " (stuck at " + playerTimeMs + "ms)";
                    }
                    break;
                }
                long wait = paceMs > 0 ? Math.min(paceMs, 5000) : postGapMs;
                if (wait > 0) Thread.sleep(wait);
            } else {
                stuck = 0;
            }
            prevBytes = r.bytes;
        }
        if (r.itag <= 0 && target > 0) r.itag = target;
        return r;
    }

    // --------------------------------------------------------------- request

    private static byte[] build(Params p, long playerTimeMs, int lastSeq, long lastDurMs,
                                byte[] cookie, byte[] ustreamer, byte[] pot) throws IOException {
        ByteArrayOutputStream o = new ByteArrayOutputStream(512);

        // 1 client_abr_state
        ByteArrayOutputStream s = new ByteArrayOutputStream(64);
        wInt(s, 28, playerTimeMs);           // player_time_ms
        wFloat(s, 35, 1.0f);                 // playback_rate
        wInt(s, 23, p.bandwidth);            // bandwidth_estimate
        wInt(s, 40, AUDIO_ONLY);             // enabled_track_types_bitfield
        if (p.audioTrackId != null && !p.audioTrackId.isEmpty()) {
            wBytes(s, 69, p.audioTrackId.getBytes(StandardCharsets.UTF_8));
        }
        wBytes(o, 1, s.toByteArray());

        // 2 selected_format_ids
        if (p.itag > 0) wBytes(o, 2, formatId(p.itag, p.lmt, p.xtags));

        // 3 buffered_ranges: what we already have, so the server never resends
        if (lastSeq > 0 && p.itag > 0) {
            ByteArrayOutputStream b = new ByteArrayOutputStream(48);
            wBytes(b, 1, formatId(p.itag, p.lmt, p.xtags));
            wInt(b, 2, 0);                    // start_time_ms
            wInt(b, 3, lastDurMs);            // duration_ms
            wInt(b, 4, lastSeq);              // start_segment_index
            wInt(b, 5, lastSeq);              // end_segment_index
            ByteArrayOutputStream tr = new ByteArrayOutputStream(24);
            wInt(tr, 1, 0);                   // start_ticks
            wInt(tr, 2, lastDurMs);           // duration_ticks
            wInt(tr, 3, 1000);                // timescale
            wBytes(b, 6, tr.toByteArray());   // time_range
            wBytes(o, 3, b.toByteArray());
        }

        // 4 player_time_ms
        wInt(o, 4, playerTimeMs);

        // 5 video_playback_ustreamer_config
        if (ustreamer.length > 0) wBytes(o, 5, ustreamer);

        // 16 preferred_audio_format_ids
        if (p.itag > 0) wBytes(o, 16, formatId(p.itag, 0, ""));

        // 19 streamer_context
        ByteArrayOutputStream sc = new ByteArrayOutputStream(256);
        ByteArrayOutputStream ci = new ByteArrayOutputStream(128);
        wBytes(ci, 1, p.hl.getBytes(StandardCharsets.UTF_8));            // hl
        wBytes(ci, 2, p.gl.getBytes(StandardCharsets.UTF_8));            // gl
        wInt(ci, 16, p.clientName);                                      // client_name
        if (p.clientVersion != null && !p.clientVersion.isEmpty()) {
            wBytes(ci, 17, p.clientVersion.getBytes(StandardCharsets.UTF_8));
        }
        if (p.osName != null && !p.osName.isEmpty()) {
            wBytes(ci, 18, p.osName.getBytes(StandardCharsets.UTF_8));
        }
        if (p.osVersion != null && !p.osVersion.isEmpty()) {
            wBytes(ci, 19, p.osVersion.getBytes(StandardCharsets.UTF_8));
        }
        wBytes(sc, 1, ci.toByteArray());                                 // client_info
        if (pot.length > 0) wBytes(sc, 2, pot);                          // po_token
        if (cookie != null && cookie.length > 0) wBytes(sc, 3, cookie);  // playback_cookie
        wBytes(o, 19, sc.toByteArray());

        return o.toByteArray();
    }

    private static byte[] formatId(int itag, long lmt, String xtags) throws IOException {
        ByteArrayOutputStream b = new ByteArrayOutputStream(24);
        wInt(b, 1, itag);
        if (lmt > 0) wInt(b, 2, lmt);
        if (xtags != null && !xtags.isEmpty()) {
            wBytes(b, 3, xtags.getBytes(StandardCharsets.UTF_8));
        }
        return b.toByteArray();
    }

    // ------------------------------------------------- replay of a live body

    public static byte[] replayBody(byte[] tpl, long playerTimeMs) throws IOException {
        return replayBody(tpl, playerTimeMs, false);
    }

    // Copy the player's own request, replacing only the two places where the
    // playback clock lives (`client_abr_state.player_time_ms`, top-level field 4).
    // Everything else — sabr_contexts, po_token, media capabilities, selected
    // formats — stays exactly as the working player sent it.
    //
    // `stripBuffered` drops field 3 (buffered_ranges). The player's body carries
    // the ranges it has already downloaded, so replaying it as-is tells the
    // server "I need nothing" and it answers with request-id/cancellation/
    // next-request policies and no media. Removing them makes the request look
    // like "give me the stream from player_time_ms".
    public static byte[] replayBody(byte[] tpl, long playerTimeMs, boolean stripBuffered)
            throws IOException {
        if (tpl == null || tpl.length == 0) return tpl;
        ByteArrayOutputStream o = new ByteArrayOutputStream(tpl.length + 24);
        int[] pos = new int[]{0};
        boolean saw4 = false;
        while (pos[0] < tpl.length) {
            int start = pos[0];
            long tag = readVarint(tpl, pos);
            int f = (int) (tag >>> 3);
            int w = (int) (tag & 7);
            if (f == 1 && w == 2) {
                long n = readVarint(tpl, pos);
                int p0 = pos[0];
                int p1 = (int) Math.min(tpl.length, p0 + n);
                wBytes(o, 1, patchAbrState(tpl, p0, p1, playerTimeMs));
                pos[0] = p1;
                continue;
            }
            if (f == 4 && w == 0) {
                readVarint(tpl, pos);
                wInt(o, 4, playerTimeMs);
                saw4 = true;
                continue;
            }
            if (stripBuffered && f == 3 && w == 2) {
                if (!skipField(tpl, pos, w)) break;
                continue;
            }
            if (!skipField(tpl, pos, w)) {
                // Unknown wire type: keep the rest as is, we are not a parser.
                o.write(tpl, start, tpl.length - start);
                pos[0] = tpl.length;
                break;
            }
            o.write(tpl, start, pos[0] - start);
        }
        // The player's body always carries field 4; if a future build drops it we
        // add it back, the streamer reads the clock from there as well.
        if (!saw4) wInt(o, 4, playerTimeMs);
        return o.toByteArray();
    }

    private static byte[] patchAbrState(byte[] b, int off, int end, long playerTimeMs)
            throws IOException {
        ByteArrayOutputStream o = new ByteArrayOutputStream(64);
        int[] pos = new int[]{off};
        boolean saw = false;
        while (pos[0] < end) {
            int start = pos[0];
            long tag = readVarint(b, pos);
            int f = (int) (tag >>> 3);
            int w = (int) (tag & 7);
            if (f == 28 && w == 0) {
                readVarint(b, pos);
                wInt(o, 28, playerTimeMs);
                saw = true;
                continue;
            }
            if (!skipField(b, pos, w)) {
                o.write(b, start, end - start);
                pos[0] = end;
                break;
            }
            o.write(b, start, pos[0] - start);
        }
        if (!saw) wInt(o, 28, playerTimeMs);
        return o.toByteArray();
    }

    private static boolean skipField(byte[] b, int[] pos, int w) throws IOException {
        if (w == 0) {
            readVarint(b, pos);
        } else if (w == 2) {
            long n = readVarint(b, pos);
            pos[0] = (int) Math.min(b.length, pos[0] + n);
        } else if (w == 5) {
            pos[0] += 4;
        } else if (w == 1) {
            pos[0] += 8;
        } else {
            return false;
        }
        return pos[0] <= b.length;
    }

    // Raw POST for diagnostics: no exceptions on non-200, returns code and the
    // first bytes of the response. Lets the bridge compare "our headers" with
    // "no headers at all" against the very same url.
    public static final class Raw {
        public int code;
        public String ctype = "";
        public String head = "";
        public int len;
        public String err = "";

        public String summary() {
            return "code=" + code + " ctype=" + ctype + " len=" + len + " hex=" + head;
        }
    }

    public static Raw postRaw(String url, byte[] body, String[] kv, int rn) {
        Raw r = new Raw();
        String u = rn > 0 ? withRn(url, rn) : url;
        HttpURLConnection c = null;
        try {
            c = (HttpURLConnection) new URL(u).openConnection();
            c.setConnectTimeout(10000);
            c.setReadTimeout(30000);
            c.setRequestMethod("POST");
            c.setDoOutput(true);
            c.setFixedLengthStreamingMode(body.length);
            if (kv != null) {
                for (int i = 0; i + 1 < kv.length; i += 2) {
                    if (kv[i] == null || kv[i].isEmpty()) continue;
                    try {
                        c.setRequestProperty(kv[i], kv[i + 1]);
                    } catch (Throwable ignored) { }
                }
            }
            OutputStream os = c.getOutputStream();
            os.write(body);
            os.close();
            r.code = c.getResponseCode();
            try {
                String ct = c.getHeaderField("Content-Type");
                if (ct != null) r.ctype = ct;
            } catch (Throwable ignored) { }
            InputStream in = r.code == 200 ? c.getInputStream() : c.getErrorStream();
            byte[] resp = in == null ? new byte[0] : readAll(in, 4096);
            r.len = resp.length;
            StringBuilder sb = new StringBuilder();
            int lim = Math.min(48, resp.length);
            for (int i = 0; i < lim; i++) {
                if (i > 0) sb.append(' ');
                int v = resp[i] & 0xFF;
                if (v < 16) sb.append('0');
                sb.append(Integer.toHexString(v));
            }
            r.head = sb.toString();
            return r;
        } catch (Throwable e) {
            r.err = String.valueOf(e);
            return r;
        } finally {
            if (c != null) c.disconnect();
        }
    }

    // Structural dump of a protobuf message: field numbers, wire types and,
    // where cheap, nested submessages. This is how our encoder gets compared
    // with the player's own request byte for byte in shape.
    public static String dump(byte[] b) {
        StringBuilder sb = new StringBuilder();
        try {
            dumpMsg(b, 0, b.length, 0, sb);
        } catch (Throwable e) {
            sb.append(" dumpErr=").append(e);
        }
        return sb.toString();
    }

    private static void dumpMsg(byte[] b, int off, int len, int depth,
                                StringBuilder sb) {
        int[] pos = new int[]{off};
        int end = off + len;
        int guard = 0;
        while (pos[0] < end && guard++ < 400) {
            long tag = readVarint(b, pos);
            int f = (int) (tag >>> 3);
            int w = (int) (tag & 7);
            if (w == 0) {
                sb.append(f).append('=').append(readVarint(b, pos));
            } else if (w == 2) {
                long n = readVarint(b, pos);
                int p0 = pos[0];
                int p1 = (int) Math.min(end, p0 + n);
                sb.append(f).append(":len").append(n);
                if (p1 - p0 != n) {
                    // Truncated submessage: stop here instead of emitting noise.
                    pos[0] = p1;
                    break;
                }
                if (depth < 3 && n > 0 && n < 600) {
                    sb.append('{');
                    dumpMsg(b, p0, p1 - p0, depth + 1, sb);
                    sb.append('}');
                } else if (n > 0 && n < 48 && printable(b, p0, p1)) {
                    sb.append("=\"").append(new String(b, p0, p1 - p0,
                            StandardCharsets.UTF_8)).append('"');
                }
                pos[0] = p1;
            } else if (w == 5) {
                pos[0] += 4;
                sb.append(f).append("=f32");
            } else if (w == 1) {
                pos[0] += 8;
                sb.append(f).append("=f64");
            } else {
                break;
            }
            sb.append(' ');
            if (sb.length() > 2500) return;
        }
    }

    // Top-level fields of a message as ordered (number, raw chunk) pairs. A
    // repeated field yields one entry per occurrence — the page selects two
    // formats per request, so collapsing them would corrupt a probe body.
    private static java.util.List<Object[]> chunks(byte[] b) {
        java.util.ArrayList<Object[]> out = new java.util.ArrayList<>();
        int[] pos = new int[]{0};
        while (pos[0] < b.length) {
            int start = pos[0];
            long tag = readVarint(b, pos);
            int f = (int) (tag >>> 3);
            int w = (int) (tag & 7);
            boolean ok = true;
            if (w == 0) {
                readVarint(b, pos);
            } else if (w == 2) {
                long n = readVarint(b, pos);
                long next = pos[0] + n;
                if (next > b.length) ok = false; else pos[0] = (int) next;
            } else if (w == 5) {
                pos[0] += 4;
            } else if (w == 1) {
                pos[0] += 8;
            } else {
                ok = false;
            }
            if (!ok || pos[0] > b.length) break;
            out.add(new Object[]{Integer.valueOf(f), Arrays.copyOfRange(b, start, pos[0])});
        }
        return out;
    }

    // Replace the listed top-level fields of `base` with every occurrence of
    // those fields from `other` (omitted fields keep `base`'s bytes untouched).
    public static byte[] mix(byte[] base, byte[] other, int... fields) throws IOException {
        java.util.HashSet<Integer> take = new java.util.HashSet<>();
        for (int f : fields) take.add(Integer.valueOf(f));
        java.util.HashMap<Integer, java.io.ByteArrayOutputStream> fromOther =
                new java.util.HashMap<>();
        for (Object[] e : chunks(other)) {
            int f = ((Integer) e[0]).intValue();
            if (!take.contains(Integer.valueOf(f))) continue;
            java.io.ByteArrayOutputStream s = fromOther.get(Integer.valueOf(f));
            if (s == null) {
                s = new java.io.ByteArrayOutputStream(256);
                fromOther.put(Integer.valueOf(f), s);
            }
            byte[] c = (byte[]) e[1];
            s.write(c, 0, c.length);
        }
        java.util.HashSet<Integer> done = new java.util.HashSet<>();
        ByteArrayOutputStream o = new ByteArrayOutputStream(base.length + 512);
        for (Object[] e : chunks(base)) {
            int f = ((Integer) e[0]).intValue();
            if (!take.contains(Integer.valueOf(f))) {
                byte[] c = (byte[]) e[1];
                o.write(c, 0, c.length);
                continue;
            }
            if (done.contains(Integer.valueOf(f))) continue;   // drop duplicates
            done.add(Integer.valueOf(f));
            java.io.ByteArrayOutputStream s = fromOther.get(Integer.valueOf(f));
            if (s != null) o.write(s.toByteArray(), 0, s.size());
        }
        for (int f : fields) {
            if (done.contains(Integer.valueOf(f))) continue;
            java.io.ByteArrayOutputStream s = fromOther.get(Integer.valueOf(f));
            if (s != null) o.write(s.toByteArray(), 0, s.size());
        }
        return o.toByteArray();
    }

    // ------------------------------------------------- audio-only request
    //
    // The player's own POST selects both a video format (field 22 = 137) and
    // audio (field 23 = 140), so the streamer answers with a mixed stream and
    // the audio job downloaded 106 MB of itag 137 for a 668 s video. Our own
    // builder asks for one audio itag only, but the request is accepted only
    // when it carries field 5 of the player's own body (the ustreamer config
    // issued for this session) — see `our+page5` in /sabrmix. Field 2 of the
    // captured body tells which itag the player picked.

    // First audio itag the body selects (field 2 entries), then field 23.
    public static int audioItagOf(byte[] body) {
        if (body == null || body.length == 0) return 0;
        int fallback = 0;
        for (Object[] e : chunks(body)) {
            int f = ((Integer) e[0]).intValue();
            byte[] c = (byte[]) e[1];
            int[] h = chunkHdr(c);
            if (f == 2 && h[1] == 2) {
                Msg m = Msg.parse(c, h[3], c.length - h[3]);
                int fit = (int) m.num(1, 0);
                if (isAudioItag(fit)) return fit;
            } else if (f == 23 && h[1] == 0) {
                fallback = (int) readVarint(c, new int[]{h[2]});
            }
        }
        return fallback;
    }

    private static boolean isAudioItag(int it) {
        return it == 139 || it == 140 || it == 141
                || it == 249 || it == 250 || it == 251
                || it == 233 || it == 234 || it == 599 || it == 600;
    }

    // Field number + wire type + payload offsets inside one chunk of chunks().
    private static int[] chunkHdr(byte[] c) {
        int[] pos = new int[]{0};
        long tag = readVarint(c, pos);
        int f = (int) (tag >>> 3);
        int w = (int) (tag & 7);
        int afterTag = pos[0];
        int payload = afterTag;
        if (w == 2) {
            readVarint(c, pos);
            payload = pos[0];
        }
        return new int[]{f, w, afterTag, payload};
    }

    // Drop the listed top-level fields from a message.
    public static byte[] drop(byte[] base, int... fields) throws IOException {
        java.util.HashSet<Integer> gone = new java.util.HashSet<>();
        for (int f : fields) gone.add(Integer.valueOf(f));
        ByteArrayOutputStream o = new ByteArrayOutputStream(base.length);
        for (Object[] e : chunks(base)) {
            if (gone.contains((Integer) e[0])) continue;
            byte[] c = (byte[]) e[1];
            o.write(c, 0, c.length);
        }
        return o.toByteArray();
    }

    // "a=1247 b=1246 diffAt=1246 aTail=… bTail=…" — enough to see whether two
    // copies of the same config differ at all and where.
    public static String cmp(byte[] a, byte[] b) {
        if (a == null && b == null) return "both-absent";
        if (a == null) return "a-absent b=" + b.length;
        if (b == null) return "a=" + a.length + " b-absent";
        int n = Math.min(a.length, b.length);
        int diff = -1;
        for (int i = 0; i < n; i++) {
            if (a[i] != b[i]) { diff = i; break; }
        }
        StringBuilder sb = new StringBuilder();
        sb.append("a=").append(a.length).append(" b=").append(b.length);
        sb.append(" diffAt=").append(diff);
        sb.append(" aTail=").append(hexTail(a)).append(" bTail=").append(hexTail(b));
        return sb.toString();
    }

    private static String hexTail(byte[] b) {
        return hexRange(b, Math.max(0, b.length - 20), b.length);
    }

    // First `max` bytes as hex: a 170-byte "no media" reply is small enough to
    // read the UMP part ids out of it by eye, which is how the dubbed-track
    // refusal was spotted.
    static String hexHead(byte[] b, int max) {
        return hexRange(b, 0, Math.min(Math.max(0, max), b.length));
    }

    private static String hexRange(byte[] b, int from, int to) {
        StringBuilder sb = new StringBuilder();
        for (int i = from; i < to; i++) {
            int v = b[i] & 0xFF;
            if (v < 16) sb.append('0');
            sb.append(Integer.toHexString(v));
        }
        return sb.toString();
    }

    public static byte[] b64Of(String s) {
        return b64(s);
    }

    // Compact list of the *top-level* fields only: number, kind, size and the
    // first bytes. Two requests can be diffed field by field from this alone.
    public static String topFields(byte[] b) {
        if (b == null || b.length == 0) return "none";
        StringBuilder sb = new StringBuilder();
        int[] pos = new int[]{0};
        int end = b.length;
        try {
            while (pos[0] < end) {
                long tag = readVarint(b, pos);
                int f = (int) (tag >>> 3);
                int w = (int) (tag & 7);
                if (w == 0) {
                    long v = readVarint(b, pos);
                    sb.append('#').append(f).append('=').append(v).append(' ');
                } else if (w == 2) {
                    long n = readVarint(b, pos);
                    int p0 = pos[0];
                    int p1 = (int) Math.min(end, p0 + n);
                    sb.append('#').append(f).append(":len").append(n).append(" head=");
                    for (int i = p0; i < Math.min(p0 + 8, p1); i++) {
                        int v = b[i] & 0xFF;
                        if (v < 16) sb.append('0');
                        sb.append(Integer.toHexString(v));
                    }
                    sb.append(' ');
                    pos[0] = p1;
                } else if (w == 5) {
                    sb.append('#').append(f).append("=f32 ");
                    pos[0] += 4;
                } else if (w == 1) {
                    sb.append('#').append(f).append("=f64 ");
                    pos[0] += 8;
                } else {
                    sb.append("wire").append(w).append("? ");
                    break;
                }
            }
        } catch (Throwable e) {
            sb.append(" err=").append(e);
        }
        return sb.toString();
    }

    // Raw bytes of one top-level bytes field (null when absent).
    public static byte[] fieldBytes(byte[] body, int field) {
        if (body == null || body.length == 0) return null;
        try {
            Msg m = Msg.parse(body, 0, body.length);
            return m.buf(field);
        } catch (Throwable e) {
            return null;
        }
    }

    // Length and head of one top-level bytes field. Lets the bridge compare the
    // player's own request with ours without moving whole payloads around.
    public static String fieldInfo(byte[] body, int field) {
        if (body == null || body.length == 0) return "none";
        try {
            Msg m = Msg.parse(body, 0, body.length);
            byte[] b = m.buf(field);
            if (b == null) return "absent";
            StringBuilder sb = new StringBuilder();
            sb.append("len=").append(b.length).append(" head=");
            int lim = Math.min(16, b.length);
            for (int i = 0; i < lim; i++) {
                if (i > 0) sb.append(' ');
                int v = b[i] & 0xFF;
                if (v < 16) sb.append('0');
                sb.append(Integer.toHexString(v));
            }
            return sb.toString();
        } catch (Throwable e) {
            return "err=" + e;
        }
    }

    private static boolean printable(byte[] b, int off, int end) {
        for (int i = off; i < end; i++) {
            int c = b[i] & 0xFF;
            if (c < 0x20 || c > 0x7E) return false;
        }
        return true;
    }

    private static byte[] post(String url, byte[] body, Params p) throws IOException {
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        try {
            c.setConnectTimeout(10000);
            c.setReadTimeout(30000);
            c.setRequestMethod("POST");
            c.setDoOutput(true);
            c.setFixedLengthStreamingMode(body.length);
            c.setRequestProperty("Content-Type", "application/x-protobuf");
            c.setRequestProperty("Accept", "application/vnd.yt-ump");
            c.setRequestProperty("Accept-Encoding", "identity");
            c.setRequestProperty("User-Agent", p.ua == null || p.ua.isEmpty() ? "Cobalt" : p.ua);
            if (p.visitorData != null && !p.visitorData.isEmpty()) {
                c.setRequestProperty("X-Goog-Visitor-Id", p.visitorData);
            }
            c.setRequestProperty("X-Youtube-Client-Name", String.valueOf(p.clientName));
            if (p.clientVersion != null && !p.clientVersion.isEmpty()) {
                c.setRequestProperty("X-Youtube-Client-Version", p.clientVersion);
            }
            c.setRequestProperty("Origin", "https://www.youtube.com");
            c.setRequestProperty("Referer", "https://www.youtube.com/");
            OutputStream os = c.getOutputStream();
            os.write(body);
            os.close();
            int code = c.getResponseCode();
            if (code != 200) {
                InputStream es = c.getErrorStream();
                String txt = es == null ? "" : new String(readAll(es, 2048), StandardCharsets.UTF_8);
                throw new IOException("sabr http " + code + " " + txt.replace('\n', ' '));
            }
            return readAll(c.getInputStream(), MAX_RESPONSE);
        } finally {
            c.disconnect();
        }
    }

    // ------------------------------------------------------------------ UMP

    private static final class Hdr {
        int itag;
        int seq;
        long startMs;
        long durationMs;
        long contentLength;
        boolean init;
        String xtags = "";
    }

    private static void parse(byte[] b, Result r, Map<Integer, Hdr> hdrs, int target,
                              Sink sink, boolean[] gotMedia, long[] maxEnd) throws Exception {
        int pos = 0;
        r.postEndMs = 0;
        while (pos < b.length) {
            int[] pp = new int[]{pos};
            long type = umpVarint(b, pp);
            pos = pp[0];
            pp[0] = pos;
            long size = umpVarint(b, pp);
            pos = pp[0];
            int sz = (int) size;
            if (sz < 0 || pos + sz > b.length) break;
            r.parts.put((int) type, count(r.parts, (int) type) + 1);
            switch ((int) type) {
                case P_MEDIA_HEADER: {
                    Msg m = Msg.parse(b, pos, sz);
                    Hdr h = new Hdr();
                    h.itag = (int) m.num(3, 0);
                    h.init = m.num(8, 0) != 0;
                    h.seq = (int) m.num(9, 0);
                    h.startMs = m.num(11, 0);
                    h.durationMs = m.num(12, 0);
                    h.contentLength = m.num(14, 0);
                    byte[] xt0 = m.buf(5);
                    if (xt0 != null && xt0.length > 0 && xt0.length < 200) {
                        String xs = new String(xt0, StandardCharsets.UTF_8);
                        if (xs.indexOf("acont") >= 0 || xs.indexOf("lang") >= 0) {
                            h.xtags = xs;
                            if (!r.trackXtags.containsKey(Integer.valueOf(h.itag))) {
                                r.trackXtags.put(Integer.valueOf(h.itag), xs);
                            }
                        }
                    }
                    hdrs.put((int) m.num(1, 0), h);
                    if (target <= 0 && h.itag > 0) {
                        target = h.itag;
                        r.itag = h.itag;
                    }
                    if (r.itag <= 0 && h.itag > 0) r.itag = h.itag;
                    if (!h.init && h.startMs + h.durationMs > maxEnd[0]) {
                        maxEnd[0] = h.startMs + h.durationMs;
                    }
                    if (!h.init && (target <= 0 || h.itag == target)
                            && h.startMs + h.durationMs > r.postEndMs) {
                        r.postEndMs = h.startMs + h.durationMs;
                    }
                    if (h.contentLength > 0) r.contentLength = h.contentLength;
                    r.lastHdr = h;
                    break;
                }
                case P_MEDIA: {
                    int[] q = new int[]{pos};
                    int headerId = (int) readVarint(b, q);
                    int off = q[0];
                    int len = pos + sz - off;
                    Hdr h = hdrs.get(headerId);
                    int it = h != null ? h.itag : target;
                    boolean ours = target <= 0 || it == target;
                    // The server repeats the init segment (ftyp/moov/sidx) once
                    // the stream restarts mid-track. Concatenating it produces a
                    // file whose boxes repeat, and Yandex decodes it into noise
                    // ("no speech"): keep the first init only.
                    boolean dupInit = h != null && h.init && !r.inited.add(it);
                    if (len > 0 && ours && !dupInit) {
                        if (h != null && h.init) r.initSegs++;
                        if (sink != null) sink.onBytes(b, off, len);
                        gotMedia[0] = true;
                    } else if (dupInit && ours) {
                        r.dupInitSegs++;
                    }
                    r.mediaBytes += Math.max(0, len);
                    Long seen = r.mediaByItag.get(it);
                    r.mediaByItag.put(it, (seen == null ? 0L : seen) + Math.max(0, len));
                    break;
                }
                case P_MEDIA_END: {
                    int[] q = new int[]{pos};
                    int headerId = (int) readVarint(b, q);
                    Hdr h = hdrs.get(headerId);
                    if (h != null) {
                        if (!h.init && (target <= 0 || h.itag == target)) r.segments++;
                        if (!h.init && h.startMs + h.durationMs > maxEnd[0]) {
                            maxEnd[0] = h.startMs + h.durationMs;
                        }
                        r.lastHdr = h;
                    }
                    break;
                }
                case P_NEXT_REQUEST_POLICY: {
                    Msg m = Msg.parse(b, pos, sz);
                    byte[] ck = m.buf(7);
                    if (ck != null) r.cookie = ck;
                    // The streamer publishes how soon the next request may come
                    // (ms). The player obeys it; blasting posts every 90 ms gets
                    // us throttled after a few hundred seconds of media.
                    long d1 = m.num(1, 0), d2 = m.num(2, 0), d3 = m.num(3, 0);
                    long d = Math.max(d1, Math.max(d2, d3));
                    if (d > r.nextDelayMs) r.nextDelayMs = d;
                    if (d > 0) r.lastDelayMs = d;
                    if (r.pol.isEmpty()) r.pol = d1 + "/" + d2 + "/" + d3;
                    break;
                }
                case P_FORMAT_INIT: {
                    // Field 3 here is the duration of the whole track, not the
                    // part that arrived: keep it as diagnostics only.
                    Msg m = Msg.parse(b, pos, sz);
                    long end = m.num(3, 0);
                    if (end > r.declaredMs) r.declaredMs = end;
                    break;
                }
                case P_REDIRECT: {
                    Msg m = Msg.parse(b, pos, sz);
                    byte[] u = m.buf(1);
                    if (u != null) {
                        String nu = new String(u, StandardCharsets.UTF_8);
                        if (!nu.isEmpty()) android.util.Log.i(TAG, "sabr redirect " + nu.length());
                    }
                    break;
                }
                case P_ERROR: {
                    Msg m = Msg.parse(b, pos, sz);
                    byte[] t = m.buf(1);
                    long act = m.num(2, 0);
                    Msg inner = m.msg(3);
                    String txt = t == null ? "" : new String(t, StandardCharsets.UTF_8);
                    r.err = "sabr_error " + txt + " action=" + act
                            + (inner == null ? "" : " status=" + inner.num(1, 0)
                            + " type=" + inner.num(4, 0));
                    android.util.Log.e(TAG, "sabr error " + r.err);
                    break;
                }
                case P_STREAM_PROTECTION: {
                    Msg m = Msg.parse(b, pos, sz);
                    long st = m.num(1, 0);
                    if (st == 3) r.err = "attestation required";
                    break;
                }
                case P_END_OF_TRACK:
                    r.endOfTrack = 1;
                    break;
                default:
                    break;
            }
            pos += sz;
        }
    }

    private static final int count(Map<Integer, Integer> m, int k) {
        Integer v = m.get(k);
        return v == null ? 0 : v;
    }

    // ------------------------------------------------------- protobuf helpers

    private static final class Msg {
        private final HashMap<Integer, Long> nums = new HashMap<>();
        private final HashMap<Integer, byte[]> bufs = new HashMap<>();

        static Msg parse(byte[] b, int off, int len) {
            Msg m = new Msg();
            int[] pos = new int[]{off};
            int end = off + len;
            try {
                while (pos[0] < end) {
                    long tag = readVarint(b, pos);
                    int field = (int) (tag >>> 3);
                    int wire = (int) (tag & 7);
                    if (wire == 0) {
                        m.nums.put(field, readVarint(b, pos));
                    } else if (wire == 2) {
                        long n = readVarint(b, pos);
                        int p0 = pos[0];
                        int p1 = (int) Math.min(end, p0 + n);
                        m.bufs.put(field, Arrays.copyOfRange(b, p0, p1));
                        pos[0] = p1;
                    } else if (wire == 5) {
                        pos[0] += 4;
                    } else if (wire == 1) {
                        pos[0] += 8;
                    } else {
                        break;
                    }
                }
            } catch (Throwable ignore) { }
            return m;
        }

        long num(int f, long def) {
            Long v = nums.get(f);
            return v == null ? def : v;
        }

        byte[] buf(int f) {
            return bufs.get(f);
        }

        Msg msg(int f) {
            byte[] b = bufs.get(f);
            if (b == null || b.length == 0) return null;
            return parse(b, 0, b.length);
        }
    }

    // UMP framing varint: the length is encoded in the *first* byte (leading
    // ones), not with continuation bits. Used only for part headers.
    private static long umpVarint(byte[] b, int[] pos) {
        int start = pos[0];
        if (start >= b.length) return 0;
        int first = b[start] & 0xFF;
        int size = first < 128 ? 1 : first < 192 ? 2 : first < 224 ? 3 : first < 240 ? 4 : 5;
        if (start + size > b.length) {
            pos[0] = b.length;
            return 0;
        }
        long result = 0;
        int shift = 0;
        if (size != 5) {
            shift = 8 - size;
            result = first & ((1 << shift) - 1);
        }
        for (int i = 1; i < size; i++) {
            result |= (long) (b[start + i] & 0xFF) << shift;
            shift += 8;
        }
        pos[0] = start + size;
        return result;
    }

    // Protobuf varint: little-endian 7-bit groups with a continuation bit.
    // Everything inside a part (and inside our request bodies) uses this one.
    private static long readVarint(byte[] b, int[] pos) {
        int p = pos[0];
        long result = 0;
        int shift = 0;
        while (p < b.length && shift < 64) {
            int v = b[p++] & 0xFF;
            result |= (long) (v & 0x7F) << shift;
            shift += 7;
            if ((v & 0x80) == 0) break;
        }
        pos[0] = p;
        return result;
    }

    private static void wVarint(ByteArrayOutputStream o, long v) {
        while ((v & ~0x7FL) != 0) {
            o.write((int) ((v & 0x7F) | 0x80));
            v >>>= 7;
        }
        o.write((int) v);
    }

    private static void wInt(ByteArrayOutputStream o, int field, long v) {
        wVarint(o, ((long) field << 3) | 0);
        wVarint(o, v);
    }

    private static void wBytes(ByteArrayOutputStream o, int field, byte[] d) {
        wVarint(o, ((long) field << 3) | 2);
        wVarint(o, d.length);
        o.write(d, 0, d.length);
    }

    private static void wFloat(ByteArrayOutputStream o, int field, float v) {
        wVarint(o, ((long) field << 3) | 5);
        int bits = Float.floatToIntBits(v);
        o.write(bits & 0xFF);
        o.write((bits >>> 8) & 0xFF);
        o.write((bits >>> 16) & 0xFF);
        o.write((bits >>> 24) & 0xFF);
    }

    // ----------------------------------------------------------------- utils

    private static byte[] readAll(InputStream in, int cap) throws IOException {
        ByteArrayOutputStream out = new ByteArrayOutputStream(65536);
        byte[] buf = new byte[16384];
        int n;
        while ((n = in.read(buf)) > 0) {
            out.write(buf, 0, n);
            if (out.size() > cap) break;
        }
        return out.toByteArray();
    }

    private static byte[] b64(String s) {
        if (s == null || s.isEmpty()) return new byte[0];
        try {
            return Base64.decode(s, Base64.URL_SAFE | Base64.NO_WRAP);
        } catch (Throwable e) {
            try {
                return Base64.decode(s, Base64.DEFAULT);
            } catch (Throwable e2) {
                return new byte[0];
            }
        }
    }

    private static String withRn(String url, int n) {
        int q = url.indexOf("rn=");
        if (q > 0 && (url.charAt(q - 1) == '&' || url.charAt(q - 1) == '?')) {
            int end = url.indexOf('&', q);
            return url.substring(0, q) + "rn=" + n + (end < 0 ? "" : url.substring(end));
        }
        return url + (url.indexOf('?') < 0 ? "?" : "&") + "rn=" + n;
    }
}
