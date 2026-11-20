"""Regression checks for two-page book spread and page-turn navigation."""
from pathlib import Path
import unittest

ROOT=Path(__file__).resolve().parents[1]
JS=(ROOT/'static/app.js').read_text()
HTML=(ROOT/'static/index.html').read_text()
CSS=(ROOT/'static/style.css').read_text()
SERVER=(ROOT/'server.py').read_text()

class BookSpreadTests(unittest.TestCase):
 def test_two_page_option_in_reader_and_settings(self):
  self.assertEqual(HTML.count('<option value="book">'),2)
  self.assertIn('id="book-turn-prev"',HTML)
  self.assertIn('id="book-turn-next"',HTML)
  self.assertIn("value['mode'] not in ('scroll','single','book')",SERVER)
 def test_cover_and_pair_layout(self):
  self.assertIn('function spreadStart(n)',JS)
  self.assertIn('function spreadPages(n)',JS)
  self.assertIn("return first===1?[1]:[first,first+1].filter(p=>p<=last)",JS)
  self.assertIn("const spread=el('div','book-spread')",JS)
  self.assertIn("for(const n of spreadPages(page))",JS)
  self.assertIn("slots.push(slot);spread.append(slot)",JS)
  self.assertIn("if(isBookSpread())for(const slot of slots)enqueue(slot)",JS)
 def test_book_controls_swipe_and_preload(self):
  self.assertIn('function turnBook(direction)',JS)
  self.assertIn("$('book-turn-prev').onclick=()=>turnFromControl(-1)",JS)
  self.assertIn("$('book-turn-next').onclick=()=>turnFromControl(1)",JS)
  self.assertIn("turnBook(dx<0?1:-1)",JS)
  self.assertIn('function preloadMagazineNeighbors()',JS)
  self.assertIn('const prefetched=takeDecodedPreview(n)',JS)
  self.assertNotIn('activePageTurn',JS)
  self.assertNotIn('PAPER_TURN_DURATION_MS',JS)
  self.assertNotIn('clearBookPaperSwipe',JS)
  self.assertNotIn('paper-turning',CSS)
  self.assertNotIn('pishelf-leaf-forward',CSS)
  self.assertIn('if(isBookSpread())await primeSpreadDimensions(spreadPages(page),doc,g)',JS)
 def test_existing_modes_and_webp_safari_pinch_preserved(self):
  self.assertIn("mode==='single'?page:1",JS)
  self.assertIn("mode==='single'?page:count",JS)
  self.assertIn('function finishPinch(cancelled=false)',JS)
  self.assertIn("addEventListener('touchstart'",JS)
  self.assertIn("addEventListener('touchmove'",JS)
  self.assertIn("addEventListener('touchend'",JS)
  self.assertIn('function renderPages()',JS)
  self.assertIn('function zoomWithControls(targetZoom)',JS)
  self.assertIn("function openEpubBook(item,start)",JS)

if __name__=='__main__':
 unittest.main()
