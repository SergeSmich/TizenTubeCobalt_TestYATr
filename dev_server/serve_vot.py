#!/usr/bin/env python3
"""Local dev server for the patched userScript URL (192.168.1.186:8013).

Serves dev_server/vot.js with no-store caching so edits are picked up on
the next page load without rebuilding the APK.
"""

import http.server
import json
import os
import pathlib
import socketserver
import subprocess
import sys
import threading
import time
import traceback

ROOT = pathlib.Path(__file__).resolve().parent
PORT = 8013
CONFIG = ROOT / "vot_config.json"
SECRET = ROOT / "vot_secret.json"
COOKIES = ROOT / "yt_cookies.txt"

try:  # быстрый детектор языка (см. yt_lang.py); без него остаётся yt-dlp
    sys.path.insert(0, str(ROOT))
    import yt_lang
except Exception as _e:  # noqa: BLE001 - сервер должен подняться и без него
    yt_lang = None
    print(f"yt_lang unavailable: {_e} -> yt-dlp only", flush=True)

# videoId -> {"state": "run"|"ok"|"err", "res": {...}, "t": epoch}
FILL_JOBS = {}
FILL_LOCK = threading.Lock()

# videoId -> {"ok": bool, "lang": "en", "duration": "123", "title": "..."}
# The TV build has no ytInitialPlayerResponse, so the original language of a
# video can only be obtained here (yt-dlp metadata) and handed to the overlay.
META_CACHE = {}
# videoId, для которых метаданные уже грузятся в фоне (чтобы не плодить потоки).
META_PENDING = set()
# Один замок на оба словаря: HTTP-сервер многопоточный, а проверка
# «нет в кэше и нет в очереди» + постановка в очередь должны быть атомарны,
# иначе на один ролик запускается два тяжёлых yt-dlp.
META_LOCK = threading.Lock()


def _meta_worker(vid):
    # Быстрый путь (0.3-0.6 с): язык/длительность/название прямо из
    # /youtubei/v1/player с авторизацией (см. yt_lang). Язык нужен ДО старта
    # звука перевода, а холодный yt-dlp отвечает 6-10 с — за это время русский
    # ролик с готовым кэшем успевал заиграть переводом. yt-dlp остаётся
    # фолбэком: протухшие куки/бот-гейт/необычный ролик.
    try:
        fast = (
            yt_lang.detect(vid, str(COOKIES) if COOKIES.is_file() else None)
            if yt_lang
            else {}
        )
        if fast.get("ok") and fast.get("lang"):
            print(
                f"meta {vid} fast lang={fast['lang']} {fast.get('ms')}ms"
                f"{' cached' if fast.get('cached') else ''}",
                flush=True,
            )
            return {
                "ok": True,
                "videoId": vid,
                "lang": fast.get("lang") or "",
                "duration": str(fast.get("duration") or ""),
                "title": fast.get("title") or "",
            }
        print(f"meta {vid} fast: {fast.get('err')} -> yt-dlp", flush=True)
    except Exception as e:  # noqa: BLE001 - метаданные не должны падать
        print(f"meta {vid} fast ERR {e} -> yt-dlp", flush=True)

    args = [
        sys.executable,
        "-m",
        "yt_dlp",
        "--skip-download",
        "--no-playlist",
        "--no-warnings",
        "--js-runtimes",
        "node",
        "--extractor-args",
        "youtube:player_client=web_embedded",
        "--print",
        "%(language)s\t%(duration)s\t%(title)s",
    ]
    # yt-dlp rewrites whatever --cookies file it is given (and a bot-gate answer
    # even wipes the session cookies out of it), so the master jar exported by
    # hand must never be passed directly. fill_audio already owns that rule
    # (private per-run copy), so reuse it here instead of duplicating it.
    tmp_jar = None
    if COOKIES.is_file():
        try:
            import fill_audio

            cargs, _how, tmp_jar = fill_audio._cookie_args(str(COOKIES), None)
            args += cargs
        except Exception:  # noqa: BLE001 - never block metadata on the copy trick
            args += ["--cookies", str(COOKIES)]
    args.append("https://www.youtube.com/watch?v=" + vid)
    try:
        p = subprocess.run(
            args,
            capture_output=True,
            text=True,
            timeout=120,
            encoding="utf-8",
            errors="replace",
        )
        lines = (p.stdout or "").strip().splitlines()
        if not lines:
            return {
                "ok": False,
                "err": ((p.stderr or "no output")[-300:]).replace("\n", " "),
            }
        parts = lines[-1].split("\t")
        lang = (parts[0] or "").strip()
        if lang in ("NA", "None", "null"):
            lang = ""
        return {
            "ok": True,
            "videoId": vid,
            "lang": lang,
            "duration": parts[1] if len(parts) > 1 else "",
            "title": parts[2] if len(parts) > 2 else "",
        }
    except subprocess.TimeoutExpired:
        return {"ok": False, "err": "timeout"}
    except Exception as e:  # noqa: BLE001 - dev tool, report as text
        return {"ok": False, "err": str(e)[:200]}
    finally:
        if tmp_jar:
            try:
                os.remove(tmp_jar)
            except OSError:
                pass


def _meta_prefetch(vid):
    """Фоновая догрузка метаданных: /fill_status не должен ждать yt-dlp."""
    try:
        r = _meta_worker(vid)
        if r.get("ok"):
            with META_LOCK:
                META_CACHE[vid] = r
    except Exception:  # noqa: BLE001 - dev tool
        pass
    finally:
        with META_LOCK:
            META_PENDING.discard(vid)


def _resolve_fill_meta(vid, duration, lang):
    """Yandex refuses translate with duration=0 (HTTP 400), and a wrong language
    shard leaves the TV polling status=6 forever. The TV normally sends both, but
    a manual "fill" from the panel has neither: recover them from the meta cache
    or from one yt-dlp metadata run (no media download)."""
    dur = 0.0
    try:
        dur = float(duration or 0)
    except Exception:  # noqa: BLE001 - dev tool
        dur = 0.0
    lng = str(lang or "").strip()
    if dur > 0 and lng:
        return dur, lng
    with META_LOCK:
        cached = dict(META_CACHE.get(vid) or {})
    if cached:
        if dur <= 0:
            try:
                dur = float(cached.get("duration") or 0)
            except Exception:  # noqa: BLE001 - dev tool
                dur = 0.0
        lng = lng or str(cached.get("lang") or "").strip()
    if dur > 0 and lng:
        return dur, lng
    try:
        meta = _meta_worker(vid)
    except Exception:  # noqa: BLE001 - dev tool
        return dur, lng
    if meta and meta.get("ok"):
        with META_LOCK:
            META_CACHE[vid] = meta
    if dur <= 0:
        try:
            dur = float((meta or {}).get("duration") or 0)
        except Exception:  # noqa: BLE001 - dev tool
            dur = 0.0
    lng = lng or str((meta or {}).get("lang") or "").strip()
    return dur, lng


def _fill_worker(vid, duration, tid, lang):
    """Runs in its own thread: download the audio on the PC and hand it to
    Yandex, so the TV's own translationId can reach status=1."""
    cfg = merged_config()
    try:
        import fill_audio

        duration, lang = _resolve_fill_meta(vid, duration, lang)
        if duration <= 0:
            # Yandex answers 400 on duration=0, which used to surface as the
            # cryptic "no translationId from translate". Say what is wrong.
            raise RuntimeError("duration unknown: YouTube meta unavailable")
        res = fill_audio.fill(
            vid,
            duration,
            # The TV always knows better: it polls one specific language shard
            # (state.lang, "auto" after the alt-shard retry). The job id is per
            # shard, so filling another shard leaves the TV at status 6 forever.
            lang or cfg.get("fillLang") or "en",
            cfg.get("token") or None,
            tid or None,
            browser=cfg.get("cookiesBrowser") or "chrome",
            cookies=str(COOKIES) if COOKIES.is_file() else None,
            fmt=cfg.get("fillFormat") or "140/bestaudio[ext=m4a]",
            max_wait=int(cfg.get("fillMaxWait") or 240),
            log=lambda m: print("votfill:", m, flush=True),
        )
    except Exception as e:
        traceback.print_exc()
        res = {
            "ok": False,
            "status": "",
            "tid": str(tid or ""),
            "how": "",
            "error": f"{type(e).__name__}: {e}",
        }
    with FILL_LOCK:
        FILL_JOBS[vid] = {
            "state": "ok" if res.get("ok") else "err",
            "res": res,
            "t": time.time(),
        }
    print(
        f"votfill: done id={vid} ok={res.get('ok')} status={res.get('status')} "
        f"error={res.get('error')!r}",
        flush=True,
    )


def start_fill(vid, duration, tid, lang):
    with FILL_LOCK:
        cur = FILL_JOBS.get(vid)
        # A job may legitimately run for minutes (download + chunks + synthesis
        # poll). Only ignore duplicates while it is fresh: a stuck "run" from a
        # previous attempt must not block the user's next try forever.
        if cur and cur.get("state") == "run":
            limit = int(merged_config().get("fillMaxWait") or 240) + 180
            if time.time() - float(cur.get("t") or 0) < limit:
                return False
            print(f"votdev: fill job {vid} looks stale, restarting", flush=True)
        FILL_JOBS[vid] = {"state": "run", "res": {}, "t": time.time()}
    threading.Thread(
        target=_fill_worker, args=(vid, duration, tid, lang), daemon=True
    ).start()
    return True


def merged_config():
    cfg = {}
    try:
        cfg = json.loads(CONFIG.read_text(encoding="utf-8") or "{}")
    except Exception:
        cfg = {}
    try:
        tok = json.loads(SECRET.read_text(encoding="utf-8") or "{}").get("token") or ""
    except Exception:
        tok = ""
    cfg["token"] = tok
    return cfg


TOKEN_PAGE = """<!doctype html>
<html lang="ru"><meta charset="utf-8">
<title>VOT: РЅР°СЃС‚СЂРѕР№РєРё Р¶РёРІС‹С… РіРѕР»РѕСЃРѕРІ</title>
<style>
 body{font:16px/1.5 system-ui,Segoe UI,Arial;margin:24px;max-width:760px}
 input[type=text],textarea{width:100%;padding:8px;font:14px monospace;box-sizing:border-box}
 button{padding:10px 18px;font-size:16px;margin-top:10px}
 .hint{color:#555;font-size:14px}
 #msg{margin-top:12px;font-weight:600}
</style>
<h2>Yandex VOT вЂ” Р¶РёРІС‹Рµ РіРѕР»РѕСЃР°</h2>
<p class="hint">1. РћС‚РєСЂРѕР№С‚Рµ СЃСЃС‹Р»РєСѓ Р°РІС‚РѕСЂРёР·Р°С†РёРё, РІРѕР№РґРёС‚Рµ РІ РЇРЅРґРµРєСЃ Рё СЃРєРѕРїРёСЂСѓР№С‚Рµ <b>access_token</b>
РёР· Р°РґСЂРµСЃРЅРѕР№ СЃС‚СЂРѕРєРё (С‡Р°СЃС‚СЊ РїРѕСЃР»Рµ <code>access_token=</code> Рё РґРѕ СЃР»РµРґСѓСЋС‰РµРіРѕ <code>&amp;</code>):</p>
<p><a target="_blank" href="https://oauth.yandex.ru/authorize?client_id=1666fbe22f3749c581002a4f97b2592d&response_type=token">
https://oauth.yandex.ru/authorize?client_id=1666fbe22f3749c581002a4f97b2592d&amp;response_type=token</a></p>
<p class="hint">РўРѕРєРµРЅ РЅСѓР¶РµРЅ С‚РѕР»СЊРєРѕ РґР»СЏ В«Р¶РёРІС‹С… РіРѕР»РѕСЃРѕРІВ». Р‘РµР· РЅРµРіРѕ РїРµСЂРµРІРѕРґ СЂР°Р±РѕС‚Р°РµС‚ РѕР±С‹С‡РЅС‹Рј РіРѕР»РѕСЃРѕРј.</p>
<label>access_token<br><textarea id="token" rows="4" placeholder="y0_AgAAAA..."></textarea></label>
<p><label><input type="checkbox" id="lively"> РІРєР»СЋС‡РёС‚СЊ Р¶РёРІС‹Рµ РіРѕР»РѕСЃР° (lively)</label></p>
<label>worker-РїСЂРѕРєСЃРё (РЅРµРѕР±СЏР·Р°С‚РµР»СЊРЅРѕ)<br><input type="text" id="worker" placeholder="vot-worker.eu.cc"></label>
<p><label>СЃС‚СЂР°С‚РµРіРёСЏ РїСЂРё status=6 (РЅСѓР¶РЅР° Р·Р°РіСЂСѓР·РєР° Р·РІСѓРєР°)<br>
<select id="faMode">
  <option value="audio">audio вЂ” РїСѓСЃС‚РѕР№ Р·РІСѓРє СЃ РјР°СЂРєРµСЂРѕРј SmartTube (РїРѕ СѓРјРѕР»С‡Р°РЅРёСЋ)</option>
  <option value="votjs">votjs вЂ” РїСѓСЃС‚РѕР№ Р·РІСѓРє СЃ РјР°СЂРєРµСЂРѕРј vot.js</option>
  <option value="skip">skip вЂ” РЅРµ РІРјРµС€РёРІР°С‚СЊСЃСЏ, С‚РѕР»СЊРєРѕ РїРѕР»Р»РёРЅРі</option>
</select></label></p>
<button id="save">РЎРѕС…СЂР°РЅРёС‚СЊ</button>
<button id="clear">РћС‡РёСЃС‚РёС‚СЊ С‚РѕРєРµРЅ</button>
<div id="msg"></div>
<script>
function load(){
  fetch('/vot_config.json?b='+Date.now()).then(r=>r.json()).then(c=>{
    document.getElementById('lively').checked = !!c.lively;
    document.getElementById('worker').value = c.worker || '';
    document.getElementById('token').value = c.token || '';
    document.getElementById('faMode').value = c.faMode || 'audio';
  }).catch(()=>{});
}
function save(){
  var body = {
    token: document.getElementById('token').value.trim(),
    lively: document.getElementById('lively').checked,
    worker: document.getElementById('worker').value.trim(),
    mediaProxy: '', proxyMode: 'off',
    faMode: document.getElementById('faMode').value
  };
  fetch('/vot_config', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body)})
    .then(r=>r.text()).then(t=>{
      document.getElementById('msg').textContent = t.indexOf('ok')>=0
        ? 'РЎРѕС…СЂР°РЅРµРЅРѕ. Р§РµСЂРµР· ~8 СЃРµРєСѓРЅРґ РјРѕСЃС‚ РЅР° С‚РµР»РµРІРёР·РѕСЂРµ РїРѕРґС…РІР°С‚РёС‚ РЅР°СЃС‚СЂРѕР№РєРё.'
        : 'РћС€РёР±РєР°: '+t;
    }).catch(e=>{document.getElementById('msg').textContent='РћС€РёР±РєР°: '+e;});
}
document.getElementById('save').onclick = save;
document.getElementById('clear').onclick = function(){
  document.getElementById('token').value = '';
  save();
};
load();
</script>
</html>
"""


class Handler(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def _send(self, code, ctype, body):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, PUT, OPTIONS")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def do_GET(self):
        if self.path.startswith("/ping"):
            self._send(200, "text/plain; charset=utf-8", b"pong")
            return
        if self.path.startswith("/token"):
            self._send(200, "text/html; charset=utf-8", TOKEN_PAGE.encode("utf-8"))
            return
        if self.path.startswith("/fill_status"):
            vid = ""
            if "videoId=" in self.path:
                vid = self.path.split("videoId=", 1)[1].split("&")[0]
            with FILL_LOCK:
                job = dict(FILL_JOBS.get(vid) or {"state": "none", "res": {}, "t": 0})
            # Язык оригинала для пункта «не переводить с языка»: на ТВ нет
            # ytInitialPlayerResponse, а прямой GET к ПК из HTTPS-страницы не
            # доходит (mixed content). Мост проксирует именно /fill_status,
            # поэтому метаданные отдаём здесь: из кэша сразу, иначе — фоном.
            if vid:
                with META_LOCK:
                    meta = META_CACHE.get(vid)
                    need_prefetch = meta is None and vid not in META_PENDING
                    if need_prefetch:
                        META_PENDING.add(vid)
                # Поток запускаем вне замка: старт thread'а не должен ждать.
                if need_prefetch:
                    threading.Thread(
                        target=_meta_prefetch, args=(vid,), daemon=True
                    ).start()
                if meta and meta.get("ok"):
                    job["lang"] = meta.get("lang") or ""
                    job["title"] = meta.get("title") or ""
            self._send(
                200,
                "application/json; charset=utf-8",
                json.dumps(job, ensure_ascii=False).encode("utf-8"),
            )
            return
        if self.path.startswith("/meta"):
            vid = ""
            if "videoId=" in self.path:
                vid = self.path.split("videoId=", 1)[1].split("&")[0].strip()
            if not vid:
                self._send(
                    400,
                    "application/json; charset=utf-8",
                    b'{"ok":false,"err":"videoId required"}',
                )
                return
            with META_LOCK:
                cached = META_CACHE.get(vid)
            if cached is None:
                # yt-dlp takes a few seconds: the TV thread waits, the server
                # is threaded so other requests keep flowing.
                cached = _meta_worker(vid)
                with META_LOCK:
                    META_CACHE[vid] = cached
            self._send(
                200,
                "application/json; charset=utf-8",
                json.dumps(cached, ensure_ascii=False).encode("utf-8"),
            )
            return
        if self.path.startswith("/vot_config.json"):
            # Runtime settings for the in-app bridge (lively / worker / faMode)
            # merged with the OAuth token, which lives in its own file so that
            # editing vot_config.json never destroys the token.
            self._send(
                200,
                "application/json; charset=utf-8",
                json.dumps(merged_config(), ensure_ascii=False).encode("utf-8"),
            )
            return
        else:
            # One URL for the whole overlay: the UI layer first, then the main
            # script. The native userscript injection only knows a single URL, so
            # concatenating here keeps "one file to inject" without a build step.
            body = b""
            for name in ("vot_ui.js", "vot.js", "vot_net.js"):
                p = ROOT / name
                try:
                    body += p.read_bytes() + b"\n;\n"
                except OSError as e:
                    # vot_net.js — необязательный диагностический зонд.
                    if name == "vot.js":
                        self._send(404, "text/plain", str(e).encode())
                        return
            self._send(200, "application/javascript; charset=utf-8", body)
            return

    def do_OPTIONS(self):
        self._send(204, "text/plain", b"")

    def do_POST(self):
        length = int(self.headers.get("Content-Length") or 0)
        data = self.rfile.read(length) if length else b""
        print(
            f"votdev: POST {self.path} {len(data)}B ct={self.headers.get('Content-Type')}",
            flush=True,
        )
        if self.path.startswith("/log"):
            print("votdev-js-log:", data.decode("utf-8", "replace")[:2000], flush=True)
            self._send(200, "text/plain", b"ok")
            return
        if self.path.startswith("/fill"):
            # TV asks the PC to feed Yandex the source audio for a video it
            # cannot download itself. Returns immediately; progress goes to
            # /fill_status?videoId=...
            try:
                obj = json.loads(data.decode("utf-8") or "{}")
                vid = str(obj.get("videoId") or obj.get("id") or "").strip()
                if not vid:
                    raise ValueError("videoId required")
                queued = start_fill(
                    vid,
                    float(obj.get("duration") or 0),
                    str(obj.get("tid") or ""),
                    str(obj.get("lang") or ""),
                )
                print(
                    f"votdev: fill queued={queued} id={vid} "
                    f"dur={obj.get('duration')} tid={obj.get('tid')}",
                    flush=True,
                )
                self._send(
                    200,
                    "application/json; charset=utf-8",
                    json.dumps({"queued": queued, "videoId": vid}).encode(),
                )
            except Exception as e:
                self._send(400, "text/plain", str(e).encode())
            return
        if self.path.startswith("/vot_config"):
            try:
                obj = json.loads(data.decode("utf-8") or "{}")
                # The secret lives in a dedicated file: rewriting the public
                # settings can never wipe it. Distinguish "field absent" (leave
                # the token alone) from "field empty" (explicit clear).
                token = obj.pop("token", None)
                if token is not None:
                    token = str(token).strip()
                    SECRET.write_text(
                        json.dumps({"token": token}) + "\n", encoding="utf-8"
                    )
                (ROOT / "vot_config.json").write_text(
                    json.dumps(obj, ensure_ascii=False, indent=2) + "\n",
                    encoding="utf-8",
                )
                print(
                    f"votdev: config saved lively={obj.get('lively')} "
                    f"worker={obj.get('worker')!r} faMode={obj.get('faMode')!r} "
                    f"tokenLen={-1 if token is None else len(token)}",
                    flush=True,
                )
                self._send(200, "application/json", b'{"ok":1}')
            except Exception as e:
                self._send(400, "text/plain", str(e).encode())
            return
        self._send(404, "text/plain", b"no handler")

    def log_message(self, fmt, *args):
        print(f"votdev: {self.client_address[0]} {fmt % args}", flush=True)


class ThreadingServer(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True

    def handle_error(self, request, client_address):
        """ТВ закрывает keep-alive соединения (WinError 10054) — это норма,
        а socketserver по умолчанию печатает на каждый случай полный трейсбек."""
        import sys as _sys

        exc = _sys.exc_info()[1]
        if isinstance(
            exc, (ConnectionResetError, ConnectionAbortedError, BrokenPipeError)
        ):
            return
        super().handle_error(request, client_address)


if __name__ == "__main__":
    with ThreadingServer(("0.0.0.0", PORT), Handler) as srv:
        print(f"votdev: serving {ROOT} on 0.0.0.0:{PORT}", flush=True)
        srv.serve_forever()
