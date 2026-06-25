#!/usr/bin/env python3
import pathlib
import struct
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


def read_data_pack(path: pathlib.Path):
    data = path.read_bytes()
    version = struct.unpack("<I", data[:4])[0]
    if version != 5:
        raise RuntimeError(f"Unsupported .pak version {version} in {path}")

    encoding, resource_count, alias_count = struct.unpack("<BxxxHH", data[4:12])
    header_size = 12
    entry_size = 6
    alias_entry_size = 4

    def entry_at(i):
        off = header_size + i * entry_size
        return struct.unpack("<HI", data[off : off + entry_size])

    resources = {}
    prev_id, prev_off = entry_at(0)
    for i in range(1, resource_count + 1):
        rid, off = entry_at(i)
        resources[prev_id] = data[prev_off:off]
        prev_id, prev_off = rid, off

    aliases = {}
    id_table_size = (resource_count + 1) * entry_size
    for i in range(alias_count):
        off = header_size + id_table_size + i * alias_entry_size
        rid, idx = struct.unpack("<HH", data[off : off + alias_entry_size])
        aliased_id = entry_at(idx)[0]
        aliases[rid] = aliased_id
        resources[rid] = resources[aliased_id]

    return resources, encoding, aliases


def write_data_pack(path: pathlib.Path, resources: dict, encoding: int):
    resource_ids = sorted(resources.keys())
    content = []
    alias_map = {}

    # Header: version 5
    resource_count = len(resource_ids) - len(alias_map)
    content.append(struct.pack("<IBxxxHH", 5, encoding, resource_count, len(alias_map)))
    header_len = 12
    data_offset = header_len + (resource_count + 1) * 6 + len(alias_map) * 4

    payloads = []
    for rid in resource_ids:
        blob = resources[rid]
        content.append(struct.pack("<HI", rid, data_offset))
        data_offset += len(blob)
        payloads.append(blob)

    content.append(struct.pack("<HI", 0, data_offset))
    content.extend(payloads)
    path.write_bytes(b"".join(content))


def inject_into_cobalt_pak(vot_text: str, assets_dir: pathlib.Path) -> bool:
    pak = assets_dir / "cobalt_shell.pak"
    if not pak.is_file():
        return False

    resources, encoding, _aliases = read_data_pack(pak)
    candidates = []
    for rid, blob in resources.items():
        if len(blob) < 2048:
            continue
        if b"\x00" in blob[:4096]:
            continue
        low = blob[:65536].lower()
        if any(t in low for t in (b"function", b"window", b"document", b"const ", b"let ")):
            candidates.append((rid, blob))

    if not candidates:
        return False

    candidates.sort(key=lambda x: len(x[1]), reverse=True)
    rid, blob = candidates[0]
    text = blob.decode("utf-8", errors="replace")
    if MARKER_BEGIN in text:
        print(f"VOT marker already present in cobalt_shell.pak resource {rid}, skipping.")
        return True

    injected = (
        text
        + "\n\n"
        + MARKER_BEGIN
        + "\n;(function(){\n"
        + vot_text
        + "\n})();\n"
        + MARKER_END
        + "\n"
    )
    resources[rid] = injected.encode("utf-8")
    write_data_pack(pak, resources, encoding)
    print(f"Injected vot.js into cobalt_shell.pak resource id {rid}")
    return True


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

    vot_text = vot_path.read_text(encoding="utf-8")
    try:
        bundle_path = select_main_bundle(assets_dir)
        print(f"Selected runtime bundle: {bundle_path}")
        bundle_text = bundle_path.read_text(encoding="utf-8", errors="replace")
        if MARKER_BEGIN in bundle_text:
            print("VOT marker already present, skipping append.")
            return 0

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
    except RuntimeError:
        if inject_into_cobalt_pak(vot_text, assets_dir):
            return 0
        raise


if __name__ == "__main__":
    raise SystemExit(main())
