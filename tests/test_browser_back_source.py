"""Source regression checks for browser Back handling in the reader."""
from pathlib import Path
import unittest

APP=(Path(__file__).resolve().parents[1]/'static'/'app.js').read_text()

class BrowserBackTests(unittest.TestCase):
    def test_open_reader_pushes_one_history_entry(self):
        self.assertIn("if(history.state?.pdfId!==item.id)history.pushState",APP)
        self.assertIn("readerHistoryActive=true",APP)

    def test_back_closes_reader_without_extra_navigation(self):
        self.assertIn("window.addEventListener('popstate'",APP)
        self.assertIn("closeReader({fromHistory:true})",APP)
        self.assertIn("if(!fromHistory&&readerHistoryActive)",APP)

    def test_existing_library_close_is_preserved(self):
        self.assertIn("$('reader').hidden=true",APP)
        self.assertIn("$('library').hidden=false",APP)
        self.assertIn("$('back').onclick=closeReader",APP)

if __name__=='__main__':
    unittest.main()
