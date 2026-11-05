import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from zipfile import ZipFile

MODULE = Path(__file__).resolve().parents[1] / "scripts/package.py"
SPEC = importlib.util.spec_from_file_location("catalog_package", MODULE)
packaging = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(packaging)


class CatalogPackagingTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="kinopoisk-package-")
        self.root = Path(self.temp.name)
        assembly = self.root / "src/Jellyfin.Plugin.KinopoiskRatings/bin/Release/net9.0" / packaging.DLL
        assembly.parent.mkdir(parents=True)
        assembly.write_bytes(b"test assembly bytes")

    def tearDown(self):
        self.temp.cleanup()

    def test_catalog_zip_has_only_root_assembly_and_matching_md5(self):
        url = "https://downloads.example.org/releases/" + packaging.ARCHIVE
        archive, path = packaging.package(self.root, url)
        with ZipFile(archive) as bundle:
            self.assertEqual(bundle.namelist(), [packaging.DLL])
            self.assertEqual(bundle.read(packaging.DLL), b"test assembly bytes")
        plugin = json.loads(path.read_text(encoding="utf-8"))[0]
        version = plugin["versions"][0]
        self.assertEqual(plugin["guid"], packaging.PLUGIN_ID)
        self.assertEqual(version["version"], "0.3.0.0")
        self.assertEqual(version["targetAbi"], "10.11.5.0")
        self.assertEqual(version["sourceUrl"], url)
        self.assertEqual(version["dependencies"], [packaging.TRANSFORMATION_ID])
        self.assertEqual(version["checksum"], hashlib.md5(archive.read_bytes()).hexdigest().upper())

    def test_without_url_only_explicit_template_is_produced(self):
        packaging.package(self.root, "https://downloads.example.org/old.zip")
        _, path = packaging.package(self.root)
        self.assertEqual(path.name, "manifest.template.json")
        self.assertFalse((self.root / "dist/manifest.json").exists())
        version = json.loads(path.read_text(encoding="utf-8"))[0]["versions"][0]
        self.assertEqual(version["sourceUrl"], packaging.URL_PLACEHOLDER)

    def test_archive_is_reproducible_and_publishing_removes_template(self):
        archive, _ = packaging.package(self.root)
        original = archive.read_bytes()
        archive, path = packaging.package(self.root, "https://downloads.example.org/plugin.zip")
        self.assertEqual(archive.read_bytes(), original)
        self.assertEqual(path.name, "manifest.json")
        self.assertFalse((self.root / "dist/manifest.template.json").exists())

    def test_invalid_url_rejected_before_output(self):
        for url in ("http://example.org/a.zip", "https:///a.zip", "https://user:secret@example.org/a.zip", "https://example.org/a.zip#fragment", "https://example.org/a b.zip"):
            with self.subTest(url=url), self.assertRaises(ValueError):
                packaging.package(self.root, url)
        self.assertFalse((self.root / "dist").exists())


if __name__ == "__main__":
    unittest.main()
