"""Create the Jellyfin catalog ZIP and manifest; never upload or install anything."""
from argparse import ArgumentParser
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlsplit
from zipfile import ZipFile, ZipInfo, ZIP_DEFLATED
import hashlib
import json
import shutil

ROOT = Path(__file__).resolve().parents[1]
DLL = "Jellyfin.Plugin.KinopoiskRatings.dll"
VERSION = "0.2.0.0"
ARCHIVE = "KinopoiskRatings-0.2.0.zip"
PLUGIN_ID = "ff10e970-ff53-4bd8-b659-ed5bb04c6eb1"
TRANSFORMATION_ID = "5e87cc92-571a-4d8d-8d98-d2d4147f9f90"
URL_PLACEHOLDER = "REPLACE_WITH_HTTPS_RELEASE_ARCHIVE_URL"


def validate_source_url(value: str) -> str:
    parsed = urlsplit(value)
    if (parsed.scheme != "https" or not parsed.hostname or parsed.username
            or parsed.password or parsed.fragment or any(c.isspace() for c in value)):
        raise ValueError("--source-url must be an HTTPS archive URL without credentials or fragment")
    return value


def package(root: Path, source_url: str | None = None) -> tuple[Path, Path]:
    if source_url is not None:
        validate_source_url(source_url)
    source = root / "src/Jellyfin.Plugin.KinopoiskRatings/bin/Release/net9.0" / DLL
    if not source.is_file():
        raise FileNotFoundError("Build Release/net9.0 first (see README.md).")
    dist = root / "dist"
    dist.mkdir(exist_ok=True)
    shutil.copyfile(source, dist / DLL)
    archive = dist / ARCHIVE
    # Jellyfin extracts into its plugin directory: the assembly belongs at root.
    # Stable metadata preserves the checksum when packaging the same DLL again.
    entry = ZipInfo(DLL, date_time=(1980, 1, 1, 0, 0, 0))
    entry.compress_type = ZIP_DEFLATED
    entry.create_system = 3
    entry.external_attr = 0o100644 << 16
    with ZipFile(archive, "w") as bundle:
        bundle.writestr(entry, source.read_bytes())
    archive_bytes = archive.read_bytes()
    manifest = [{
        "guid": PLUGIN_ID,
        "name": "Kinopoisk Ratings",
        "overview": "Оценка просмотренного в Кинопоиске",
        "description": "Оценка фильмов и сериалов после просмотра. Требует File Transformation.",
        "owner": "Jellyfin Kinopoisk Ratings",
        "category": "General",
        "versions": [{
            "version": VERSION,
            "changelog": "Подключение интерфейса через File Transformation без изменения файлов Jellyfin Web.",
            "targetAbi": "10.11.5.0",
            "sourceUrl": source_url or URL_PLACEHOLDER,
            "checksum": hashlib.md5(archive_bytes, usedforsecurity=False).hexdigest().upper(),
            "timestamp": datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z"),
            "dependencies": [TRANSFORMATION_ID],
        }],
    }]
    manifest_path = dist / ("manifest.json" if source_url else "manifest.template.json")
    # Never leave an old publishable manifest beside a newly rebuilt ZIP.
    stale = dist / ("manifest.template.json" if source_url else "manifest.json")
    stale.unlink(missing_ok=True)
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8", newline="\n")
    checksums = "".join(hashlib.sha256(path.read_bytes()).hexdigest() + "  " + path.name + "\n"
                        for path in (dist / DLL, archive, manifest_path))
    (dist / "SHA256SUMS.txt").write_text(checksums, encoding="utf-8", newline="\n")
    return archive, manifest_path


def main() -> None:
    parser = ArgumentParser(description=__doc__)
    parser.add_argument("--source-url", help="HTTPS URL where this exact ZIP will be published")
    args = parser.parse_args()
    try:
        archive, manifest = package(ROOT, args.source_url)
    except (ValueError, FileNotFoundError) as error:
        parser.error(str(error))
    print(archive)
    print(manifest)
    if not args.source_url:
        print("Template only: rerun with --source-url before publishing a plugin repository.")


if __name__ == "__main__":
    main()
