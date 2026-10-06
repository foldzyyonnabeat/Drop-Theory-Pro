#!/usr/bin/env python3
"""Append a verified ZIP32 package to a Windows launcher and fix SFX offsets."""

import hashlib
import json
import shutil
import struct
import sys
import zipfile
from pathlib import Path


UINT32_MAX = (1 << 32) - 1
EOCD_SIGNATURE = b"PK\x05\x06"
CENTRAL_SIGNATURE = b"PK\x01\x02"
CHUNK_SIZE = 8 * 1024 * 1024


def fail(message: str) -> None:
    raise SystemExit(message)


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        while chunk := source.read(CHUNK_SIZE):
            digest.update(chunk)
    return digest.hexdigest()


def read_end_record(source: Path) -> tuple[int, int, int, int]:
    source_size = source.stat().st_size
    tail_size = min(source_size, 22 + 65_535)
    with source.open("rb") as stream:
        stream.seek(source_size - tail_size)
        tail = stream.read(tail_size)

    marker = tail.rfind(EOCD_SIGNATURE)
    if marker < 0 or marker + 22 > len(tail):
        fail("The offline package has no valid ZIP end record.")

    (
        _signature,
        disk_number,
        central_disk,
        entries_on_disk,
        entry_count,
        central_size,
        central_offset,
        comment_length,
    ) = struct.unpack_from("<4s4H2IH", tail, marker)
    if marker + 22 + comment_length != len(tail):
        fail("The offline package has an invalid ZIP comment or trailing data.")
    if disk_number or central_disk or entries_on_disk != entry_count:
        fail("Multi-volume offline packages are not supported.")
    if (
        entry_count == 0xFFFF
        or central_size == UINT32_MAX
        or central_offset == UINT32_MAX
    ):
        fail("The offline package must remain ZIP32 for Windows compatibility.")

    eocd_offset = source_size - tail_size + marker
    if central_offset + central_size > eocd_offset:
        fail("The offline package central directory is outside the ZIP data area.")
    return eocd_offset, entry_count, central_size, central_offset


def expected_source_checksum(source: Path) -> str:
    sidecar = Path(str(source) + ".sha256")
    if not sidecar.is_file():
        fail(f"The offline package checksum is missing: {sidecar}")
    expected = sidecar.read_text(encoding="utf-8").split()[0].lower()
    if len(expected) != 64 or any(character not in "0123456789abcdef" for character in expected):
        fail("The offline package checksum file is malformed.")
    return expected


def copy_hashed(source, output, byte_count: int, source_hash, output_hash) -> None:
    remaining = byte_count
    while remaining:
        chunk = source.read(min(CHUNK_SIZE, remaining))
        if not chunk:
            fail("The offline package ended before its recorded ZIP structures.")
        source_hash.update(chunk)
        output_hash.update(chunk)
        output.write(chunk)
        remaining -= len(chunk)


def validate_packaged_files(output: Path, expected_count: int) -> None:
    with zipfile.ZipFile(output, "r") as archive:
        files = archive.infolist()
        names = {entry.filename for entry in files}
        if len(files) != expected_count or len(names) != expected_count:
            fail(f"Expected {expected_count} unique files in the offline setup.")

        required = {
            "Install-Offline.ps1",
            "README.txt",
            "stem-models/MODEL-LICENSES.txt",
            "stem-models/bundle-manifest.json",
        }
        if not required.issubset(names):
            fail("The self-extracting setup is missing offline installation files.")

        installers = [
            name for name in names
            if name.startswith("Drop Theory Pro_") and name.endswith("_x64-setup.exe")
        ]
        if len(installers) != 1:
            fail("The self-extracting setup must contain exactly one Windows app installer.")

        manifest = json.loads(archive.read("stem-models/bundle-manifest.json"))
        model_files = manifest.get("files", [])
        if len(model_files) != 10:
            fail("The bundled model manifest does not list all ten pinned model files.")
        for model in model_files:
            member = "stem-models/" + model["path"].replace("\\", "/")
            info = archive.getinfo(member)
            if info.file_size != model["sizeBytes"] or info.compress_type != zipfile.ZIP_STORED:
                fail(f"The self-extracting setup has an invalid model entry: {member}")

        # Read the small support files to exercise ZIP offsets and CRCs after prefixing.
        archive.read("README.txt")
        archive.read("Install-Offline.ps1")
        archive.read("stem-models/MODEL-LICENSES.txt")
        print(f"Verified self-extracting ZIP structure and {len(model_files)} model entries.")


def create_self_extracting_zip(
    launcher: Path,
    source: Path,
    output: Path,
    checksum_output: Path,
    checksum_name: str,
) -> None:
    if not launcher.is_file() or not source.is_file():
        fail("The Windows launcher or offline ZIP is missing.")
    expected_checksum = expected_source_checksum(source)

    eocd_offset, entry_count, central_size, central_offset = read_end_record(source)
    launcher_size = launcher.stat().st_size
    source_size = source.stat().st_size
    if launcher_size + source_size >= UINT32_MAX:
        fail("The combined setup exceeds the ZIP32 4 GiB limit.")
    if launcher_size + central_offset >= UINT32_MAX:
        fail("The combined setup central directory exceeds ZIP32's offset limit.")

    output.parent.mkdir(parents=True, exist_ok=True)
    source_hash = hashlib.sha256()
    output_hash = hashlib.sha256()
    print(
        f"Embedding {source_size:,} verified offline-package bytes; "
        "checksum verification runs during the copy.",
        flush=True,
    )
    with launcher.open("rb") as stub, source.open("rb") as package, output.open("wb") as result:
        while chunk := stub.read(CHUNK_SIZE):
            output_hash.update(chunk)
            result.write(chunk)

        copy_hashed(package, result, central_offset, source_hash, output_hash)

        original_central = package.read(central_size)
        if len(original_central) != central_size:
            fail("The offline package central directory is truncated.")
        patched_central = bytearray(original_central)
        position = 0
        for _ in range(entry_count):
            header = patched_central[position:position + 46]
            if len(header) != 46 or header[:4] != CENTRAL_SIGNATURE:
                fail("A ZIP central directory entry is malformed.")
            filename_length, extra_length, comment_length = struct.unpack_from("<3H", header, 28)
            local_offset = struct.unpack_from("<I", header, 42)[0]
            if local_offset == UINT32_MAX or local_offset + launcher_size >= UINT32_MAX:
                fail("A ZIP member offset exceeds the ZIP32 limit.")
            struct.pack_into("<I", patched_central, position + 42, local_offset + launcher_size)
            position += 46 + filename_length + extra_length + comment_length
        if position != central_size:
            fail("The ZIP central directory size does not match its entries.")
        source_hash.update(original_central)
        output_hash.update(patched_central)
        result.write(patched_central)

        gap_size = eocd_offset - central_offset - central_size
        if gap_size < 0:
            fail("The offline package ZIP structures overlap.")
        copy_hashed(package, result, gap_size, source_hash, output_hash)

        original_eocd = package.read(source_size - eocd_offset)
        if len(original_eocd) != source_size - eocd_offset:
            fail("The offline package end record is truncated.")
        patched_eocd = bytearray(original_eocd)
        struct.pack_into("<I", patched_eocd, 16, central_offset + launcher_size)
        source_hash.update(original_eocd)
        output_hash.update(patched_eocd)
        result.write(patched_eocd)
        result.flush()

    source_digest = source_hash.hexdigest()
    if source_digest != expected_checksum:
        fail("The offline ZIP does not match its recorded SHA-256 checksum.")

    validate_packaged_files(output, entry_count)
    digest = output_hash.hexdigest()
    checksum_output.write_text(f"{digest}  {checksum_name}\n", encoding="utf-8")
    print(f"Verified source offline ZIP SHA-256: {source_digest}")
    print(
        f"Created self-extracting setup with {entry_count} files "
        f"({output.stat().st_size:,} bytes; SHA-256 {digest})."
    )


if __name__ == "__main__":
    if len(sys.argv) != 6:
        fail(
            "Usage: create-self-extracting-zip.py "
            "LAUNCHER.exe SOURCE.zip OUTPUT.exe CHECKSUM_PATH CHECKSUM_NAME"
        )
    create_self_extracting_zip(
        Path(sys.argv[1]),
        Path(sys.argv[2]),
        Path(sys.argv[3]),
        Path(sys.argv[4]),
        sys.argv[5],
    )
