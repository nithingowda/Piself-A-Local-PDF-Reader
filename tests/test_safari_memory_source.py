"""Regression checks for reader image memory and library startup safety."""
from pathlib import Path
import re
import unittest

ROOT=Path(__file__).resolve().parents[1]
JS=(ROOT/'static/app.js').read_text(encoding='utf-8')
HTML=(ROOT/'static/index.html').read_text(encoding='utf-8')
README=(ROOT/'README.md').read_text(encoding='utf-8')
MANUAL=(ROOT/'USER_MANUAL.md').read_text(encoding='utf-8')

class PerformanceSafetyTests(unittest.TestCase):
    def test_no_missing_static_controls(self):
        ids=set(re.findall(r"\$\('([^']+)'\)",JS))
        self.assertEqual(sorted(i for i in ids if f'id="{i}"' not in HTML),[])

    def test_reader_memory_cleanup(self):
        self.assertIn('const pendingSharpImages=new Map()',JS)
        self.assertIn('cancelSharpImage(slot);for(const c',JS)
        self.assertIn('async function rebuild(){if(!documentPDF)return;cancelAllSharpImages();',JS)
        self.assertIn('clearMagazinePrefetches();cancelAllSharpImages();resetPinch()',JS)
        self.assertIn('slot.firstChild===img&&!pinch',JS)

    def test_lazy_thumbnails(self):
        self.assertIn("img.dataset.src='/api/page-image/'",JS)
        self.assertIn('new IntersectionObserver(entries=>',JS)
        self.assertIn("root:grid,rootMargin:'180px'",JS)

    def test_reader_core_unchanged(self):
        for name in ('finishPinch','fitEntirePageZoom','openMagazine','rebuild','refresh'):
            self.assertRegex(JS,rf'function {name}\(')
        self.assertIn('applyPrefs();refresh();',JS)

    def test_manual_pdf_folder_instructions(self):
        self.assertIn('USER_MANUAL.md',README)
        self.assertIn('MAGAZINE_DIR=',MANUAL)
        self.assertIn('NEWSPAPER_DIR=',MANUAL)
        self.assertIn('docker compose up -d --build',MANUAL)
        self.assertIn('No magazines appear',MANUAL)

if __name__=='__main__':
    unittest.main()
