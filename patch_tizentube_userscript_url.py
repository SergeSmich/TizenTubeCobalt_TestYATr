#!/usr/bin/env python3
import pathlib
import sys

OLD_URL = b"https://cdn.jsdelivr.net/npm/@foxreis/tizentube/dist/userScript.js?v="
NEW_URL = b"file:///android_asset/vot.js"


def patch_binary(path: pathlib.Path) -> int:
    data = path.read_bytes()
    count = data.count(OLD_URL)
    if count == 0:
        return 0

    if len(NEW_URL) + 1 > len(OLD_URL):
        raise RuntimeError(
            f"Replacement URL too long ({len(NEW_URL)}>{len(OLD_URL)-1}) for {path}"
        )

    replacement = NEW_URL + b"\x00" + b"\x00" * (len(OLD_URL) - len(NEW_URL) - 1)
    patched = data.replace(OLD_URL, replacement)
    path.write_bytes(patched)
    return count


def main() -> int:
    if len(sys.argv) != 2:
        print("Usage: patch_tizentube_userscript_url.py <apk_out_dir>")
        return 1

    apk_out = pathlib.Path(sys.argv[1])
    if not apk_out.is_dir():
        raise RuntimeError(f"Not a directory: {apk_out}")

    libs = list(apk_out.rglob("libchrobalt.so"))
    if not libs:
        raise RuntimeError(f"No libchrobalt.so files found under {apk_out}")

    total = 0
    for lib in libs:
        c = patch_binary(lib)
        if c:
            print(f"Patched {c} occurrence(s) in {lib}")
            total += c

    if total == 0:
        raise RuntimeError("Target userScript URL not found in any libchrobalt.so")

    print(f"Total patched occurrences: {total}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
