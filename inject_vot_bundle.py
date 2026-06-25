#!/usr/bin/env python3
import pathlib
import sys

MARKER_BEGIN = "/* VOT_INJECTION_BEGIN */"
MARKER_END = "/* VOT_INJECTION_END */"


def looks_like_js_text(path: pathlib.Path) -> bool:
    try:
        data = path.read_bytes()
    except OSError:
        return False

    if not data or b"\x00" in data[:4096]:
        return False

    probe = data[:32768]
    ascii_ratio = sum(1 for b in probe if b in b"\t\n\r" or 32 <= b <= 126) / max(1, len(probe))
    if ascii_ratio < 0.8:
        return False

    low = probe.lower()
    js_tokens = [b"function", b"window", b"document", b"var ", b"const ", b"let "]
    return any(t in low for t in js_tokens)


def select_main_bundle(assets_dir: pathlib.Path) -> pathlib.Path:
    js_files = [p for p in assets_dir.rglob("*.js") if p.is_file() and p.name.lower() != "vot.js"]
    if js_files:
        js_files.sort(key=lambda p: p.stat().st_size, reverse=True)
        return js_files[0]

    # Fallback: some builds keep runtime JS in non-.js asset blobs.
    candidates = []
    for p in assets_dir.rglob("*"):
        if not p.is_file():
            continue
        if p.name.lower() == "vot.js":
            continue
        if p.stat().st_size < 2048:
            continue
        if looks_like_js_text(p):
            candidates.append(p)

    if not candidates:
        raise RuntimeError("No runtime JS bundle candidate found under assets")

    candidates.sort(key=lambda p: p.stat().st_size, reverse=True)
    return candidates[0]


def main() -> int:
    if len(sys.argv) != 3:
        print("Usage: inject_vot_bundle.py <vot_js_path> <assets_dir>")
        return 1

    vot_path = pathlib.Path(sys.argv[1])
    assets_dir = pathlib.Path(sys.argv[2])

    if not vot_path.is_file():
        raise RuntimeError(f"vot.js not found: {vot_path}")
    if not assets_dir.is_dir():
        raise RuntimeError(f"assets dir not found: {assets_dir}")

    bundle_path = select_main_bundle(assets_dir)
    print(f"Selected runtime bundle: {bundle_path}")

    bundle_text = bundle_path.read_text(encoding="utf-8", errors="replace")
    if MARKER_BEGIN in bundle_text:
        print("VOT marker already present, skipping append.")
        return 0

    vot_text = vot_path.read_text(encoding="utf-8")
    injected = (
        bundle_text
        + "\n\n"
        + MARKER_BEGIN
        + "\n;(function(){\n"
        + vot_text
        + "\n})();\n"
        + MARKER_END
        + "\n"
    )
    bundle_path.write_text(injected, encoding="utf-8")
    print(f"Injected vot.js into: {bundle_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
