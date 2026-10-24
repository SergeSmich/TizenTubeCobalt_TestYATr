import subprocess, sys
vid="CX3QRLSTrtw"
url=f"https://www.youtube.com/watch?v={vid}"
for c in ["default","web_safari","tv","ios","android_vr","web_embedded","mweb","web"]:
    cmd=[sys.executable,"-m","yt_dlp","--skip-download","--no-warnings","--extractor-args",f"youtube:player_client={c}","-g","-f","bestaudio[ext=m4a]/bestaudio",url]
    try:
        r=subprocess.run(cmd,capture_output=True,text=True,timeout=120,encoding="utf8",errors="replace")
        out=(r.stdout or "").strip(); err=(r.stderr or "").strip()
        if r.returncode==0 and out:
            u=out.splitlines()[0]
            print(f"[{c}] OK host={u.split('/')[2]} len={len(u)} :: {u[:120]}")
        else:
            print(f"[{c}] FAIL rc={r.returncode} :: {err.replace(chr(10),' | ')[:200]}")
    except subprocess.TimeoutExpired:
        print(f"[{c}] TIMEOUT")
