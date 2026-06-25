#!/usr/bin/env python3
import pathlib
import sys

MARKER_BEGIN = "/* VOT_INJECTION_BEGIN */"
MARKER_END = "/* VOT_INJECTION_END */"


def select_main_bundle(assets_dir: pathlib.Path) -> pathlib.Path:
    js_files = [p for p in assets_dir.rglob("*.js") if p.is_file()]
    if not js_files:
        raise RuntimeError(f"No JavaScript files found in {assets_dir}")

    candidates = [p for p in js_files if p.name.lower() != "vot.js"]
    if not candidates:
        raise RuntimeError("Only vot.js exists, no runtime bundle to patch")

    # Main runtime bundle is typically the largest JS asset.
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
