#!/usr/bin/env python3
"""Yandex VOT probe: talks to api.browser.yandex.ru exactly like the in-app
bridge does, but from the PC, so we can compare cache/translate behaviour
without waiting a minute per video.

Usage:
  python vot_probe.py cache    <videoIdOrUrl> <duration> [lang ...]
  python vot_probe.py translate <videoIdOrUrl> <duration> <lang> [--lively=TOKEN]
  python vot_probe.py compare  <videoIdOrUrl> <duration> [lang ...]

cache     -> POST /video-translation/cache  (no job created, answers instantly)
translate -> POST /video-translation/translate (may create a job)
compare   -> cache for every lang, then (unless --cache-only) translate for the
             lang whose cache entry is finished (0) and for "auto".
"""

import hashlib
import hmac
import json
import secrets
import struct
import sys
import time
import urllib.request

HOST = "https://api.browser.yandex.ru"
HMAC_KEY = b"bt8xH3VOlb4mqf0nqAibnDOoiPlXsisf"
VERSION = "25.12.4.1198"
UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/142.0.0.0 YaBrowser/25.12.4.1198 Safari/537.36"
)


# ---------------------------------------------------------------- protobuf
def varint(n):
    out = bytearray()
    while True:
        b = n & 0x7F
        n >>= 7
        if n:
            out.append(b | 0x80)
        else:
            out.append(b)
            return bytes(out)


def p_str(field, s):
    b = s.encode("utf-8") if isinstance(s, str) else s
    return varint(field << 3 | 2) + varint(len(b)) + b


def p_int(field, v):
    return varint(field << 3 | 0) + varint(int(v))


def p_double(field, v):
    return varint(field << 3 | 1) + struct.pack("<d", float(v))


def read_varint(b, i):
    shift = 0
    val = 0
    while True:
        c = b[i]
        i += 1
        val |= (c & 0x7F) << shift
        if not c & 0x80:
            return val, i
        shift += 7


def decode(b):
    out, i = {}, 0
    while i < len(b):
        key, i = read_varint(b, i)
        field, wire = key >> 3, key & 7
        if wire == 0:
            val, i = read_varint(b, i)
        elif wire == 2:
            ln, i = read_varint(b, i)
            val = b[i : i + ln]
            i += ln
        elif wire == 1:
            val = struct.unpack("<d", b[i : i + 8])[0]
            i += 8
        elif wire == 5:
            val = struct.unpack("<f", b[i : i + 4])[0]
            i += 4
        else:
            raise ValueError(f"wire {wire} at field {field}")
        out.setdefault(field, []).append(val)
    return out


def txt(v):
    if isinstance(v, bytes):
        try:
            return v.decode("utf-8")
        except UnicodeDecodeError:
            return repr(v[:40])
    return v


def one(p, n, default=None):
    return txt(p[n][0]) if p.get(n) else default


# ---------------------------------------------------------------- transport
def sig(body):
    return hmac.new(HMAC_KEY, body, hashlib.sha256).hexdigest()


def post(path, body, headers, method="POST"):
    req = urllib.request.Request(HOST + path, data=body, method=method)
    base = {
        "User-Agent": UA,
        "Accept": "application/x-protobuf",
        "Accept-Language": "en",
        "Content-Type": "application/x-protobuf",
        "Pragma": "no-cache",
        "Cache-Control": "no-cache",
        "sec-ch-ua": '"YaBrowser";v="25.12", "Chromium";v="142", "Not_A Brand";v="99"',
        "sec-ch-ua-full-version-list": '"YaBrowser";v="25.12.4.1198", "Chromium";v="142.0.7444.291"',
        "Sec-Fetch-Mode": "no-cors",
    }
    base.update(headers)
    req.headers = base
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return r.status, r.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()


class Session:
    def __init__(self):
        self.uuid = secrets.token_hex(16).upper()
        self.sk = ""
        self.create()

    def create(self):
        body = p_str(1, self.uuid) + p_str(2, "video-translation")
        code, resp = post("/session/create", body, {"Vtrans-Signature": sig(body)})
        if code != 200:
            raise SystemExit(f"session/create HTTP {code}: {resp[:120]!r}")
        p = decode(resp)
        self.sk = str(one(p, 1, ""))
        print(f"# session ok sk_len={len(self.sk)} uuid={self.uuid[:8]}…")

    def headers(self, path, body):
        token = f"{self.uuid}:{path}:{VERSION}"
        return {
            "Vtrans-Signature": sig(body),
            "Sec-Vtrans-Sk": self.sk,
            "Sec-Vtrans-Token": sig(token.encode()) + ":" + token,
        }


# ---------------------------------------------------------------- requests
CACHE_ITEM = {0: "finished", 1: "?", 2: "waiting", 3: "error"}


def cache(s, url, duration, lang):
    body = p_str(1, url) + p_double(2, duration) + p_str(3, lang) + p_str(4, "ru")
    path = "/video-translation/cache"
    code, resp = post(path, body, s.headers(path, body))
    if code != 200:
        return {"http": code, "raw": resp[:60].hex()}
    p = decode(resp)
    out = {}
    for key, name in ((1, "default"), (2, "cloning")):
        if key not in p:
            continue
        item = decode(p[key][0])
        out[name] = {
            "status": CACHE_ITEM.get(one(item, 1) or 0, "?"),
            "remaining": one(item, 2),
            "message": one(item, 3),
            "flags": [one({"f": [x]}, "f") for x in item.get(5, [])],
        }
    return out or {"raw": resp[:60].hex()}


def p_help(field, items):
    out = b""
    for target, target_url in items:
        sub = p_str(1, target) + p_str(2, target_url)
        out += varint(field << 3 | 2) + varint(len(sub)) + sub
    return out


def translate(
    s,
    url,
    duration,
    lang,
    lively_token=None,
    first=True,
    help_items=None,
    no_lively=True,
):
    body = (
        p_str(3, url)
        + p_int(5, 1 if first else 0)
        + p_double(6, duration)
        + p_int(7, 1)
        + p_str(8, lang)
        + p_str(14, "ru")
        + p_int(15, 1)
        + p_int(16, 2)
    )
    if help_items:
        body += p_help(11, help_items)
    if lively_token:
        body += p_int(18, 1)
    elif not no_lively:
        body += p_int(18, 1)
    path = "/video-translation/translate"
    h = s.headers(path, body)
    if lively_token:
        tok = lively_token.strip()
        h["Authorization"] = (
            tok if tok[:6].lower() in ("oauth ", "bearer") else "OAuth " + tok
        )
    code, resp = post(path, body, h)
    if code != 200:
        return {"http": code, "raw": resp[:80].hex()}
    p = decode(resp)
    return {
        "status": one(p, 4),
        "remaining": one(p, 5),
        "translationId": one(p, 7),
        "lively": one(p, 10),
        "language": one(p, 8),
        "message": one(p, 9),
        "shouldRetry": one(p, 12),
        "url": (one(p, 1) or "")[:60],
    }


def fail_audio(s, url):
    """PUT /video-translation/fail-audio-js {video_url} — tell Yandex the client
    could not fetch the track, so the server should take it itself."""
    jb = json.dumps({"video_url": url}).encode()
    path = "/video-translation/fail-audio-js"
    h = s.headers(path, jb)
    h["Content-Type"] = "application/json"
    h["Accept"] = "application/json"
    code, resp = post(path, jb, h, method="PUT")
    return code, resp[:160].decode("utf-8", "replace")


def send_empty_audio(s, url, tid, file_id):
    """PUT /video-translation/audio {1: tid, 2: url, 6:{1: fileId, 2: <empty>}}."""
    body = p_str(1, str(tid)) + p_str(2, url) + p_str(6, p_str(1, file_id))
    path = "/video-translation/audio"
    code, resp = post(path, body, s.headers(path, body), method="PUT")
    return code, resp[:100].decode("utf-8", "replace")


def norm(target):
    if target.startswith("http"):
        return target
    return "https://www.youtube.com/watch?v=" + target


def main(argv):
    if len(argv) < 4:
        print(__doc__)
        return 2
    cmd, target, duration = argv[1], norm(argv[2]), float(argv[3])
    token = None
    langs = []
    help_subs = None
    help_video = None
    max_wait = 180
    first_flag = True
    no_lively = True
    for a in argv[4:]:
        if a.startswith("--lively="):
            token = a.split("=", 1)[1]
        elif a.startswith("--help-subs="):
            help_subs = a.split("=", 1)[1]
        elif a.startswith("--help-video="):
            help_video = a.split("=", 1)[1]
        elif a.startswith("--max-wait="):
            max_wait = int(a.split("=", 1)[1])
        elif a.startswith("--force-lively"):
            no_lively = False
        elif a.startswith("--first="):
            first_flag = a.split("=", 1)[1].lower() not in ("0", "false", "no")
        elif a.startswith("--"):
            continue
        else:
            langs.append(a)
    help_items = []
    if help_video:
        help_items.append(("video_file_url", help_video))
    if help_subs:
        help_items.append(("subtitles_file_url", help_subs))

    s = Session()
    if cmd == "cache":
        for lang in langs or ["auto"]:
            print(
                lang, json.dumps(cache(s, target, duration, lang), ensure_ascii=False)
            )
    elif cmd == "poll":
        t0 = time.time()
        first = True
        while True:
            r = translate(
                s,
                target,
                duration,
                (langs or ["auto"])[0],
                token,
                first=first,
                help_items=help_items or None,
                no_lively=no_lively,
            )
            print(f"+{time.time() - t0:5.1f}s " + json.dumps(r, ensure_ascii=False))
            first = False
            if r.get("status") in ("1", 1):
                break
            if r.get("status") in ("0", 0, "3", 3) and time.time() - t0 > 20:
                break
            if time.time() - t0 > max_wait:
                print("# timeout")
                break
            if r.get("http"):
                break
            time.sleep(5)
    elif cmd == "fix6":
        lang = (langs or ["en"])[0]
        fid = "fallback-empty-audio:video-translation:" + target.rsplit("v=", 1)[-1]
        for a in argv[4:]:
            if a.startswith("--fid="):
                fid = a.split("=", 1)[1]
        r = translate(s, target, duration, lang, token, first=True, no_lively=no_lively)
        print("translate " + json.dumps(r, ensure_ascii=False))
        tid = r.get("translationId")
        if str(r.get("status")) not in ("6", "2", "3"):
            return 0
        code, body = fail_audio(s, target)
        print(f"fail-audio-js {code} {body}")
        code, body = send_empty_audio(s, target, tid, fid)
        print(f"audio {code} {body} fid={fid}")
        t0 = time.time()
        while True:
            rr = translate(
                s, target, duration, lang, token, first=False, no_lively=True
            )
            print(f"+{time.time() - t0:5.1f}s " + json.dumps(rr, ensure_ascii=False))
            if str(rr.get("status")) in ("1", "5"):
                break
            if str(rr.get("status")) == "0":
                print("# FAILED (status 0)")
                break
            if time.time() - t0 > max_wait:
                print("# timeout")
                break
            time.sleep(5)
    elif cmd == "translate":
        for lang in langs or ["auto"]:
            print(
                lang,
                json.dumps(
                    translate(
                        s,
                        target,
                        duration,
                        lang,
                        token,
                        first=first_flag,
                        help_items=help_items or None,
                        no_lively=no_lively,
                    ),
                    ensure_ascii=False,
                ),
            )
    elif cmd == "compare":
        found = None
        for lang in langs or ["auto", "en", "ru"]:
            c = cache(s, target, duration, lang)
            print(lang, json.dumps(c, ensure_ascii=False))
            if (
                found is None
                and isinstance(c.get("default"), dict)
                and c["default"]["status"] == "finished"
            ):
                found = lang
        print("# translate probes:")
        for lang in ([found] if found else []) + ["auto", "en"]:
            print(
                lang,
                json.dumps(
                    translate(s, target, duration, lang, token), ensure_ascii=False
                ),
            )
    else:
        print(__doc__)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
