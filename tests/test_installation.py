import importlib.util
from pathlib import Path
import tempfile
import unittest
from urllib.parse import urljoin

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "patch-web.py"
spec = importlib.util.spec_from_file_location("patch_web", SCRIPT)
patch_web = importlib.util.module_from_spec(spec)
spec.loader.exec_module(patch_web)


class PatchWebTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(dir=Path(__file__).resolve().parent)
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.index = self.root / "index.html"
        self.original = b'\xef\xbb\xbf<html>\r\n<body>Jellyfin</body></html>\r\n'
        self.index.write_bytes(self.original)

    def test_round_trip_preserves_bytes_and_is_idempotent(self):
        message, saved = patch_web.patch(self.root)
        self.assertEqual(message, "Installed")
        self.assertEqual(saved.read_bytes(), self.original)
        self.assertEqual(patch_web.patch(self.root), ("Already installed", None))
        patch_web.patch(self.root, remove=True)
        self.assertEqual(self.index.read_bytes(), self.original)
        self.assertEqual(patch_web.patch(self.root, remove=True), ("Already removed", None))

    def test_remove_preserves_other_edits(self):
        patch_web.patch(self.root)
        self.index.write_bytes(self.index.read_bytes().replace(b"Jellyfin", b"My Jellyfin"))
        patch_web.patch(self.root, remove=True)
        self.assertEqual(self.index.read_bytes(), self.original.replace(b"Jellyfin", b"My Jellyfin"))

    def test_reinstall_after_server_upgrade_keeps_both_backups(self):
        _, first = patch_web.patch(self.root)
        upgraded = self.original.replace(b"Jellyfin", b"New Jellyfin")
        self.index.write_bytes(upgraded)
        _, second = patch_web.patch(self.root)
        self.assertNotEqual(first, second)
        self.assertEqual(first.read_bytes(), self.original)
        self.assertEqual(second.read_bytes(), upgraded)

    def test_modified_block_fails_without_writing(self):
        patch_web.patch(self.root)
        changed = self.index.read_bytes().replace(b"client.js", b"custom.js")
        self.index.write_bytes(changed)
        with self.assertRaises(ValueError):
            patch_web.patch(self.root, remove=True)
        self.assertEqual(self.index.read_bytes(), changed)

    def test_missing_body_fails_without_writing(self):
        self.index.write_bytes(b"wrong file")
        with self.assertRaises(ValueError):
            patch_web.patch(self.root)
        self.assertEqual(self.index.read_bytes(), b"wrong file")

    def test_loader_resolves_with_base_url(self):
        for base in ("", "/jellyfin"):
            self.assertEqual(
                urljoin("https://media.example" + base + "/web/index.html", "../KinopoiskRatings/client.js"),
                "https://media.example" + base + "/KinopoiskRatings/client.js",
            )


if __name__ == "__main__":
    unittest.main()
