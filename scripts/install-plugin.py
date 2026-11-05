#!/usr/bin/env python3
"""Copy the compiled plugin into an explicitly selected, stopped Jellyfin server."""

import argparse
import importlib.util
from pathlib import Path

spec = importlib.util.spec_from_file_location("patch_web", Path(__file__).with_name("patch-web.py"))
patch_web = importlib.util.module_from_spec(spec)
spec.loader.exec_module(patch_web)


def install(plugins_root, dll):
    source = Path(dll).resolve(strict=True)
    if source.name != "Jellyfin.Plugin.KinopoiskRatings.dll":
        raise ValueError("Expected Jellyfin.Plugin.KinopoiskRatings.dll")
    data = source.read_bytes()
    if not data.startswith(b"MZ"):
        raise ValueError("Input is not a .NET assembly (missing PE signature)")
    root = Path(plugins_root).expanduser()
    if root.is_symlink():
        raise ValueError("Plugins root must not be a symlink; use the real path")
    root = root.resolve(strict=True)
    folder = root / "KinopoiskRatings"
    if folder.is_symlink():
        raise ValueError("Plugin folder must not be a symlink")
    folder.mkdir(exist_ok=True)
    target = folder / source.name
    if target.is_symlink():
        raise ValueError("Target DLL must not be a symlink")
    if target.exists():
        original = target.read_bytes()
        if original == data:
            return "Already installed: " + str(target)
        patch_web.backup(target, original)
    patch_web.atomic_write(target, data)
    return "Installed: " + str(target)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--plugins-root", required=True, type=Path)
    parser.add_argument("--dll", type=Path, default=Path(__file__).resolve().parent.parent / "dist" / "Jellyfin.Plugin.KinopoiskRatings.dll")
    args = parser.parse_args()
    try:
        print(install(args.plugins_root, args.dll))
    except (OSError, ValueError) as error:
        parser.exit(1, "Error: " + str(error) + "\n")


if __name__ == "__main__":
    main()
