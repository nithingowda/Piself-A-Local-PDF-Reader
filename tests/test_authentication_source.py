"""Source-level regression checks for PiShelf authentication boundaries."""
from pathlib import Path
import unittest

ROOT=Path(__file__).resolve().parents[1]
SERVER=(ROOT/'server.py').read_text()
AUTH=(ROOT/'auth.py').read_text()
JS=(ROOT/'static/app.js').read_text()

class AuthenticationSourceTests(unittest.TestCase):
    def test_pdf_and_api_gets_require_session(self):
        self.assertIn("user=self.require_session(admin=path in ('/admin.html','/admin.js'))",SERVER)
        self.assertIn("if path not in ('/login.html','/login.js'):",SERVER)
    def test_all_non_auth_mutations_admin_only(self):
        self.assertIn('self.require_session(admin=True,mutation=True)',SERVER)
    def test_passwords_hashed_and_sessions_expire(self):
        self.assertIn('hashlib.pbkdf2_hmac',AUTH)
        self.assertIn('ITERATIONS = 600_000',AUTH)
        self.assertIn('SESSION_SECONDS = 12 * 3600',AUTH)
        self.assertIn('secrets.token_urlsafe(48)',AUTH)
        self.assertIn('hmac.compare_digest',AUTH)
    def test_csrf_and_cookie_protections(self):
        self.assertIn('X-PiShelf-CSRF',SERVER)
        self.assertIn('SameSite=Strict',SERVER)
        self.assertIn('HttpOnly',SERVER)
    def test_admin_bootstrap_no_default_password(self):
        self.assertIn('getpass.getpass',AUTH)
        self.assertIn('Admin already exists',AUTH)
        self.assertNotIn('admin123',AUTH)
    def test_client_initializes_after_login(self):
        self.assertIn("signedInUser=await api('/api/auth/me')",JS)
        self.assertIn("location.replace('/login.html')",JS)

if __name__=='__main__':
    unittest.main()
