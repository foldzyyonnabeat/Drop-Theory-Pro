#!/usr/bin/env python3
"""Create a standard ZIP32 offline package without NSIS's 2 GiB payload cap."""

import hashlib
import json
import os
import sys
import zipfile
from pathlib import Path


UINT32_MAX = (1 << 32) - 1
# ZIP32 uses unsigned 32-bit offsets and sizes. The full package is about 2.3 GB,
# so keep it ZIP32 for compatibility with Windows Explorer and older unzip tools.
zipfile.ZIP64_LIMIT = UINT32_MAX - 1


def main() -> None:
    if len(sys.argv) != 4:
        raise SystemExit("Usage: package-offline-bundle.py ARTIFACT_DIR INSTALLER ZIP_PATH")

    artifact_dir = Path(sys.argv[1]).resolve()
    installer = Path(sys.argv[2]).resolve()
    output = Path(sys.argv[3]).resolve()
    model_root = artifact_dir / "src-tauri" / "resources" / "stem-models"
    lock_path = artifact_dir / "stem-models-windows.lock.json"
    install_script = artifact_dir / "scripts" / "Install-Offline.ps1"
    readme = artifact_dir / "scripts" / "OFFLINE-BUNDLE-README.txt"
    manifest_path = model_root / "bundle-manifest.json"
    license_path = model_root / "MODEL-LICENSES.txt"

    for path in (installer, lock_path, install_script, readme, manifest_path, license_path):
        if not path.is_file():
            raise SystemExit(f"Required offline bundle file is missing: {path}")

    lock_bytes = lock_path.read_bytes()
    lock = json.loads(lock_bytes)
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    lock_digest = hashlib.sha256(lock_bytes).hexdigest()
    if (
        lock.get("format") != "drop-theory-stem-models-lock"
        or lock.get("version") != 1
        or manifest.get("format") != "drop-theory-stem-model-bundle"
        or manifest.get("version") != 1
        or manifest.get("lockSha256") != lock_digest
    ):
        raise SystemExit("The staged model manifest does not match the pinned model lock.")

    manifest_files = {
        (entry.get("repo"), entry.get("filename")): entry
        for entry in manifest.get("files", [])
    }
    expected_profiles = {
        "htdemucs-ft",
        "htdemucs-ft-compact",
        "htdemucs-speed",
        "uvr-mdx-inst-hq-5",
    }
    if set(lock.get("profiles", [])) != expected_profiles:
        raise SystemExit("The pinned model lock does not cover all four supported profiles.")
    items = [
        (installer, installer.name),
        (install_script, "Install-Offline.ps1"),
        (readme, "README.txt"),
        (license_path, "stem-models/MODEL-LICENSES.txt"),
        (manifest_path, "stem-models/bundle-manifest.json"),
    ]
    seen = set()
    payload_bytes = 0
    for asset in lock["files"]:
        repo = asset.get("repo")
        filename = asset["filename"]
        key = (repo, filename)
        if key in seen:
            raise SystemExit(f"Duplicate model in lock file: {asset.get('path', filename)}")
        seen.add(key)
        record = manifest_files.get(key)
        relative_path = asset.get("path") or "/".join((repo, filename))
        normalized_path = relative_path.replace("\\", "/")
        path_parts = normalized_path.split("/")
        if (
            not normalized_path
            or normalized_path.startswith("/")
            or any(part in ("", ".", "..") for part in path_parts)
        ):
            raise SystemExit(f"The model lock contains an unsafe path: {relative_path}")
        if (
            record is None
            or record.get("revision") != asset.get("revision")
            or record.get("sizeBytes") != asset["sizeBytes"]
            or record.get("sha256") != asset["sha256"]
            or record.get("path", "").replace("\\", "/") != normalized_path
        ):
            raise SystemExit(f"Model manifest entry does not match the lock: {normalized_path}")

        source = model_root.joinpath(*path_parts)
        if not source.is_file() or source.stat().st_size != asset["sizeBytes"]:
            raise SystemExit(f"Model file is missing or has the wrong size: {source}")
        archive_path = "stem-models/" + normalized_path
        items.append((source, archive_path))
        payload_bytes += source.stat().st_size

    if len(seen) != len(lock["files"]) or len(seen) != 10:
        raise SystemExit(f"Expected ten pinned model files, found {len(seen)}.")

    estimated_size = sum(path.stat().st_size for path, _ in items) + sum(
        len(name.encode("utf-8")) * 2 + 128 for _, name in items
    ) + 22
    if estimated_size >= UINT32_MAX:
        raise SystemExit(
            "Offline bundle exceeds ZIP32's 4 GiB limit; do not silently create a Zip64 package."
        )

    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = output.with_name(output.name + ".partial")
    temporary.unlink(missing_ok=True)
    try:
        with zipfile.ZipFile(
            temporary,
            mode="w",
            compression=zipfile.ZIP_STORED,
            allowZip64=False,
        ) as archive:
            for source, archive_path in items:
                archive.write(source, archive_path, compress_type=zipfile.ZIP_STORED)
                print(f"Added {archive_path} ({source.stat().st_size:,} bytes).")

        actual_size = temporary.stat().st_size
        if actual_size >= UINT32_MAX:
            raise SystemExit("The completed archive exceeds ZIP32's 4 GiB limit.")
        os.replace(temporary, output)
    except Exception:
        temporary.unlink(missing_ok=True)
        raise

    print(
        f"Created ZIP32 offline bundle with {len(items)} files; "
        f"models total {payload_bytes:,} bytes; archive {output.stat().st_size:,} bytes."
    )


if __name__ == "__main__":
    main()