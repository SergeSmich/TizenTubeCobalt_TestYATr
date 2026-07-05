#!/usr/bin/env python3
"""Patch libchrobalt.so so the VOT translation worker is allowed by the page CSP.

Background (discovered via on-device logcat):
  The live youtube.com/tv page enforces a Content-Security-Policy. Its
  connect-src list is mostly delivered by the YouTube server, BUT the
  TizenTubeCobalt fork ALSO hardcodes three extra hosts inside
  libchrobalt.so which it appends to connect-src:

      sponsor.ajay.app\\x00dearrow-thumb.ajay.app\\x00tizentube.app\\x00

  That is why SponsorBlock (sponsor.ajay.app) works while our VOT worker
  (vot-worker.kload.workers.dev) is refused ("Refused to connect ...
  violates ... connect-src", i.e. TypeError: Failed to fetch).

Fix (no full Cobalt rebuild required):
  Overwrite the two adjacent, low-value hosts `dearrow-thumb.ajay.app` and
  `tizentube.app` in-place with our worker host, padded with NUL bytes to
  keep the exact byte length (so no pointers/offsets in the ELF shift).

  Kept intact:
    * sponsor.ajay.app  -> SponsorBlock keeps working
    * DeArrow *titles* also use sponsor.ajay.app (/api/branding), so they
      keep working too.
  Sacrificed (acceptable):
    * dearrow-thumb.ajay.app -> DeArrow replacement THUMBNAIL images
    * tizentube.app          -> the tizentube website host

After the patch, `dearrow-thumb.ajay.app`'s CSP slot resolves to
`vot-worker.kload.workers.dev`, so the worker is allowed by connect-src.
"""
import pathlib
import sys

# The two adjacent hardcoded hosts (each NUL-terminated) that we repurpose.
# 22 + 1 + 13 + 1 = 37 bytes total.
OLD_BLOCK = b"dearrow-thumb.ajay.app\x00tizentube.app\x00"

WORKER_HOST = b"vot-worker.kload.workers.dev"  # 28 bytes

# Rebuild a same-length block: worker host, NUL terminator, then NUL padding.
# The pointer that used to reference `dearrow-thumb.ajay.app` now reads
# exactly "vot-worker.kload.workers.dev". The pointer that used to reference
# `tizentube.app` now reads a short harmless leftover fragment (or nothing),
# which is an inert/ignored CSP token.
NEW_BLOCK = WORKER_HOST + b"\x00" + b"\x00" * (len(OLD_BLOCK) - len(WORKER_HOST) - 1)

assert len(NEW_BLOCK) == len(OLD_BLOCK), (
    f"length mismatch: {len(NEW_BLOCK)} != {len(OLD_BLOCK)}"
)


def patch_lib(path: pathlib.Path) -> int:
    data = path.read_bytes()

    # Already patched?
    if data.count(WORKER_HOST) and OLD_BLOCK not in data:
        print(f"Already patched (worker host present): {path}")
        return 0

    count = data.count(OLD_BLOCK)
    if count == 0:
        return 0

    patched = data.replace(OLD_BLOCK, NEW_BLOCK)
    path.write_bytes(patched)
    return count


def main() -> int:
    if len(sys.argv) != 2:
        print("Usage: patch_csp_connect_src.py <apk_out_dir>")
        return 1

    root = pathlib.Path(sys.argv[1])
    if not root.is_dir():
        raise RuntimeError(f"Not a directory: {root}")

    libs = sorted(root.rglob("libchrobalt.so"))
    if not libs:
        raise RuntimeError(f"No libchrobalt.so files found under {root}")

    total = 0
    already = 0
    for lib in libs:
        patched = patch_lib(lib)
        if patched:
            print(f"Patched {patched} occurrence(s) in {lib}")
            total += patched
        else:
            # Distinguish "already patched" from "target missing".
            data = lib.read_bytes()
            if WORKER_HOST in data:
                already += 1

    if total == 0 and already == 0:
        raise RuntimeError(
            "CSP host block (dearrow-thumb.ajay.app\\x00tizentube.app) not "
            "found in any libchrobalt.so. The upstream string layout may have "
            "changed; re-run the on-device probe to locate the connect-src "
            "allowlist."
        )

    print(f"Total patched occurrences: {total} (already-patched libs: {already})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
