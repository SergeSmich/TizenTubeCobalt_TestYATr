import subprocess, sys
def run(vid, client=None):
    cmd=[sys.executable,"-m","yt_dlp","--skip-download","--no-warnings"]
    if client: cmd+=["--extractor-args",f"youtube:player_client={client}"]
    cmd+=["-g","-f","bestaudio[ext=m4a]/bestaudio",f"https://www.youtube.com/watch?v={vid}"]
    r=subprocess.run(cmd,capture_output=True,text=True,timeout=150,encoding="utf8",errors="replace")
    if r.returncode==0 and r.stdout.strip():
        u=r.stdout.strip().splitlines()[0]
        return f"OK host={u.split('/')[2]} len={len(u)} :: {u[:110]}"
    e=(r.stderr or "").replace("\n"," | ")
    return "FAIL :: "+e[:150]
print("CONTROL YE7VzlLtp-4 default:", run("YE7VzlLtp-4"))
for c in ["web_creator","android_music","ios_music","tv_embedded","web_music"]:
    print(f"{c:12s}:", run("CX3QRLSTrtw", c))
