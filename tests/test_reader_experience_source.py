"""Regression checks for PiShelf mobile reader improvements."""
from pathlib import Path
import unittest

ROOT=Path(__file__).resolve().parents[1]
HTML=(ROOT/'static/index.html').read_text()
JS=(ROOT/'static/app.js').read_text()
CSS=(ROOT/'static/style.css').read_text()

class ReaderExperienceTests(unittest.TestCase):
    def test_page_scrubber(self):
        self.assertIn('id="reader-page-slider"',HTML)
        self.assertIn("$('reader-page-slider').max=documentPDF.numPages",JS)
        self.assertIn("$('reader-page-slider').addEventListener('input'",JS)
        self.assertIn("$('reader-page-slider').addEventListener('change'",JS)
        self.assertIn("move(Math.max(1,Math.min(documentPDF.numPages",JS)
    def test_smart_zoom_preserves_pinch(self):
        self.assertIn('function smartDoubleTapZoom(clientX,clientY)',JS)
        self.assertIn('const next=zoom>1.35?1:2;',JS)
        self.assertIn('function finishPinch(cancelled=false)',JS)
        self.assertIn("addEventListener('touchstart'",JS)
        self.assertIn("addEventListener('touchmove'",JS)
        self.assertIn("addEventListener('touchend'",JS)
        self.assertIn('smartDoubleTapZoom(e.clientX,e.clientY)',JS)
    def test_immersive_controls(self):
        self.assertIn('id="reader-focus"',HTML)
        self.assertIn('function scheduleImmersiveHide()',JS)
        self.assertIn("setTimeout(()=>{if(documentPDF",JS)
        self.assertIn('function toggleReaderControls()',JS)
        self.assertIn('clearTimeout(immersiveTimer)',JS)
    def test_comfort_presets(self):
        self.assertIn('id="pref-comfort"',HTML)
        for preset in ('daylight','bedtime','amoled'):
            self.assertIn("value=\""+preset+"\"",HTML)
        self.assertIn("const comfortPresets=",JS)
        self.assertIn("prefs.comfort=name;",JS)
        self.assertIn('readerBrightness',JS)
        self.assertIn('data-page-theme=amoled',CSS)
    def test_webp_reader_unchanged(self):
        self.assertIn('function renderPages()',JS)
        self.assertIn('cancelAllSharpImages()',JS)
        self.assertIn('function finishPinch(cancelled=false)',JS)

if __name__=='__main__': unittest.main()
