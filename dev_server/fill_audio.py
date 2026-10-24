#!/usr/bin/env python3
"""PC-side audio filler for Yandex VOT.

The TV cannot give Yandex the source audio: every InnerTube client answers
LOGIN_REQUIRED, and the googlevideo urls it does hand out are refused with 403
because nothing on the TV can mint a poToken (the player itself plays through
SABR/MSE, where the token lives inside the native stack).

So the PC does it instead: yt-dlp downloads the original audio track, and this
module uploads it to api.browser.yandex.ru exactly like SmartTube does
(`web_api_steal_sig_and_n` fileId, 5295308-byte chunks). After the upload the
Yandex job for that translationId finishes on its own and the TV's poll turns
into status=1.

CLI (used for one-off testing):
  python fill_audio.py <videoId|url> --duration=1736 [--lang=en] [--token=...]
      [--tid=...] [--browser=chrome] [--cookies=yt_cookies.txt]
      [--format=140/bestaudio[ext=m4a]] [--max-wait=240]
"""

import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
import uuid

import vot_probe as vp

AUDIO_CHUNK = 5295308
DOWNLOAD_TYPE = "web_api_steal_sig_and_n"
AUDIO_PATH = "/video-translation/audio"
# Tried in order: the embedded clients still return plain googlevideo urls,
# the regular web/tv/android ones are SABR-only for most videos now.
DEFAULT_CLIENTS = ("web_embedded", "tv_embedded", "web_safari", "default")
# Yandex converts AAC/mp4 only; opus/webm uploads are accepted (http 200) and
# then ignored, leaving the translation at status=6 forever.
ACCEPTED_EXT = (".m4a", ".mp4", ".aac")
# yt-dlp prints these when the cookie jar carries no login: it is an account
# problem, so no other client/format can help (see BOT_GATE use in download()).
BOT_GATE = (
    "Sign in to confirm you're not a bot",
    "cookies for the authentication",
)


# ---------------------------------------------------------------- yt-dlp
def _cookie_args(cookies_file, browser):
    """--cookies wins; otherwise let yt-dlp read (and dump) the browser jar.

    Returns (args, how, temp_jar): temp_jar is our private copy and must be
    removed by the caller when the run is over.
    """
    if (
        cookies_file
        and os.path.isfile(cookies_file)
        and os.path.getsize(cookies_file) > 0
    ):
        # yt-dlp writes the jar back on exit, and a bot-gate answer comes with
        # Set-Cookie that wipes the session (proved 24.10: after one failed run
        # the exported jar lost SID/LOGIN_INFO and every download turned into
        # "Sign in to confirm you're not a bot"). Work on a copy, so a bad video
        # can never destroy the login the owner exported by hand.
        #
        # The copy is per run (pid + random) because two /fill jobs may run at
        # once: sharing one file let one job's bot-gate Set-Cookie leak into the
        # other job's jar.
        try:
            tmp_dir = os.path.join(tempfile.gettempdir(), "votfill")
            os.makedirs(tmp_dir, exist_ok=True)
            tmp = os.path.join(
                tmp_dir, f"yt_cookies_run_{os.getpid()}_{uuid.uuid4().hex[:6]}.txt"
            )
            shutil.copyfile(cookies_file, tmp)
            return (
                ["--cookies", tmp],
                "file:" + os.path.basename(cookies_file) + " (copy)",
                tmp,
            )
        except OSError as e:
            print(f"fill: cookie copy failed ({e}), using the file as is", flush=True)
        return (
            ["--cookies", cookies_file],
            "file:" + os.path.basename(cookies_file),
            None,
        )
    if browser:
        # yt-dlp dumps the jar into --cookies on exit, so one successful run
        # with the browser closed is enough for every later run.
        args = ["--cookies-from-browser", browser]
        if cookies_file:
            args += ["--cookies", cookies_file]
        return args, "browser:" + browser, None
    return [], "none", None


def download(
    video_url,
    out_dir,
    cookies_file,
    browser,
    fmt="140/bestaudio[ext=m4a]",
    log=print,
    timeout=600,
    clients=None,
    js_runtime="node",
):
    """Fetch the original audio track. Returns (path, itag, size).

    The cookie jar is only ever used through a private per-run copy: yt-dlp
    rewrites whatever file it is given, and a bot-gate answer wipes the login
    from it, so the exported master jar must stay untouched.
    """
    cargs, how, tmp_jar = _cookie_args(cookies_file, browser)
    try:
        return _download_with(
            video_url, out_dir, cargs, how, fmt, log, timeout, clients, js_runtime
        )
    finally:
        if tmp_jar:
            try:
                os.remove(tmp_jar)
            except OSError:
                pass


def _download_with(
    video_url,
    out_dir,
    cargs,
    how,
    fmt,
    log,
    timeout,
    clients,
    js_runtime,
):
    """Inner half of download(): the format x client ladder.

    Two things are mandatory on this PC (both proved the hard way):
      * cookies - without them every client answers "Sign in to confirm
        you're not a bot";
      * --js-runtimes node - yt-dlp 2026 needs the EJS challenge solver to
        unwrap the n parameter, otherwise all urls are dropped;
      * player_client=web_embedded - "web" and friends are SABR-only now
        (yt-dlp issue 12482), the embedded clients still hand out plain urls.
    """
    os.makedirs(out_dir, exist_ok=True)
    tpl = os.path.join(out_dir, "%(id)s.%(ext)s")
    last = ""
    # Format-major: try the requested AAC format on every client before falling
    # back to a looser m4a selector ("Requested format is not available" just
    # means this client does not offer 140, not that the track is gone).
    fmts = []
    for f in (fmt, "140", "bestaudio[ext=m4a]"):
        if f and f not in fmts:
            fmts.append(f)
    todo = [(f, c) for f in fmts for c in (clients or DEFAULT_CLIENTS)]
    refused = set()
    gate = 0
    for fmt, client in todo:
        if fmt in refused:
            continue
        cmd = (
            [
                sys.executable,
                "-m",
                "yt_dlp",
                "-f",
                fmt,
                "--no-playlist",
                "--no-part",
                "--no-warnings",
                "--no-progress",
                "--retries",
                "3",
                "--fragment-retries",
                "3",
                "--js-runtimes",
                js_runtime,
                "--extractor-args",
                "youtube:player_client=" + client,
                "-o",
                tpl,
                "--print",
                "after_move:filepath",
                "--print",
                "after_move:format_id",
            ]
            + cargs
            + [video_url]
        )
        log(f"fill: yt-dlp start client={client} fmt={fmt} cookies={how}")
        try:
            p = subprocess.run(
                cmd,
                capture_output=True,
                text=True,
                timeout=timeout,
                encoding="utf-8",
                errors="replace",
            )
        except subprocess.TimeoutExpired:
            last = f"timeout after {timeout}s"
            continue
        out = (p.stdout or "").strip().splitlines()
        if p.returncode != 0 or len(out) < 2:
            last = (p.stderr or p.stdout or "").strip().replace("\n", " ")[-300:]
            log(f"fill: yt-dlp client={client} failed: {last}")
            # "Sign in to confirm you're not a bot" is the cookie jar talking, not
            # the client: every remaining client answers the same (proved on
            # DaeWIAqoEfI 24.10 — web_embedded/tv/android_vr/web_safari, and with
            # no cookies at all the answer is byte-identical). Give up after the
            # second hit instead of walking the whole format x client ladder,
            # which kept the TV waiting ~40-60 s for a verdict we already knew.
            if any(m in last for m in BOT_GATE):
                gate += 1
                log(
                    f"fill: bot gate {gate} client={client} -> cookie jar is not logged in"
                )
                if gate >= 2:
                    raise RuntimeError(
                        "нужен вход в YouTube: куки не авторизованы "
                        "(Sign in to confirm you're not a bot)"
                    )
            continue
        path, fid = out[-2].strip(), out[-1].strip()
        if not os.path.isfile(path):
            last = "no file at " + path
            continue
        m = re.match(r"\d+", fid)
        itag = int(m.group()) if m else 0
        ext = os.path.splitext(path)[1].lower()
        if ext not in ACCEPTED_EXT:
            # Hard-won: Yandex answers http 200 for an opus/webm upload and then
            # never starts synthesis - the tid sits at status=6 forever. Only the
            # AAC/mp4 track (itag 140) actually converts, so never accept this
            # container and never retry the same format on other clients.
            last = f"container {ext} refused by Yandex (itag={itag}, fmt={fmt})"
            log(f"fill: {last}")
            refused.add(fmt)
            try:
                os.remove(path)
            except OSError:
                pass
            continue
        size = os.path.getsize(path)
        log(
            f"fill: downloaded client={client} itag={itag} bytes={size} "
            f"path={os.path.basename(path)}"
        )
        return path, itag, size
    raise RuntimeError("yt-dlp: " + (last or "no client worked"))


# ---------------------------------------------------------------- upload
def file_id(itag, size):
    return json.dumps(
        {
            "downloadType": DOWNLOAD_TYPE,
            "itag": int(itag),
            "minChunkSize": AUDIO_CHUNK,
            "fileSize": str(size),
        },
        separators=(",", ":"),
    )


def _put(session, video_url, tid, body):
    return vp.post(AUDIO_PATH, body, session.headers(AUDIO_PATH, body), method="PUT")


def upload(session, video_url, tid, data, itag, log=print):
    """Upload the whole track, chunked like SmartTube (0-based chunk index)."""
    fid = file_id(itag, len(data))
    total = max(1, (len(data) + AUDIO_CHUNK - 1) // AUDIO_CHUNK)
    if total <= 1:
        body = (
            vp.p_str(1, str(tid))
            + vp.p_str(2, video_url)
            + vp.p_str(6, vp.p_str(1, fid) + vp.p_str(2, data))
        )
        code, resp = _put(session, video_url, tid, body)
        log(f"fill: upload single bytes={len(data)} http={code} {resp[:80]!r}")
        if code != 200:
            raise RuntimeError(f"audio upload HTTP {code}: {resp[:120]!r}")
        return 1
    for i in range(total):
        chunk = data[i * AUDIO_CHUNK : (i + 1) * AUDIO_CHUNK]
        part = vp.p_int(1, i) + vp.p_str(2, chunk)
        wrap = (
            vp.p_str(1, part) + vp.p_int(2, total) + vp.p_str(3, fid) + vp.p_int(4, 1)
        )
        body = vp.p_str(1, str(tid)) + vp.p_str(2, video_url) + vp.p_str(4, wrap)
        code, resp = _put(session, video_url, tid, body)
        log(f"fill: upload chunk {i + 1}/{total} bytes={len(chunk)} http={code}")
        if code != 200:
            raise RuntimeError(
                f"audio chunk {i + 1}/{total} HTTP {code}: {resp[:120]!r}"
            )
    return total


# ---------------------------------------------------------------- orchestration
def _translate(session, url, duration, lang, token, first):
    return vp.translate(
        session, url, duration, lang, lively_token=token or None, first=first
    )


def fill(
    video_id_or_url,
    duration,
    lang="en",
    token=None,
    tid=None,
    browser="chrome",
    cookies=None,
    fmt="140/bestaudio[ext=m4a]",
    max_wait=240,
    log=print,
):
    """Make Yandex translate the video by feeding it the real audio.

    Returns {"ok": bool, "status": str, "tid": str, "how": str, "error": str}.
    Everything is synchronous; the caller runs it in its own thread.
    """
    url = vp.norm(video_id_or_url)
    video_id = (
        url.split("v=")[-1].split("&")[0] if "v=" in url else url.rsplit("/", 1)[-1]
    )
    res = {"ok": False, "status": "", "tid": str(tid or ""), "how": "", "error": ""}

    session = vp.Session()

    def kick(tag):
        r = _translate(session, url, duration, lang, token, True)
        st = str(r.get("status") or "")
        nt = str(r.get("translationId") or "")
        res["status"] = st
        log(
            f"fill: kick {tag} -> status={st} tid={nt} rem={r.get('remaining')} "
            f"msg={r.get('message')!r}"
        )
        return st, nt

    if not tid:
        st, nt = kick("first")
        res["tid"] = nt
        if st in ("1", "5"):
            res.update(ok=True, how="cache")
            return res
        tid = nt
    if not tid:
        res["error"] = "no translationId from translate"
        return res

    out_dir = os.path.join(tempfile.gettempdir(), "votfill")
    path, itag, size = download(url, out_dir, cookies, browser, fmt, log=log)
    with open(path, "rb") as fh:
        data = fh.read()
    try:
        os.remove(path)
    except OSError:
        pass

    # Re-arm Yandex's "audio requested" window right before the bytes go up.
    # The countdown it returns in `remaining` never restarts, and an upload that
    # lands after the window closed is accepted (http 200 on every chunk) and
    # then ignored forever - that is exactly how EXVnDVrJlBU (proper itag 140,
    # 11.7 MB, 3 chunks 200) sat at status=6 until the job expired.
    #
    # Important: the job is per (video, language shard), NOT global. A kick made
    # with the wrong `lang` opens a window on a different job, and the TV keeps
    # polling its own one forever (A_diEEpAfpM: TV was on shard "auto", fill ran
    # with "en", upload + status=1 landed in the en job, TV still saw 6).
    tv_tid = str(tid or "")
    st, nt = kick("before upload")
    if st in ("1", "5"):
        res.update(ok=True, tid=nt or tid, how="cache after kick")
        return res
    if tv_tid and nt and nt != tv_tid:
        log(
            f"fill: WARN kick tid={nt} != tv tid={tv_tid} "
            f"(shard mismatch, lang={lang}) - uploading into the TV job"
        )
    res["tid"] = tid
    upload(session, url, tid, data, itag, log=log)
    res["how"] = f"audio itag={itag} bytes={size}"

    deadline = time.time() + max_wait
    retried = False
    reuploaded = False
    stuck_since = 0.0
    while time.time() < deadline:
        time.sleep(5)
        r = _translate(session, url, duration, lang, token, False)
        st = str(r.get("status") or "")
        res["status"] = st
        log(
            f"fill: poll status={st} rem={r.get('remaining')} "
            f"lively={r.get('lively')} msg={r.get('message')!r}"
        )
        if st in ("1", "5"):
            res["ok"] = True
            res["tid"] = str(r.get("translationId") or tid)
            return res
        if st == "6":
            # Still "audio requested": either the window was closed when we
            # uploaded, or the server dropped the bytes. One re-arm plus a
            # second upload of the very same buffer is cheap and fixes it.
            if not stuck_since:
                stuck_since = time.time()
            if not reuploaded and time.time() - stuck_since > 45:
                reuploaded = True
                st2, nt2 = kick("re-arm")
                if st2 in ("1", "5"):
                    res.update(
                        ok=True, status=st2, tid=nt2 or tid, how=res["how"] + " (cache)"
                    )
                    return res
                if nt2 and tv_tid and nt2 != tv_tid:
                    # The server keeps answering on a different job: no upload
                    # will ever reach the one the TV polls, so fail fast instead
                    # of burning minutes of the viewer's time.
                    res["error"] = (
                        f"shard mismatch: tv tid={tv_tid} kick tid={nt2} lang={lang}"
                    )
                    log("fill: " + res["error"])
                    return res
                if nt2:
                    tid = nt2
                    res["tid"] = tid
                log("fill: still 6 -> second upload into the fresh job")
                upload(session, url, tid, data, itag, log=log)
                stuck_since = time.time()
                deadline = max(deadline, time.time() + 90)
            continue
        if st != "0":
            continue
        # status 0 right after the upload means the server did not like the job
        # we fed: the tid came from the TV, i.e. from another session. Create a
        # fresh job ourselves and push the very same bytes into it - Yandex keys
        # its cache by video+lang, so the TV's next poll then lands on status=1.
        if not tv_tid or retried:
            res["error"] = str(r.get("message") or "status 0")
            return res
        retried = True
        log("fill: server refused the TV tid, opening a fresh job")
        r2 = _translate(session, url, duration, lang, token, True)
        st2 = str(r2.get("status") or "")
        new_tid = str(r2.get("translationId") or "")
        log(f"fill: fresh translate -> status={st2} tid={new_tid}")
        if st2 in ("1", "5"):
            res.update(
                ok=True,
                status=st2,
                tid=new_tid,
                how=res["how"] + " (cache after fresh job)",
            )
            return res
        if not new_tid or new_tid == tid:
            res["error"] = "server refused the audio"
            return res
        tid = new_tid
        res["tid"] = tid
        upload(session, url, tid, data, itag, log=log)
        deadline = time.time() + max_wait
    res["error"] = "timeout waiting for the translation"
    return res


def main(argv):
    if len(argv) < 2:
        print(__doc__)
        return 2
    target = argv[1]
    opts = {
        "duration": 0.0,
        "lang": "en",
        "token": None,
        "tid": None,
        "browser": "chrome",
        "cookies": None,
        "fmt": "140/bestaudio[ext=m4a]",
        "max_wait": 240,
    }
    for a in argv[2:]:
        if "=" not in a:
            continue
        k, v = a.split("=", 1)
        k = k.lstrip("-")
        if k in ("duration", "max_wait"):
            opts[k] = float(v)
        elif k == "format":
            opts["fmt"] = v
        elif k in opts:
            opts[k] = v
    if not opts["duration"]:
        # Duration only changes the server's estimate; 0 is accepted.
        print("# no --duration= given, using 0")
    res = fill(
        target,
        opts["duration"],
        opts["lang"],
        opts["token"],
        opts["tid"],
        opts["browser"],
        opts["cookies"],
        opts["fmt"],
        int(opts["max_wait"]),
        log=lambda m: print(m, flush=True),
    )
    print("RESULT " + json.dumps(res, ensure_ascii=False))
    return 0 if res["ok"] else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv))
