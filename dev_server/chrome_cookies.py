#!/usr/bin/env python3
"""Extract YouTube/Google cookies from a Chromium browser profile into a
Netscape cookies.txt that yt-dlp can use.

Needed because yt-dlp refuses to copy Chrome's cookie database while Chrome is
running ("Could not copy Chrome cookie database"), and YouTube's bot check makes
cookies mandatory for downloads from this PC. Reading the database is done
immutable-style (no write lock needed), decryption uses the AES key that Chrome
keeps in Local State, protected by DPAPI for the current Windows user.

Usage:
  python chrome_cookies.py [--out=yt_cookies.txt] [--profile=Default]
                           [--browser=chrome|edge|brave]
"""

import base64
import ctypes
import hashlib
import json
import os
import pathlib
import sqlite3
import sys
import time

from cryptography.hazmat.primitives.ciphers.aead import AESGCM

ROOT = os.path.dirname(os.path.abspath(__file__))
CHROME_DBS = {
    "chrome": os.path.join(
        os.environ.get("LOCALAPPDATA", ""), "Google", "Chrome", "User Data"
    ),
    "edge": os.path.join(
        os.environ.get("LOCALAPPDATA", ""), "Microsoft", "Edge", "User Data"
    ),
    "brave": os.path.join(
        os.environ.get("LOCALAPPDATA", ""),
        "BraveSoftware",
        "Brave-Browser",
        "User Data",
    ),
}
KEEP_DOMAINS = ("youtube.com", "google.com", "googlevideo.com", "gstatic.com")


class DATA_BLOB(ctypes.Structure):
    _fields_ = [("cbData", ctypes.c_uint32), ("pbData", ctypes.POINTER(ctypes.c_char))]


def dpapi(blob):
    buf = ctypes.create_string_buffer(blob, len(blob))
    src = DATA_BLOB(len(blob), ctypes.cast(buf, ctypes.POINTER(ctypes.c_char)))
    dst = DATA_BLOB()
    ok = ctypes.windll.crypt32.CryptUnprotectData(
        ctypes.byref(src), None, None, None, None, 0, ctypes.byref(dst)
    )
    if not ok:
        raise OSError("CryptUnprotectData failed")
    try:
        return ctypes.string_at(dst.pbData, dst.cbData)
    finally:
        ctypes.windll.kernel32.LocalFree(dst.pbData)


def aes_key(user_data):
    state = json.loads(
        open(os.path.join(user_data, "Local State"), encoding="utf-8").read()
    )
    enc = base64.b64decode(state["os_crypt"]["encrypted_key"])
    if enc[:5] == b"DPAPI":
        enc = enc[5:]
    return dpapi(enc)


def decrypt(value, key, host_key):
    """Chrome >= 80: v10/v11 = AES-256-GCM. The exact AAD differs between
    versions, so try the known variants and keep whatever authenticates.
    Since DB version 24 the plaintext starts with sha256(host_key), which has
    to be stripped before the value can be decoded."""
    if value[:3] in (b"v10", b"v11", b"v20"):
        nonce, ct = value[3:15], value[15:]
        raw = None
        for aad in (b"", host_key.encode(), hashlib.sha256(host_key.encode()).digest()):
            try:
                raw = AESGCM(key).decrypt(nonce, ct, aad)
                break
            except Exception:
                continue
        if raw is None:
            return None
        if raw[:32] == hashlib.sha256(host_key.encode()).digest():
            raw = raw[32:]
        try:
            return raw.decode("utf-8")
        except UnicodeDecodeError:
            return None
    try:  # very old Chrome: whole blob is DPAPI
        return dpapi(value).decode("utf-8")
    except Exception:
        return None


def read_cookies(user_data, profile, wait=0):
    db = os.path.join(user_data, profile, "Network", "Cookies")
    if not os.path.isfile(db):
        db = os.path.join(user_data, profile, "Cookies")
    if not os.path.isfile(db):
        raise RuntimeError("cookies db not found: " + db)
    key = aes_key(user_data)
    # Chrome holds the database open with FILE_SHARE_NONE, so a plain open
    # fails while the browser runs ("unable to open database file" even with
    # immutable=1). Waiting is the only option without admin rights (VSS).
    deadline = time.time() + wait
    while True:
        con = None
        try:
            con = sqlite3.connect(pathlib.Path(db).as_uri() + "?immutable=1", uri=True)
            con.execute("select count(*) from cookies").fetchone()
            break
        except sqlite3.Error as e:
            if con is not None:
                con.close()
            if time.time() >= deadline:
                raise RuntimeError(
                    f"{e} (cookies db is locked: close the browser or pass --wait=SECONDS)"
                ) from e
            print(
                "waiting for the cookie db to unlock (close the browser)...", flush=True
            )
            time.sleep(2)
    try:
        rows = con.execute(
            "select host_key, name, value, encrypted_value, path, expires_utc, "
            "is_secure, is_httponly from cookies"
        ).fetchall()
    finally:
        con.close()
    out, failed = [], 0
    for host, name, plain, enc, path, expires, secure, httponly in rows:
        if not any(d in host for d in KEEP_DOMAINS):
            continue
        val = plain or decrypt(enc or b"", key, host)
        if not val:
            failed += 1
            continue
        out.append((host, name, val, path or "/", expires or 0, secure, httponly))
    return out, failed, db


def write_netscape(cookies, path):
    lines = [
        "# Netscape HTTP Cookie File",
        "# Generated by chrome_cookies.py (Yandex VOT PC filler)",
        "",
    ]
    for host, name, val, cpath, expires, secure, httponly in cookies:
        exp = int(expires)
        if exp > 10**12:  # Chrome stores microseconds since 1601
            exp = int(exp / 1000000 - 11644473600)
        if exp <= 0:
            exp = int(time.time()) + 3600
        domain = host if host.startswith(".") else "." + host
        lines.append(
            "\t".join(
                [
                    domain,
                    "TRUE",
                    cpath,
                    "TRUE" if secure else "FALSE",
                    str(exp),
                    name,
                    val,
                ]
            )
        )
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8", newline="\n") as fh:
        fh.write("\n".join(lines) + "\n")
    os.replace(tmp, path)
    return len(cookies)


def main(argv):
    out = os.path.join(ROOT, "yt_cookies.txt")
    profile = "Default"
    browser = "chrome"
    wait = 0
    for a in argv[1:]:
        if "=" not in a:
            continue
        k, v = a.lstrip("-").split("=", 1)
        if k == "out":
            out = v if os.path.isabs(v) else os.path.join(ROOT, v)
        elif k == "profile":
            profile = v
        elif k == "browser":
            browser = v
        elif k == "wait":
            wait = int(float(v))
    user_data = CHROME_DBS.get(browser)
    if not user_data or not os.path.isdir(user_data):
        print(f"no {browser} profile at {user_data}")
        return 2
    cookies, failed, db = read_cookies(user_data, profile, wait)
    have = {c[1] for c in cookies}
    print(f"db={db}")
    print(
        f"cookies={len(cookies)} undecryptable={failed} "
        f"SID={'SID' in have} SAPISID={'SAPISID' in have} "
        f"1PSID={'__Secure-1PSID' in have}"
    )
    if not cookies:
        print("nothing to write")
        return 1
    n = write_netscape(cookies, out)
    print(f"wrote {n} cookies -> {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
