#!/usr/bin/env python3
import pathlib
import sys

OLD_URL = b"https://cdn.jsdelivr.net/npm/@foxreis/tizentube/dist/userScript.js?v="

# Must be a real http(s) URL (the native fetcher does not support file://
# or android_asset:// schemes - pointing there breaks device-support
# detection entirely, since the original userScript.js never loads).
#
# IMPORTANT (discovered via on-device logcat testing): the native flow
# injects this URL as a plain <script src="..."> element into the live
# page, which IS subject to the page's Content-Security-Policy. YouTube's
# CSP only allows script-src from a small set of origins that (for
# whatever reason) already includes cdn.jsdelivr.net. Any other domain
# (including URL shorteners like tinyurl.com, or raw.githubusercontent.com)
# gets silently blocked by CSP ("Refused to load the script ... violates
# ... script-src") and the injected script never runs at all.
#
# Fix: host our replacement (vot.js, which itself synchronously fetches
# and evals the REAL upstream userScript.js first - preserving 100% of
# original device-patch behavior - then adds the Yandex VOT overlay) on
# the SAME cdn.jsdelivr.net origin, via jsdelivr's GitHub-backed CDN
# (https://cdn.jsdelivr.net/gh/<owner>/<repo>@<ref>/<path>). A dedicated,
# short-named public repo (SergeSmich/v) is used so the full URL still
# fits within len(OLD_URL) bytes.
NEW_URL = b"https://cdn.jsdelivr.net/gh/SergeSmich/v@main/vot.js?v="


def patch_lib(path: pathlib.Path) -> int:
    data = path.read_bytes()
    count = data.count(OLD_URL)
    if count == 0:
        return 0

    if len(NEW_URL) > len(OLD_URL):
        raise RuntimeError(
            f"Replacement URL too long ({len(NEW_URL)} > {len(OLD_URL)})"
        )

    replacement = NEW_URL + (b"\x00" * (len(OLD_URL) - len(NEW_URL)))
    patched = data.replace(OLD_URL, replacement)
    path.write_bytes(patched)
    return count


def main() -> int:
    if len(sys.argv) != 2:
        print("Usage: patch_tizentube_userscript_url.py <apk_out_dir>")
        return 1

    root = pathlib.Path(sys.argv[1])
    if not root.is_dir():
        raise RuntimeError(f"Not a directory: {root}")

    libs = sorted(root.rglob("libchrobalt.so"))
    if not libs:
        raise RuntimeError(f"No libchrobalt.so files found under {root}")

    total = 0
    for lib in libs:
        patched = patch_lib(lib)
        if patched:
            print(f"Patched {patched} occurrence(s) in {lib}")
            total += patched

    if total == 0:
        raise RuntimeError("Target userScript URL not found in any libchrobalt.so")

    print(f"Total patched occurrences: {total}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
