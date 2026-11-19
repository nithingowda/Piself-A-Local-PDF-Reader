"""Prevent browser initialization crashes caused by references to removed controls."""
from pathlib import Path
import re
import unittest

ROOT=Path(__file__).resolve().parents[1]

class BrowserStartupTests(unittest.TestCase):
    def test_referenced_controls_exist(self):
        script=(ROOT/'static/app.js').read_text()
        html=(ROOT/'static/index.html').read_text()
        ids=set(re.findall(r"\$\('([^']+)'\)",script))
        missing=sorted(i for i in ids if f'id="{i}"' not in html)
        self.assertEqual(missing,[])

    def test_removed_interval_not_bound(self):
        script=(ROOT/'static/app.js').read_text()
        self.assertNotIn("'density','interval'",script)
        self.assertNotIn("pref-interval",script)
        self.assertIn('applyPrefs();refresh();',script)

if __name__=='__main__':
    unittest.main()
