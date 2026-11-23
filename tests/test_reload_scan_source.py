"""Verify PDF discovery is triggered on page reload without polling settings."""
from pathlib import Path
import unittest

ROOT=Path(__file__).resolve().parents[1]
APP=(ROOT/'static/app.js').read_text()
HTML=(ROOT/'static/index.html').read_text()

class ReloadScanTests(unittest.TestCase):
    def test_reload_scans_folder(self):
        self.assertIn("applyPrefs();refresh();",APP)
        self.assertIn("api('/api/library?refresh=1')",APP)

    def test_polling_setting_removed(self):
        self.assertNotIn('pref-interval',HTML)
        self.assertNotIn('prefs.interval',APP)
        self.assertNotIn('pollTimer',APP)

    def test_manual_refresh_button_removed(self):
        self.assertNotIn('id="refresh"',HTML)
        self.assertNotIn("$('refresh').onclick",APP)

if __name__=='__main__':
    unittest.main()
