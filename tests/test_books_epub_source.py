"""Source regression tests for EPUB client integration and PDF isolation."""
from pathlib import Path
import unittest
ROOT=Path(__file__).resolve().parents[1]
JS=(ROOT/'static/app.js').read_text()
EPUB=(ROOT/'static/epub-reader.js').read_text()
HTML=(ROOT/'static/index.html').read_text()
SERVER=(ROOT/'server.py').read_text()

class EpubClientChecks(unittest.TestCase):
 def test_book_source_and_reader_controls(self):
  self.assertIn('<option value="books">Books</option>',HTML)
  self.assertIn('id="epub-reader"',HTML)
  for control in ('epub-prev','epub-next','epub-chapters','epub-font-larger','epub-font-smaller','epub-slider','epub-theme'):
   self.assertIn('id="'+control+'"',HTML)
 def test_pdf_webp_and_pinch_unchanged(self):
  self.assertIn("function renderPages()",JS)
  self.assertIn("function finishPinch(cancelled=false)",JS)
  self.assertIn("function openMagazine(item,start)",JS)
  self.assertIn("function pdfEngine()",JS)
  self.assertIn("function openDocument(item,start)",JS)
  self.assertIn("isEpub(item)?openEpubBook(item,start):openMagazine(item,start)",JS)
 def test_epub_safe_rendering_and_resume(self):
  self.assertIn('allowScriptedContent:false',EPUB)
  self.assertIn("epubCfi",JS)
  self.assertIn("epubCfi",SERVER)
  self.assertIn("book.locations.generate(1600)",EPUB)
  self.assertIn("async function openEpubBook(item,start)",JS)
  self.assertIn("function closeEpubBook(",JS)
 def test_drmless_and_formats(self):
  self.assertIn("validate_epub(temporary)",SERVER)
  self.assertIn("fmt=='epub' and source!='books'",SERVER)
  self.assertIn("Only PDF pages can be rendered as WebP.",SERVER)

if __name__=='__main__': unittest.main()
