"""Source-level regression checks for PiShelf authentication boundaries."""
from pathlib import Path
import unittest
import sqlite3
import hashlib
import sys
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
import auth

ROOT=Path(__file__).resolve().parents[1]
SERVER=(ROOT/'server.py').read_text()
AUTH=(ROOT/'auth.py').read_text()
JS=(ROOT/'static/app.js').read_text()

class AuthenticationSourceTests(unittest.TestCase):
    def test_pdf_and_api_gets_require_session(self):
        self.assertIn("user=self.require_session(admin=path in ('/admin.html','/admin.js'))",SERVER)
        self.assertIn("if path not in ('/login.html','/login.js','/setup.html','/setup.js'):",SERVER)
    def test_only_reader_progress_and_annotations_allow_member_mutations(self):
        self.assertIn("self.require_session(admin=route not in ('/api/progress','/api/annotations','/api/tts/edge'),mutation=True)",SERVER)
        self.assertNotIn("if route == '/api/tts/alba':",SERVER)
        self.assertIn("if route == '/api/annotations':",SERVER)
        self.assertIn("user=self.require_session(mutation=True)",SERVER)
        self.assertNotIn("if(signedInUser?.role!=='admin')",JS)
    def test_passwords_hashed_and_sessions_expire(self):
        self.assertIn('hashlib.pbkdf2_hmac',AUTH)
        self.assertIn('ITERATIONS = 600_000',AUTH)
        self.assertEqual(auth.SESSION_SECONDS,30 * 24 * 3600)
        self.assertIn('secrets.token_urlsafe(48)',AUTH)
        self.assertIn('hmac.compare_digest',AUTH)
    def test_session_limit_and_expiration(self):
        with sqlite3.connect(':memory:') as db:
            auth.initialize(db)
            auth.create_user(db,'reader1','test-password-123','reader')
            auth.create_user(db,'reader2','test-password-456','reader')
            first,_=auth.new_session(db,1,'Test browser')
            other,_=auth.new_session(db,2,'Other browser')
            for _ in range(5):
                latest,_=auth.new_session(db,1,'Test browser')
            self.assertEqual(db.execute('SELECT COUNT(*) FROM auth_sessions WHERE user_id=1').fetchone()[0],5)
            self.assertIsNone(auth.session(db,{'Cookie':'pishelf_session='+first}))
            self.assertIsNotNone(auth.session(db,{'Cookie':'pishelf_session='+other}))
            self.assertIsNotNone(auth.session(db,{'Cookie':'pishelf_session='+latest}))
            digest=hashlib.sha256(latest.encode()).hexdigest()
            created,expires=db.execute('SELECT created,expires FROM auth_sessions WHERE token_hash=?',(digest,)).fetchone()
            self.assertAlmostEqual(expires-created,30*24*3600,delta=1)
            db.execute('UPDATE auth_sessions SET expires=0 WHERE token_hash=?',(digest,))
            self.assertIsNone(auth.session(db,{'Cookie':'pishelf_session='+latest}))
    def test_csrf_and_cookie_protections(self):
        self.assertIn('X-PiShelf-CSRF',SERVER)
        self.assertIn('SameSite=Strict',SERVER)
        self.assertIn('HttpOnly',SERVER)
    def test_first_run_browser_setup(self):
        self.assertIn("if route=='/api/auth/setup':",SERVER)
        self.assertIn("db.execute('BEGIN IMMEDIATE')",SERVER)
        self.assertIn("if db.execute('SELECT 1 FROM auth_users LIMIT 1').fetchone()",SERVER)
        self.assertIn("self.is_private_setup_client()",SERVER)
        self.assertIn("path == '/api/auth/setup-status'",SERVER)
        self.assertIn("'/setup.html' if needs_setup else '/login.html'",SERVER)
        self.assertTrue((ROOT/'static/setup.html').is_file())
        self.assertTrue((ROOT/'static/setup.js').is_file())
    def test_admin_bootstrap_no_default_password(self):
        self.assertIn('getpass.getpass',AUTH)
        self.assertIn('Admin already exists',AUTH)
        self.assertNotIn('admin123',AUTH)
    def test_client_initializes_after_login(self):
        self.assertIn("signedInUser=await api('/api/auth/me')",JS)
        self.assertIn("location.replace('/login.html')",JS)

if __name__=='__main__':
    unittest.main()
