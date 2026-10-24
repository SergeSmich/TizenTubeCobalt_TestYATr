"""Быстрое определение языка оригинала ролика (0.3-0.6 с).

Зачем: на ТВ-сборке Cobalt нет `ytInitialPlayerResponse`, а yt-dlp на холодном
кэше отдаёт метаданные за 6-10 с. Из-за этого русский ролик с уже готовым
переводом в кэше Яндекса успевал заиграть переводом на несколько секунд, пока
язык не приходил с ПК. Здесь язык спрашивается напрямую у
`/youtubei/v1/player`.

Почему WEB + SAPISIDHASH: остальные клиенты (ANDROID_VR / IOS / ANDROID) и
голые куки на этом IP попадают в бот-гейт («Sign in to confirm you're not a
bot» -> playabilityStatus=LOGIN_REQUIRED). Проверено 24.10 на 4 роликах:
WEB + Cookie + `Authorization: SAPISIDHASH` = 24/24 OK за 0.25-0.55 с, включая
ролики, на которых все прочие клиенты получали LOGIN_REQUIRED.

Язык берём по `defaultAudioTrackIndex` -> `audioTracks[i].audioTrackId`
(например "ru.4" / "en-US.4"), фолбэк - `captionTracks[0].languageCode`.
Порядок дорожек в ответе нестабилен, поэтому индекс обязателен: брать [0]
нельзя (у 1EBYQr09KVg первая дорожка en при оригинале ru).
"""

import hashlib
import json
import os
import threading
import time
import urllib.error
import urllib.request

ORIGIN = "https://www.youtube.com"
API_KEY = "AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8"
CLIENT_NAME = "WEB"
CLIENT_VERSION = "2.20240101.00.00"
CLIENT_ID = "1"  # X-Youtube-Client-Name для WEB
UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
)

# video_id -> {"t": epoch, "ok": bool, "lang": "...", ...}
CACHE = {}
CACHE_LOCK = threading.Lock()
CACHE_TTL = 6 * 3600
FAIL_TTL = 120


# ------------------------------------------------------------------ cookies
def _parse_netscape(path):
    """Netscape jar -> (cookies dict для youtube.com, sapisid).

    Читаем мастер-файл ТОЛЬКО на чтение: здесь нет yt-dlp, который перезаписал
    бы jar, поэтому приватная копия (см. fill_audio._cookie_args) не нужна.
    """
    cookies = {}
    sapsid = ""
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as f:
            for line in f:
                line = line.rstrip("\r\n")
                if not line:
                    continue
                if line.startswith("#HttpOnly_"):
                    line = line[len("#HttpOnly_") :]
                elif line.startswith("#"):
                    continue
                parts = line.split("\t")
                if len(parts) < 7:
                    continue
                domain, name, value = parts[0], parts[5], parts[6]
                dom = domain[1:] if domain.startswith(".") else domain
                if dom != "youtube.com" and not dom.endswith(".youtube.com"):
                    continue
                cookies[name] = value
                if name == "SAPISID" and not sapsid:
                    sapsid = value
    except OSError:
        return {}, ""
    if not sapsid:
        sapsid = (
            cookies.get("__Secure-3PAPISID") or cookies.get("__Secure-1PAPISID") or ""
        )
    return cookies, sapsid


def _sapisidhash(sapsid):
    ts = int(time.time())
    digest = hashlib.sha1(f"{ts} {sapsid} {ORIGIN}".encode("utf-8")).hexdigest()
    return f"SAPISIDHASH {ts}_{digest}"


# ------------------------------------------------------------------- parser
def _lang_from_player(j):
    """(lang, info) из ответа player'а. lang = "" если язык не нашёлся."""
    caps = j.get("captions") or {}
    rend = caps.get("playerCaptionsTracklistRenderer") or {}
    tracks = rend.get("audioTracks") or []
    idx = rend.get("defaultAudioTrackIndex")
    if (
        isinstance(idx, bool)
        or not isinstance(idx, int)
        or not (0 <= idx < len(tracks))
    ):
        idx = 0
    ids = []
    for t in tracks:
        try:
            ids.append(str((t or {}).get("audioTrackId") or ""))
        except Exception:  # noqa: BLE001 - ответ может быть каким угодно
            ids.append("")
    atid = ids[idx] if ids else ""
    if atid.lower() in ("none", "null"):
        atid = ""
    lang = atid.split(".")[0] if atid else ""
    if not lang:
        ct = rend.get("captionTracks") or []
        if ct:
            lang = str((ct[0] or {}).get("languageCode") or "")
    vd = j.get("videoDetails") or {}
    info = {
        "audioTrackId": atid,
        "audioTracks": ids[:12],
        "audioIndex": idx,
        "captionLangs": [
            str((c or {}).get("languageCode") or "")
            for c in (rend.get("captionTracks") or [])[:6]
        ],
        "duration": vd.get("lengthSeconds") or "",
        "title": vd.get("title") or "",
    }
    return lang, info


# ------------------------------------------------------------------- detect
def detect(video_id, cookies_file=None, timeout=8):
    """{"ok","lang","duration","title","ms","err"} — с кэшем на 6 ч."""
    now = time.time()
    with CACHE_LOCK:
        hit = CACHE.get(video_id)
    if hit:
        age = now - hit.get("t", 0)
        if age < (CACHE_TTL if hit.get("ok") else FAIL_TTL):
            out = dict(hit)
            out["cached"] = True
            out["ms"] = 0
            return out

    t0 = time.time()
    res = _request(video_id, cookies_file, timeout)
    res["t"] = time.time()
    res["ms"] = int((res["t"] - t0) * 1000)
    with CACHE_LOCK:
        CACHE[video_id] = dict(res)
    return res


def _request(video_id, cookies_file, timeout):
    cookies, sapsid = ({}, "")
    if cookies_file and os.path.isfile(cookies_file):
        cookies, sapsid = _parse_netscape(cookies_file)
    headers = {
        "Content-Type": "application/json",
        "X-Youtube-Client-Name": CLIENT_ID,
        "X-Youtube-Client-Version": CLIENT_VERSION,
        "User-Agent": UA,
        "Accept-Language": "en",
        "Origin": ORIGIN,
        "Referer": ORIGIN + "/",
    }
    if cookies:
        headers["Cookie"] = "; ".join(f"{k}={v}" for k, v in cookies.items())
    if sapsid:
        headers["Authorization"] = _sapisidhash(sapsid)
    body = {
        "context": {
            "client": {
                "clientName": CLIENT_NAME,
                "clientVersion": CLIENT_VERSION,
                "hl": "en",
                "gl": "US",
                "utcOffsetMinutes": 0,
            }
        },
        "videoId": video_id,
        "contentCheckOk": True,
        "racyCheckOk": True,
    }
    req = urllib.request.Request(
        f"{ORIGIN}/youtubei/v1/player?key={API_KEY}",
        data=json.dumps(body).encode("utf-8"),
        headers=headers,
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            raw = r.read()
    except urllib.error.HTTPError as e:
        return {"ok": False, "lang": "", "err": f"http {e.code}"}
    except Exception as e:  # noqa: BLE001 - сеть/таймаут, решение принимает JS
        return {"ok": False, "lang": "", "err": f"{type(e).__name__}: {e}"[:160]}
    try:
        j = json.loads(raw.decode("utf-8", "replace"))
    except ValueError as e:
        return {"ok": False, "lang": "", "err": f"json: {e}"[:160]}
    st = ((j.get("playabilityStatus") or {}).get("status")) or ""
    if st != "OK":
        reason = ((j.get("playabilityStatus") or {}).get("reason")) or ""
        return {"ok": False, "lang": "", "err": f"playability={st} {reason}"[:160]}
    lang, info = _lang_from_player(j)
    out = {"ok": True, "videoId": video_id, "lang": lang}
    out.update(info)
    if not lang:
        out["ok"] = False
        out["err"] = "no audio/caption language in player response"
    return out


if __name__ == "__main__":  # ручная проверка: python yt_lang.py <videoId> [...]
    import sys

    jar = os.path.join(os.path.dirname(os.path.abspath(__file__)), "yt_cookies.txt")
    for vid in sys.argv[1:]:
        print(
            vid,
            json.dumps(
                detect(vid, jar if os.path.isfile(jar) else None), ensure_ascii=False
            ),
        )
