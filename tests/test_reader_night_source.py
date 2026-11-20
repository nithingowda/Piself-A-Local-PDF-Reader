"""Regression checks for iPhone-friendly night and AMOLED reader themes."""
from pathlib import Path
import unittest
ROOT=Path(__file__).resolve().parents[1]
HTML=(ROOT/'static/index.html').read_text()
JS=(ROOT/'static/app.js').read_text()
CSS=(ROOT/'static/style.css').read_text()
class NightReaderTests(unittest.TestCase):
 def test_quick_toggle_and_brightness(self):
  self.assertIn('id="reader-night-toggle"',HTML)
  self.assertIn('id="pref-readerBrightness"',HTML)
  self.assertIn("readerBrightness:75",JS)
  self.assertIn("lastDayTheme",JS)
 def test_webp_and_pdfjs_are_both_filtered(self):
  for theme in ('night','amoled'):
   self.assertIn(f'#reader[data-page-theme={theme}] #pages img',CSS)
   self.assertIn(f'#reader[data-page-theme={theme}] #pages canvas',CSS)
  self.assertIn('invert(1) hue-rotate(180deg)',CSS)
 def test_no_pdf_render_changes(self):
  self.assertIn('function renderPages()',JS)
  self.assertIn('function rebuild()',JS)
if __name__=='__main__':unittest.main()
