"""Source regression checks for incremental reader enhancements."""
from pathlib import Path
import unittest

ROOT=Path(__file__).resolve().parents[1]
JS=(ROOT/'static/app.js').read_text()
HTML=(ROOT/'static/index.html').read_text()
SERVER=(ROOT/'server.py').read_text()

class ReaderEnhancementTests(unittest.TestCase):
    def test_lazy_dimensions(self):
        self.assertIn('const first=await doc.getPage(page)',JS)
        self.assertIn('if(n%4===0)await new Promise',JS)
        self.assertIn('if(before.bottom<=top)area.scrollTop+=',JS)

    def test_progress(self):
        self.assertIn('id="reader-progress-fill"',HTML)
        self.assertIn('page/documentPDF.numPages*100',JS)

    def test_thumbnails(self):
        self.assertIn('id="thumbnail-dialog"',HTML)
        self.assertIn('Math.min(count,begin+59)',JS)
        self.assertIn('button.onclick=()=>{',JS)

    def test_progressive_images(self):
        self.assertIn("const previewUrl='/api/page-image/'",JS)
        self.assertIn('slot.firstChild===img&&!pinch',JS)
        self.assertIn('function finishPinch(',JS)

    def test_cache_api(self):
        self.assertIn("path == '/api/webp-cache'",SERVER)
        self.assertIn("path == '/api/webp-cache/clear'",SERVER)
        self.assertIn('WEBP_CACHE_LOCK = threading.RLock()',SERVER)
        self.assertIn('id="cache-clear"',HTML)

    def test_original_zoom_and_history_remain(self):
        self.assertIn('function fitEntirePageZoom(',JS)
        self.assertIn('function finishPinch(',JS)
        self.assertIn("history.pushState({pishelfReader:true,pdfId:item.id}",JS)

if __name__=='__main__':
    unittest.main()
