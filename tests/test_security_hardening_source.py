"""Security hardening regression checks; no network needed."""
from pathlib import Path
import unittest

SERVER=(Path(__file__).resolve().parents[1]/'server.py').read_text()

class SecurityHardeningTests(unittest.TestCase):
    def test_conversion_limits(self):
        for text in ('MAX_RENDER_PIXELS','MAX_PDF_PAGE_DIMENSION','MAX_WEBP_SOURCE_BYTES','width*target_height > MAX_RENDER_PIXELS','pix.width*pix.height > MAX_RENDER_PIXELS'):
            self.assertIn(text,SERVER)
    def test_browser_headers(self):
        for header in ('Content-Security-Policy','X-Frame-Options','Referrer-Policy','frame-ancestors', 'worker-src'):
            self.assertIn(header,SERVER)
    def test_no_exception_leak_to_client(self):
        self.assertNotIn("'Image conversion failed: '+str(exc)",SERVER)
        self.assertIn("logging.exception('PiShelf WebP conversion failed')",SERVER)
    def test_cache_clear_rejects_unexpected_bodies(self):
        self.assertIn("self.headers.get('Transfer-Encoding')",SERVER)
        self.assertIn("Cache clear expects an empty JSON object.",SERVER)

if __name__=='__main__':
    unittest.main()
