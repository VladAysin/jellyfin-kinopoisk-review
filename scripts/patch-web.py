#!/usr/bin/env python3
"""Add/remove the Kinopoisk Ratings loader in a server's Jellyfin web index."""

import argparse
import hashlib
import os
from pathlib import Path
import re
import stat
import tempfile

START = b"<!-- jellyfin-kinopoisk-ratings:start -->"
END = b"<!-- jellyfin-kinopoisk-ratings:end -->"
BLOCK = (START + b'\n<script defer src="../KinopoiskRatings/client.js"></script>\n' + END)


def atomic_write(path, content):
    mode = stat.S_IMODE(path.stat().st_mode) if path.exists() else 0o644
    fd, temporary = tempfile.mkstemp(prefix=path.name + ".", dir=path.parent)
    try:
        with os.fdopen(fd, "wb") as stream:
            stream.write(content)
            stream.flush()
            os.fsync(stream.fileno())
        os.chmod(temporary, mode)
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def backup(path, original):
    folder = path.parent / ".kinopoisk-ratings-backups"
    if folder.is_symlink():
        raise ValueError("Backup directory must not be a symlink")
    folder.mkdir(exist_ok=True)
    saved = folder / (path.name + "." + hashlib.sha256(original).hexdigest() + ".bak")
    if saved.is_symlink():
        raise ValueError("Backup file must not be a symlink")
    try:
        with saved.open("xb") as stream:
            stream.write(original)
    except FileExistsError:
        if saved.read_bytes() != original:
            raise ValueError("Existing backup does not match its content hash")
    return saved


def patch(web_root, remove=False):
    root = Path(web_root).expanduser()
    target = root / "index.html"
    if target.is_symlink() or root.is_symlink():
        raise ValueError("Web root and index.html must not be symlinks; use the real path")
    target = target.resolve(strict=True)
    original = target.read_bytes()
    if original.count(START) != original.count(END) or original.count(START) > 1:
        raise ValueError("Malformed or duplicate loader markers; no files changed")
    if START in original:
        if BLOCK not in original:
            raise ValueError("Loader block was modified; no files changed")
        if not remove:
            return "Already installed", None
        updated = original.replace(BLOCK, b"", 1)
    elif remove:
        return "Already removed", None
    else:
        closing_body = list(re.finditer(br"</body\s*>", original, re.IGNORECASE))
        if len(closing_body) != 1:
            raise ValueError("Expected exactly one closing body tag; no files changed")
        offset = closing_body[0].start()
        updated = original[:offset] + BLOCK + original[offset:]
    saved = backup(target, original)
    atomic_write(target, updated)
    return ("Removed" if remove else "Installed"), saved


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--web-root", required=True, type=Path, help="Server jellyfin-web directory containing index.html")
    parser.add_argument("--remove", action="store_true", help="Remove only our loader, preserving other modifications")
    args = parser.parse_args()
    try:
        message, saved = patch(args.web_root, args.remove)
    except (OSError, ValueError) as error:
        parser.exit(1, "Error: " + str(error) + "\n")
    print(message)
    if saved:
        print("Backup:", saved)


if __name__ == "__main__":
    main()
