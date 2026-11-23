"""Protect thumbnail routing and PDF reader isolation against regressions."""
import unittest
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]
SERVER=(ROOT/'server.py').read_text()
CLIENT=(ROOT/'static/app.js').read_text()
DOCKER=(ROOT/'Dockerfile').read_text()


class CoverSourceTests(unittest.TestCase):
    def test_no_broken_render_page_fallback(self):
        self.assertNotIn("'/api/render-page?",CLIENT)
        self.assertIn("'/api/page-image/'+encodeURIComponent(item.id)+'/1?width=400'",CLIENT)
        self.assertIn("width not in (400,960,1600,2800)",SERVER)

    def test_embedded_epub_cover_path(self):
        self.assertNotIn("if(isEpub(item))continue;",CLIENT)
        self.assertIn("'/api/epub-cover/'+encodeURIComponent(item.id)",CLIENT)
        self.assertIn("path.startswith('/api/epub-cover/')",SERVER)
        self.assertIn("from epub_covers import embedded_cover_jpeg",SERVER)
        self.assertIn("COPY --chown=1000:1000 epub_covers.py /app/epub_covers.py",DOCKER)

    def test_reader_unmodified(self):
        self.assertIn("function finishPinch(cancelled=false)",CLIENT)
        self.assertIn("function renderPages()",CLIENT)
        self.assertIn("async function zoomWithControls(targetZoom,tap)",CLIENT)
        self.assertNotIn("function smartDoubleTapZoom(",CLIENT)
        self.assertIn("function openEpubBook(item,start)",CLIENT)


if __name__=='__main__':
    unittest.main()
