"""Regression guards for WebP caching and browser memory management."""
from pathlib import Path
import unittest

ROOT=Path(__file__).resolve().parents[1]
SERVER=(ROOT/'server.py').read_text()
APP=(ROOT/'static/app.js').read_text()


class SmartCacheTests(unittest.TestCase):
    def test_byte_limited_cache(self):
        self.assertIn("max_bytes=512*1024*1024",SERVER)
        self.assertIn("total=sum(p.stat().st_size for p in entries)",SERVER)
        self.assertIn("if old==target: continue",SERVER)
        self.assertIn("os.utime(target,None)",SERVER)

    def test_adjacent_prefetch(self):
        self.assertIn("page-1,page+1,page+2",APP)
        self.assertIn("function preloadMagazineNeighbors()",APP)
        self.assertIn("preloadMagazineNeighbors();",APP)

    def test_release_distant_images(self):
        self.assertIn("for(const img of slot.querySelectorAll('img')){img.src='';}",APP)
        self.assertIn("function clearMagazinePrefetches()",APP)
        self.assertIn("async function closeReader(){clearMagazinePrefetches();",APP)


if __name__=='__main__':
    unittest.main()
