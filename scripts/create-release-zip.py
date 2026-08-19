#!/usr/bin/env python3
"""Create a portable release ZIP with explicit Unix permissions."""

import argparse
import json
import os
import pathlib
import stat
import time
import zipfile


def parse_args():
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--file-list", required=True)
    return parser.parse_args()


def read_files(root, file_list):
    entries = []
    for raw in pathlib.Path(file_list).read_text(encoding="utf-8").splitlines():
        name = raw.strip().replace("\\", "/")
        if not name:
            continue
        parts = pathlib.PurePosixPath(name).parts
        if name.startswith("/") or ".." in parts:
            raise ValueError(f"unsafe release path: {name}")
        candidate = root / pathlib.PurePosixPath(name)
        source = candidate.resolve()
        source.relative_to(root)
        if not source.is_file() or candidate.is_symlink():
            raise ValueError(f"release entry is not a regular file: {name}")
        entries.append((name, source))
    return entries


def zip_timestamp(source):
    values = list(time.localtime(source.stat().st_mtime)[:6])
    values[0] = max(1980, values[0])
    return tuple(values)


def unix_mode(name):
    permissions = 0o755 if name.endswith(".sh") else 0o644
    return stat.S_IFREG | permissions


def write_zip(output, entries):
    output.parent.mkdir(parents=True, exist_ok=True)
    if output.exists():
        output.unlink()
    with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for name, source in entries:
            info = zipfile.ZipInfo(name, date_time=zip_timestamp(source))
            info.create_system = 3
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = unix_mode(name) << 16
            with source.open("rb") as handle:
                archive.writestr(info, handle.read())


def verify_zip(output, expected):
    with zipfile.ZipFile(output, "r") as archive:
        names = archive.namelist()
        if names != expected:
            raise ValueError("release ZIP entry list changed during creation")
        for info in archive.infolist():
            mode = (info.external_attr >> 16) & 0xFFFF
            if mode & stat.S_IWOTH:
                raise ValueError(f"world-writable ZIP entry: {info.filename}")
            if info.filename.endswith(".sh") and not mode & stat.S_IXUSR:
                raise ValueError(f"non-executable shell entry: {info.filename}")


def main():
    args = parse_args()
    root = pathlib.Path(args.root).resolve()
    output = pathlib.Path(args.output).resolve()
    entries = read_files(root, args.file_list)
    write_zip(output, entries)
    verify_zip(output, [name for name, _source in entries])
    print(json.dumps({"ok": True, "files": len(entries), "bytes": os.path.getsize(output)}))


if __name__ == "__main__":
    main()
