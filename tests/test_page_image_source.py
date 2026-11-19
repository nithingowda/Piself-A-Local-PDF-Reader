"""Source-level guards for the optional cached WebP magazine page backend."""
from pathlib import Path
import unittest

ROOT=Path(__file__).resolve().parents[1]
SERVER=(ROOT/'server.py').read_text()
APP=(ROOT/'static/app.js').read_text()
REQUIREMENTS=(ROOT/'requirements.txt').read_text()


class WebPMagazineTests(unittest.TestCase):
    def test_server_validates_page_and_source(self):
        self.assertIn("path.startswith('/api/page-image/')",SERVER)
        self.assertIn("self.library_items()",SERVER)
        self.assertIn("checked_path(source,item['path'])",SERVER)
        self.assertIn("width not in (960,1600,2800)",SERVER)

    def test_cache_key_tracks_source_changes(self):
        self.assertIn("stat.st_mtime_ns",SERVER)
        self.assertIn("stat.st_size",SERVER)
        self.assertIn("format='WEBP'",SERVER)

    def test_browser_falls_back_to_pdf_render(self):
        self.assertIn("'/api/page-image/'",APP)
        self.assertIn("await documentPDF.getPage(n)",APP)
        self.assertIn("img.onerror=reject",APP)

    def test_image_dependencies(self):
        self.assertIn("PyMuPDF",REQUIREMENTS)
        self.assertIn("Pillow",REQUIREMENTS)


if __name__=='__main__':
    unittest.main()
