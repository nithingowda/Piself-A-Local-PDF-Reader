# server.py: PiShelf HTTP server, library APIs, file access, and reading progress.
# Comments explain responsibilities and non-obvious behavior; keep runtime logic unchanged.

#!/usr/bin/env python3
"""PiShelf: a local PDF library with durable reading state and recoverable trash."""
import argparse
import hashlib
import json
import mimetypes
import logging
import os
import re
import shutil
import errno
import sqlite3
import threading
import time
import uuid
import datetime
import zipfile
import zlib
import auth
import secrets
import hmac
import subprocess
import tempfile
import asyncio

# Bound concurrent external synthesis calls to protect the server and remote service.
EDGE_TTS_SLOTS=threading.BoundedSemaphore(2)

# Optional raster engine is installed in Docker; errors are reported per request.
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlsplit, quote, parse_qs

BASE = Path(__file__).resolve().parent
# Serialize WebP conversions, cache eviction and clearing across HTTP threads.
WEBP_CACHE_LOCK = threading.RLock()
WEBP_CACHE_LIMIT = 512*1024*1024
# Keep malicious or malformed PDF dimensions from exhausting server memory.
MAX_RENDER_PIXELS = 16_000_000
MAX_PDF_PAGE_DIMENSION = 20_000
MAX_WEBP_SOURCE_BYTES = 512*1024*1024

class APIError(Exception):
    #   init  : handle this step of the server request or library workflow.
    def __init__(self, status, message):
        self.status, self.message = status, message

def save_library_paths(db, values, defaults, data_dir):
    if not isinstance(values, dict) or set(values)-{'magazines','newspapers','books'}:
        raise APIError(400,'Invalid library paths.')
    roots = dict(defaults)
    for source, raw in values.items():
        if not isinstance(raw,str):
            raise APIError(400,'Enter a folder path.')
        if not raw.strip():
            roots.pop(source,None)
            continue
        path = Path(raw.strip())
        if not path.is_absolute() or not path.is_dir() or not os.access(path,os.R_OK|os.X_OK):
            raise APIError(400,f'{source}: enter an existing, readable absolute folder path.')
        roots[source] = path.resolve()
    if 'magazines' not in roots:
        raise APIError(400,'A magazine folder is required.')
    for source,path in roots.items():
        protected = [data_dir]+[p for key,p in roots.items() if key!=source]
        if any(path.is_relative_to(p) or p.is_relative_to(path) for p in protected):
            raise APIError(400,'Library folders and the data folder must be separate.')
    db.execute('INSERT OR REPLACE INTO library_config VALUES (1,?)',
               (json.dumps({k:str(v) for k,v in roots.items()}),))
    return roots

class Handler(BaseHTTPRequestHandler):
    # json response: handle this step of the server request or library workflow.
    def json_response(self, value, status=200, head=False):
        body = json.dumps(value).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.security_headers()
        self.end_headers()
        if not head: self.wfile.write(body)

    # Browser hardening shared by JSON, WebP and static/PDF responses.
    # CSP is intentionally conservative but permits the current inline app UI.
    def security_headers(self):
        self.send_header('X-Frame-Options','DENY')
        self.send_header('Referrer-Policy','no-referrer')
        self.send_header('X-Content-Type-Options','nosniff')
        self.send_header('Content-Security-Policy',"default-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'; img-src 'self' data: blob:; connect-src 'self' https://cdn.jsdelivr.net; worker-src 'self' blob: https://cdn.jsdelivr.net; script-src 'self' https://cdn.jsdelivr.net 'unsafe-inline'; style-src 'self' 'unsafe-inline'")

    # library items: handle this step of the server request or library workflow.
    def library_items(self):
        with self.server.scan_lock:
            if time.monotonic() - self.server.scan_time < 10:
                return self.server.scan_items
            items = []
            categories = []
            with sqlite3.connect(self.server.state_db) as db:
                metadata = {key: json.loads(raw) for key, raw in db.execute('SELECT id,value FROM metadata')}
            for source, root in self.server.roots.items():
                for folder, dirs, files in os.walk(root, followlinks=False):
                    dirs[:] = [d for d in dirs if not d.startswith('.') and not (Path(folder)/d).is_symlink()]
                    categories.append(dict(source=source,path=Path(folder).relative_to(root).as_posix()))
                    for name in files:
                        path = Path(folder)/name
                        if name.startswith('.') or path.is_symlink(): continue
                        fmt=path.suffix.lower().lstrip('.')
                        if fmt not in ('pdf','epub') or (fmt=='epub' and source!='books'): continue
                        try:
                            if not path.resolve().is_relative_to(root): continue
                            info = path.stat()
                        except OSError: continue
                        relative = path.relative_to(root).as_posix()
                        key = item_id(source, relative)
                        inferred = infer_issue(path.stem)
                        inferred.update({k:v for k,v in metadata.get(key, {}).items() if k != 'series' or v})
                        cover_key = hashlib.sha256(f'{key}:{info.st_mtime_ns}:{info.st_size}'.encode()).hexdigest()
                        items.append(dict(id=key, path=relative, title=path.stem.replace('_',' '), source=source,
                            category=path.parent.relative_to(root).as_posix(), size=info.st_size,
                            modified=info.st_mtime, coverKey=cover_key, format=fmt, **inferred))
            self.server.scan_items = sorted(items, key=lambda i:(i['source'],i['path']))
            self.server.scan_categories = categories
            self.server.scan_time = time.monotonic()
            return self.server.scan_items

    # categories: handle this step of the server request or library workflow.
    def categories(self):
        self.library_items()
        return self.server.scan_categories

    # upload pdf: handle this step of the server request or library workflow.
    def upload_pdf(self):
        params=parse_qs(urlsplit(self.path).query)
        source=params.get('source',['magazines'])[0]
        category=params.get('category',['.'])[0]
        filename=params.get('filename',[''])[0]
        root=self.server.roots.get(source)
        if root is None: raise APIError(400,'Unknown library source.')
        fmt=Path(filename).suffix.lower()
        if fmt not in ('.pdf','.epub') or (fmt=='.epub' and source!='books') or '/' in filename or '\\' in filename:
            raise APIError(400,'Choose a PDF, or an EPUB for Books, without slashes.')
        safe_relative(filename)
        if category != '.': safe_relative(category)
        destination=checked_path(root,(Path(category)/filename).as_posix())
        length=int(self.headers.get('Content-Length','0'))
        if not 0 < length <= (100 if fmt=='.epub' else 512)*1024*1024: raise APIError(413,'PDF limit is 512 MiB; EPUB book limit is 100 MiB.')
        expected='application/epub+zip' if fmt=='.epub' else 'application/pdf'
        if self.headers.get_content_type() != expected: raise APIError(400,'Unexpected file content type.')
        # A dedicated upload lock serializes large writes without blocking reading-state saves.
        with self.server.upload_lock:
            if destination.exists(): raise APIError(409,'A document with this filename already exists. Rename it before uploading.')
            destination.parent.mkdir(parents=True,exist_ok=True)
            temporary=destination.parent/('.pishelf-upload-'+uuid.uuid4().hex)
            old_timeout=self.connection.gettimeout()
            self.connection.settimeout(60)
            try:
                with temporary.open('xb') as output:
                    remaining=length
                    first=True
                    while remaining:
                        chunk=self.rfile.read(min(256*1024,remaining))
                        if not chunk: raise APIError(400,'Upload interrupted. No PDF was added.')
                        if first and fmt=='.pdf' and not re.match(rb'%PDF-[0-9]\.[0-9]',chunk): raise APIError(400,'This file does not have a PDF header.')
                        if first and fmt=='.epub' and not chunk.startswith(b'PK\x03\x04'): raise APIError(400,'This EPUB is not a ZIP archive.')
                        first=False
                        output.write(chunk);remaining-=len(chunk)
                if fmt=='.epub': validate_epub(temporary)
                with self.server.mutation_lock:
                    # A session can expire or lose admin access during a long transfer.
                    self.require_session(admin=True,mutation=True)
                    checked_path(root,(Path(category)/filename).as_posix())
                    # Exclusive move refuses to replace a file created during the upload.
                    try: move_exclusive(temporary,destination)
                    except FileExistsError: raise APIError(409,'A PDF with this filename already exists.')
                    self.server.scan_time=float('-inf')
            finally:
                self.connection.settimeout(old_timeout)
                temporary.unlink(missing_ok=True)
        self.json_response({'ok':True,'id':item_id(source,destination.relative_to(root).as_posix())},201)

    # accept origin: handle this step of the server request or library workflow.
    def accept_origin(self):
        origin = self.headers.get('Origin')
        if (origin and urlsplit(origin).netloc != self.headers.get('Host')) or self.headers.get('Sec-Fetch-Site') == 'cross-site':
            raise APIError(403, 'Cross-origin changes are not allowed.')

    # cache cover: handle this step of the server request or library workflow.
    def cache_cover(self):
        key = urlsplit(self.path).path.rsplit('/',1)[-1]
        if not re.fullmatch('[a-f0-9]{64}', key): raise APIError(400, 'Invalid cover key.')
        length = int(self.headers.get('Content-Length', '0'))
        if not 0 < length <= 524288 or self.headers.get_content_type() != 'image/jpeg':
            raise APIError(400, 'Expected a JPEG cover up to 512 KB.')
        if not any(i['coverKey'] == key for i in self.library_items()): raise APIError(404, 'Issue no longer exists.')
        content = self.rfile.read(length)
        if len(content) != length or not content.startswith(b'\xff\xd8') or not content.endswith(b'\xff\xd9'):
            raise APIError(400, 'Invalid JPEG cover.')
        with self.server.cover_lock:
            destination = self.server.cover_dir/(key+'.jpg')
            previous_size = destination.stat().st_size if destination.exists() else 0
            temporary = self.server.cover_dir/(uuid.uuid4().hex+'.tmp')
            try:
                temporary.write_bytes(content)
                temporary.replace(destination)
            finally:
                temporary.unlink(missing_ok=True)
            self.server.cover_bytes += len(content) - previous_size
            if self.server.cover_bytes > 256*1024*1024:
                files = sorted(self.server.cover_dir.glob('*.jpg'), key=lambda p:p.stat().st_mtime)
                for old in files:
                    if self.server.cover_bytes <= 256*1024*1024: break
                    self.server.cover_bytes -= old.stat().st_size
                    old.unlink(missing_ok=True)
        self.json_response({'ok':True})


    # === Authentication / role permissions ===================================
    def require_session(self, admin=False, mutation=False):
        with sqlite3.connect(self.server.state_db) as db:
            user=auth.session(db,self.headers)
        if not user: raise APIError(401,'Login required.')
        if admin and user['role']!='admin': raise APIError(403,'Administrator permission required.')
        if mutation and not secrets.compare_digest(self.headers.get('X-PiShelf-CSRF',''),user['csrf']):
            raise APIError(403,'Invalid security token.')
        return user

    def is_private_setup_client(self):
        # Private network restriction limits accidental public setup exposure.
        # Reverse proxies may mask public clients as local: keep PiShelf private.
        import ipaddress
        try:
            address=ipaddress.ip_address(self.client_address[0])
            return address.is_loopback or (address.is_private and not address.is_link_local)
        except ValueError:
            return False

    def auth_post(self,route):
        length=int(self.headers.get('Content-Length','0'))
        if self.headers.get('Transfer-Encoding') or not 0<length<=4096 or self.headers.get_content_type()!='application/json':
            raise APIError(400,'Invalid authentication request.')
        data=json.loads(self.rfile.read(length))
        if not isinstance(data,dict): raise APIError(400,'Invalid request.')
        if route=='/api/auth/setup':
            # First-run setup is restricted to the host or private LAN.
            # Serialize setup requests to prevent two simultaneous first admins.
            with self.server.auth_lock:
                with sqlite3.connect(self.server.state_db) as db:
                    db.execute('BEGIN IMMEDIATE')
                    if db.execute('SELECT 1 FROM auth_users LIMIT 1').fetchone():
                        raise APIError(409,'Setup is complete. Sign in instead.')
                    if not self.is_private_setup_client():
                        raise APIError(403,'Initial setup requires access from your private network.')
                    auth.create_user(db,data.get('username'),data.get('password'),'admin')
                    roots = save_library_paths(db,data['paths'],self.server.roots,self.server.state_db.parent) if data.get('paths') else self.server.roots
                self.server.roots=roots
                self.server.library=roots['magazines']
            self.json_response({'ok':True})
            return
        if route=='/api/auth/login':
            ip=self.client_address[0]
            with self.server.auth_lock:
                attempts=[t for t in self.server.auth_attempts.get(ip,[]) if t>time.time()-900]
                if len(attempts)>=8: raise APIError(429,'Too many login attempts. Try again later.')
                self.server.auth_attempts[ip]=attempts
            with sqlite3.connect(self.server.state_db) as db:
                user=auth.authenticate(db,data.get('username'),data.get('password'))
                if not user:
                    with self.server.auth_lock: self.server.auth_attempts[ip].append(time.time())
                    raise APIError(401,'Invalid username or password.')
                token,csrf=auth.new_session(db,user['id'])
            self.send_response(200)
            self.send_header('Content-Type','application/json')
            self.send_header('Cache-Control','no-store')
            cookie='pishelf_session='+token+'; HttpOnly; SameSite=Strict; Path=/; Max-Age='+str(auth.SESSION_SECONDS)
            if os.environ.get('PISHELF_COOKIE_SECURE')=='1': cookie+='; Secure'
            self.send_header('Set-Cookie',cookie)
            self.end_headers()
            self.wfile.write(json.dumps({'ok':True,'role':user['role'],'csrf':csrf}).encode())
            return
        user=self.require_session(admin=route.startswith('/api/admin/'),mutation=True)
        if route=='/api/admin/paths/pin':
            with sqlite3.connect(self.server.state_db) as db:
                db.execute('CREATE TABLE IF NOT EXISTS library_path_pin (id INTEGER PRIMARY KEY CHECK(id=1),salt BLOB NOT NULL,hash BLOB NOT NULL)')
                existing=db.execute('SELECT id FROM library_path_pin WHERE id=1').fetchone()
                pin=data.get('pin')
                if existing: raise APIError(409,'Access PIN is already configured.')
                if not auth.authenticate(db,user['username'],data.get('password')): raise APIError(403,'Administrator password is incorrect.')
                if not isinstance(pin,str) or not re.fullmatch(r'[0-9]{6}',pin): raise APIError(400,'Enter a 6-digit PIN.')
                salt=secrets.token_bytes(24)
                db.execute('INSERT INTO library_path_pin VALUES (1,?,?)',(salt,hashlib.pbkdf2_hmac('sha256',pin.encode(),salt,600000)))
            self.json_response({'ok':True});return
        if route in ('/api/admin/paths/verify','/api/admin/paths'):
            ip=self.client_address[0]
            with self.server.auth_lock:
                attempts=[t for t in self.server.auth_attempts.get('pin:'+ip,[]) if t>time.time()-900]
                self.server.auth_attempts['pin:'+ip]=attempts
                if len(attempts)>=5: raise APIError(429,'Too many incorrect PIN attempts. Try again in 15 minutes.')
        if route=='/api/admin/paths/verify':
            with sqlite3.connect(self.server.state_db) as db:
                db.execute('CREATE TABLE IF NOT EXISTS library_path_pin (id INTEGER PRIMARY KEY CHECK(id=1),salt BLOB NOT NULL,hash BLOB NOT NULL)')
                row=db.execute('SELECT salt,hash FROM library_path_pin WHERE id=1').fetchone()
                pin=data.get('pin')
                if not row or not isinstance(pin,str) or not re.fullmatch(r'[0-9]{6}',pin) or not hmac.compare_digest(hashlib.pbkdf2_hmac('sha256',pin.encode(),row[0],600000),row[1]):
                    with self.server.auth_lock: self.server.auth_attempts['pin:'+self.client_address[0]].append(time.time())
                    raise APIError(403,'Invalid access PIN.')
            self.json_response({'ok':True});return
        if route=='/api/admin/paths':
            with sqlite3.connect(self.server.state_db) as db:
                db.execute('CREATE TABLE IF NOT EXISTS library_path_pin (id INTEGER PRIMARY KEY CHECK(id=1),salt BLOB NOT NULL,hash BLOB NOT NULL)')
                row=db.execute('SELECT salt,hash FROM library_path_pin WHERE id=1').fetchone()
                if not row: raise APIError(403,'Set a folder access PIN before editing library paths.')
                pin=data.get('pin')
                if not isinstance(pin,str) or not re.fullmatch(r'[0-9]{6}',pin) or not hmac.compare_digest(hashlib.pbkdf2_hmac('sha256',pin.encode(),row[0],600000),row[1]):
                    with self.server.auth_lock: self.server.auth_attempts['pin:'+self.client_address[0]].append(time.time())
                    raise APIError(403,'Invalid access PIN.')
                save_library_paths(db,{k:v for k,v in data.items() if k!='pin'},self.server.roots,self.server.state_db.parent)
            self.json_response({'ok':True})
            return
        if route=='/api/auth/change-password':
            with sqlite3.connect(self.server.state_db) as db:
                verified=auth.authenticate(db,user['username'],data.get('current_password'))
                if not verified: raise APIError(403,'Current password is incorrect.')
                auth.validate_password(data.get('new_password'))
                salt=secrets.token_bytes(24)
                db.execute('UPDATE auth_users SET salt=?,password_hash=? WHERE id=?',
                           (salt,auth.password_hash(data['new_password'],salt),user['id']))
                auth.revoke_user(db,user['id'])
            self.json_response({'ok':True,'login_required':True})
            return
        if route=='/api/auth/logout':
            with sqlite3.connect(self.server.state_db) as db:
                db.execute('DELETE FROM auth_sessions WHERE token_hash=?',(user['token_hash'],))
            self.send_response(200)
            self.send_header('Set-Cookie','pishelf_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0')
            self.send_header('Content-Length','2')
            self.end_headers()
            self.wfile.write(b'{}')
            return
        if route=='/api/admin/users':
            action=data.get('action')
            with sqlite3.connect(self.server.state_db) as db:
                if action=='create':
                    try: auth.create_user(db,data.get('username'),data.get('password'),data.get('role','reader'))
                    except sqlite3.IntegrityError: raise APIError(409,'Username already exists.')
                elif action in ('disable','enable','reset-password','delete'):
                    uid=data.get('id')
                    if type(uid) is not int: raise APIError(400,'Invalid user ID.')
                    row=db.execute('SELECT role,enabled FROM auth_users WHERE id=?',(uid,)).fetchone()
                    if not row: raise APIError(404,'User not found.')
                    if uid==user['id']: raise APIError(403,'You cannot modify your own account here.')
                    if row[0]=='admin' and action in ('disable','delete'):
                        count=db.execute("SELECT COUNT(*) FROM auth_users WHERE role='admin' AND enabled=1").fetchone()[0]
                        if count<=1: raise APIError(403,'Cannot remove the last enabled administrator.')
                    if action=='reset-password':
                        auth.validate_password(data.get('password'))
                        salt=secrets.token_bytes(24)
                        db.execute('UPDATE auth_users SET salt=?,password_hash=? WHERE id=?',(salt,auth.password_hash(data['password'],salt),uid))
                    elif action=='delete':
                        db.execute('DELETE FROM auth_users WHERE id=?',(uid,))
                    else:
                        db.execute('UPDATE auth_users SET enabled=? WHERE id=?',(1 if action=='enable' else 0,uid))
                    auth.revoke_user(db,uid)
                else: raise APIError(400,'Invalid action.')
            self.json_response({'ok':True})
            return
        raise APIError(404,'Unknown authentication route.')

    # do POST: handle this step of the server request or library workflow.
    def do_POST(self):
        try:
            self.accept_origin()
            route=urlsplit(self.path).path
            if route.startswith('/api/auth/') or route.startswith('/api/admin/'):
                self.auth_post(route);return
            # Readers may save their reading position, bookmarks and favourites.
            # All other write endpoints remain administrator-only.
            self.require_session(admin=route not in ('/api/progress','/api/annotations','/api/tts/edge'),mutation=True)
            if route in ('/api/upload','/api/delete','/api/trash/delete'):
                lengths=self.headers.get_all('Content-Length',[])
                if (self.headers.get_all('Transfer-Encoding') or len(lengths)!=1
                        or not re.fullmatch(r'[0-9]{1,10}',lengths[0])):
                    self.close_connection=True
                    raise APIError(400,'A single valid content length is required.')
            if route == '/api/tts/edge':
                length=int(self.headers.get('Content-Length','0'))
                if self.headers.get_content_type()!='application/json' or not 0<length<=2048:
                    raise APIError(400,'Invalid speech request.')
                try:
                    data=json.loads(self.rfile.read(length))
                except (ValueError,UnicodeDecodeError):
                    raise APIError(400,'Invalid speech JSON.')
                phrase=data.get('text') if isinstance(data,dict) else None
                if not isinstance(phrase,str) or not phrase.strip() or len(phrase)>500:
                    raise APIError(400,'Speech text must be 1–500 characters.')
                selected_voice=data.get('voice','en-IN-NeerjaNeural')
                allowed_voices={'en-IN-NeerjaNeural','en-IN-PrabhatNeural','en-US-AriaNeural','en-US-GuyNeural','en-GB-SoniaNeural','en-GB-RyanNeural','en-AU-NatashaNeural'}
                if not isinstance(selected_voice,str) or selected_voice not in allowed_voices:
                    raise APIError(400,'Unsupported Edge voice.')
                # Reject excess work instead of accumulating expensive internet requests.
                if not EDGE_TTS_SLOTS.acquire(blocking=False):
                    raise APIError(429,'Too many speech requests. Please retry shortly.')
                try:
                    import edge_tts
                    async def generate_edge():
                        speech=edge_tts.Communicate(phrase,voice=selected_voice,boundary='SentenceBoundary')
                        audio=bytearray()
                        sentences=[]
                        async for part in speech.stream():
                            if part['type']=='audio':
                                audio.extend(part['data'])
                                if len(audio)>8*1024*1024:
                                    raise ValueError('Speech audio too large.')
                            elif part['type']=='SentenceBoundary' and len(sentences)<32:
                                # Edge offsets are in 100 ns ticks; send compact
                                # sentence timing without altering the MP3 response.
                                sentences.append([
                                    round(part['offset']/10_000_000,3),
                                    round(part['duration']/10_000_000,3),
                                    str(part['text'])[:500]
                                ])
                        return bytes(audio),sentences
                    body,sentences=asyncio.run(asyncio.wait_for(generate_edge(),timeout=30))
                except Exception as error:
                    logging.warning('Edge TTS unavailable: %s',type(error).__name__)
                    raise APIError(503,'Online Edge voice unavailable.')
                finally:
                    EDGE_TTS_SLOTS.release()
                if not body:
                    raise APIError(503,'Online Edge voice returned no audio.')
                self.send_response(200)
                self.send_header('Content-Type','audio/mpeg')
                self.send_header('Content-Length',str(len(body)))
                # Same-origin browser uses exact Edge sentence timestamps to
                # highlight one sentence at a time on the PDF/WebP page.
                timing=json.dumps(sentences,ensure_ascii=True,separators=(',',':'))
                if sentences and len(timing)<=6000:
                    self.send_header('X-PiShelf-Sentences',timing)
                self.send_header('Cache-Control','no-store')
                self.security_headers()
                self.end_headers()
                self.wfile.write(body)
                return
            if urlsplit(self.path).path == '/api/webp-cache/clear':
                # No body is required; reject unexpected or oversized requests.
                if self.headers.get('Transfer-Encoding') or self.headers.get('Content-Length','0') not in ('0','2'):
                    raise APIError(400,'Cache clear expects an empty JSON object.')
                with WEBP_CACHE_LOCK:
                    cache=self.server.state_db.parent/'page-images'
                    removed=0
                    if cache.is_dir():
                        for cached in cache.glob('*.webp'):
                            cached.unlink(missing_ok=True)
                            removed+=1
                    self.json_response({'removed':removed})
                return
            if urlsplit(self.path).path == "/api/upload":
                self.upload_pdf(); return
            if urlsplit(self.path).path.startswith('/api/covers/'):
                self.cache_cover(); return
            length = int(self.headers.get('Content-Length', '0'))
            limit = 5*1024*1024 if urlsplit(self.path).path == '/api/backup/restore' else 16384
            if not 0 < length <= limit or self.headers.get_content_type() != 'application/json':
                raise APIError(400, 'Expected a small JSON request.')
            data = json.loads(self.rfile.read(length))
            if not isinstance(data, dict): raise APIError(400, 'Invalid request.')
            with self.server.mutation_lock:
                with sqlite3.connect(self.server.state_db) as db:
                    result = self.mutate(data, db)
            if urlsplit(self.path).path not in ('/api/progress','/api/progress/clear','/api/collections'):
                self.server.scan_time = float('-inf')
            self.json_response(result)
        except APIError as e: self.json_response({'error':e.message}, e.status)
        except (ValueError, KeyError, TypeError): self.json_response({'error':'Invalid request.'}, 400)
        except (BrokenPipeError, ConnectionResetError): pass
        except (OSError, sqlite3.Error): self.json_response({'error':'Could not write changes. Check folder permissions and free space.'}, 500)

    # mutate: handle this step of the server request or library workflow.
    def mutate(self, data, db):
        route = urlsplit(self.path).path
        if route == '/api/collections':
            action=data.get('action','create')
            if action not in ('create','rename','delete'): raise ValueError()
            key=data.get('id')
            if action != 'create':
                if not isinstance(key,str) or not re.fullmatch('[a-f0-9]{32}',key): raise ValueError()
                if not db.execute('SELECT 1 FROM collections WHERE id=?',(key,)).fetchone(): raise APIError(404,'Collection not found.')
            if action == 'delete':
                db.execute('DELETE FROM collection_items WHERE collection_id=?',(key,))
                db.execute('DELETE FROM collections WHERE id=?',(key,))
                return {'ok':True}
            name=collection_name(data.get('name'))
            existing=db.execute('SELECT id FROM collections WHERE name=? COLLATE NOCASE',(name,)).fetchone()
            if existing and existing[0] != key: raise APIError(409,'A collection with this name already exists.')
            if action == 'create':
                if db.execute('SELECT COUNT(*) FROM collections').fetchone()[0]>=200: raise APIError(400,'Limit of 200 collections reached.')
                key=uuid.uuid4().hex
                db.execute('INSERT INTO collections VALUES (?,?)',(key,name))
            else: db.execute('UPDATE collections SET name=? WHERE id=?',(name,key))
            return {'ok':True,'id':key}
        if route == '/api/delete':
            item=next((i for i in self.library_items() if i['id']==data.get('id')),None)
            if not item: raise APIError(404,'Issue no longer exists.')
            if data.get('confirm') is not True: raise APIError(400,'Permanent deletion requires confirmation.')
            file=checked_path(self.server.roots[item['source']],item['path'])
            info=file.stat()
            current_key=hashlib.sha256(f"{item['id']}:{info.st_mtime_ns}:{info.st_size}".encode()).hexdigest()
            if current_key!=item['coverKey'] or data.get('coverKey',current_key)!=current_key:
                raise APIError(409,'The document changed. Refresh before deleting it.')
            file.unlink()
            remove_reading_state(db,item['id'])
            with self.server.cover_lock:
                cover=self.server.cover_dir/(item['coverKey']+'.jpg')
                try:
                    if cover.exists():
                        size=cover.stat().st_size;cover.unlink();self.server.cover_bytes=max(0,self.server.cover_bytes-size)
                except OSError: pass  # An expendable thumbnail must not roll back reading-state cleanup.
            return {'ok':True}
        if route == '/api/trash/delete':
            token=data.get('token')
            if not isinstance(token,str) or not re.fullmatch('[a-f0-9]{32}',token) or data.get('confirm') is not True: raise ValueError()
            row=db.execute('SELECT path,source FROM trash WHERE token=?',(token,)).fetchone()
            if not row: raise APIError(404,'Trash item not found.')
            root=self.server.roots.get(row[1])
            if root is None: raise APIError(409,'Library source is not configured.')
            file=root/'.pishelf-trash'/(token+Path(row[0]).suffix.lower())
            if file.parent.is_symlink() or file.is_symlink() or not file.resolve().is_relative_to(root): raise APIError(403,'Invalid trash path.')
            file.unlink(missing_ok=True)
            db.execute('DELETE FROM trash WHERE token=?',(token,))
            if not checked_path(root,row[0]).exists(): remove_reading_state(db,item_id(row[1],row[0]))
            return {'ok':True}
        if route == '/api/categories':
            source = data.get('source','magazines')
            root = self.server.roots.get(source)
            if root is None: raise ValueError()
            path = safe_relative(data['path'])
            folder = checked_path(root, path)
            if data.get('action') == 'rename':
                if path == '.' or folder == root: raise APIError(400,'Cannot rename a library root.')
                new_path = safe_relative(data.get('newPath',''))
                if new_path == '.' or new_path == path or Path(new_path).parent != Path(path).parent:
                    raise APIError(400,'Choose a different category name within the same parent folder.')
                destination = checked_path(root, new_path)
                if destination.exists(): raise APIError(409,'A category with that name already exists.')
                if not folder.is_dir(): raise APIError(404,'Category not found.')
                try:
                    if any(folder.iterdir()): raise APIError(409,'Only empty categories can be renamed.')
                    folder.rename(destination)
                except OSError: raise APIError(409,'Unable to rename this category.')
                self.server.scan_time=float('-inf')
                return {'ok': True}
            if data.get('action') == 'delete':
                if path == '.' or folder == root: raise APIError(400,'Cannot remove a library root.')
                try: folder.rmdir()
                except FileNotFoundError: raise APIError(404,'Category no longer exists.')
                except OSError: raise APIError(409,'Category is not empty. Move or remove its files and subcategories first.')
                self.server.scan_time=float('-inf')
                return {'ok': True}
            folder.mkdir(parents=True, exist_ok=True)
            self.server.scan_time=float('-inf')
            return {'ok': True}
        if route == '/api/issue/edit':
            item = next((i for i in self.library_items() if i['id']==data.get('id')), None)
            if not item: raise APIError(404, 'Issue not found. Refresh your library.')
            metadata = validate_metadata({**{k:item[k] for k in ('series','issueDate','tags')}, **{k:data[k] for k in ('series','issueDate','tags') if k in data}})
            collection_ids=data.get('collectionIds')
            if collection_ids is not None:
                if not isinstance(collection_ids,list) or len(collection_ids)>200 or any(not isinstance(k,str) or not re.fullmatch('[a-f0-9]{32}',k) for k in collection_ids): raise ValueError()
                allowed={r[0] for r in db.execute('SELECT id FROM collections')}
                if set(collection_ids)-allowed: raise APIError(400,'A selected collection no longer exists.')
            filename = data.get('filename',Path(item['path']).name)
            if not isinstance(filename,str) or '/' in filename or '\\' in filename or Path(filename).suffix.lower()!=Path(item['path']).suffix.lower():
                raise APIError(400,'Keep the original PDF or EPUB extension and remove slashes.')
            safe_relative(filename)
            category = data.get('category',item['category'])
            if category != '.': safe_relative(category)
            relative = (Path(category)/filename).as_posix()
            root = self.server.roots[item['source']]
            source = checked_path(root,item['path'])
            destination = checked_path(root,relative)
            new_id = item_id(item['source'],relative)
            moved = source != destination
            if moved:
                if destination.exists(): raise APIError(409, 'A PDF already has that name in this category.')
                destination.parent.mkdir(parents=True,exist_ok=True)
                move_exclusive(source,destination)
            try:
                if new_id != item['id']:
                    old = db.execute('SELECT value FROM progress WHERE id=?',(item['id'],)).fetchone()
                    # The destination may retain historical progress from an earlier deleted file.
                    db.execute('DELETE FROM progress WHERE id=?',(new_id,))
                    if old: db.execute('INSERT INTO progress VALUES (?,?)',(new_id,old[0]))
                    db.execute('DELETE FROM progress WHERE id=?',(item['id'],))
                    db.execute('DELETE FROM metadata WHERE id=?',(item['id'],))
                    db.execute('DELETE FROM collection_items WHERE item_id=?',(new_id,))
                    db.execute('UPDATE collection_items SET item_id=? WHERE item_id=?',(new_id,item['id']))
                db.execute('INSERT OR REPLACE INTO metadata VALUES (?,?)',(new_id,json.dumps(metadata)))
                if collection_ids is not None:
                    db.execute('DELETE FROM collection_items WHERE item_id=?',(new_id,))
                    db.executemany('INSERT INTO collection_items VALUES (?,?)',[(k,new_id) for k in set(collection_ids)])
                db.commit()
            except Exception:
                if moved: destination.rename(source)
                raise
            return {'ok':True,'id':new_id}
        if route == '/api/backup/restore':
            if data.get('format') != 'pishelf-backup' or type(data.get('version')) is not int or data['version'] != 1:
                raise APIError(400, 'Unsupported PiShelf backup.')
            progress = data.get('progress',{})
            metadata = data.get('metadata',{})
            categories = data.get('categories',[])
            if not isinstance(progress,dict) or not isinstance(metadata,dict) or not isinstance(categories,list): raise ValueError()
            if len(progress)>20000 or len(metadata)>20000 or len(categories)>2000: raise ValueError()
            for key,value in progress.items():
                if not re.fullmatch('[a-f0-9]{20}',key): raise ValueError()
                validate_progress(value)
            for key,value in metadata.items():
                if not re.fullmatch('[a-f0-9]{20}',key): raise ValueError()
                validate_metadata(value)
            collections=data.get('collections',[])
            validate_collections(collections)
            collections=[{**c,'name':collection_name(c['name'])} for c in collections]
            # Prevent an imported name from silently replacing an unrelated collection.
            for collection in collections:
                row=db.execute('SELECT id FROM collections WHERE name=? COLLATE NOCASE',(collection['name'],)).fetchone()
                if row and row[0] != collection['id']: raise APIError(409,'A collection name conflicts with this backup. Rename it before restoring.')
            folders=[]
            for category in categories:
                if not isinstance(category,dict): raise ValueError()
                root=self.server.roots.get(category.get('source'))
                if root is None: raise APIError(400,'Backup uses a library source that is not configured.')
                if category.get('path') == '.': continue
                folders.append(checked_path(root,safe_relative(category['path'])))
            for folder in folders: folder.mkdir(parents=True,exist_ok=True)
            for key,value in progress.items(): db.execute('INSERT OR REPLACE INTO progress VALUES (?,?)',(key,json.dumps(value)))
            for key,value in metadata.items(): db.execute('INSERT OR REPLACE INTO metadata VALUES (?,?)',(key,json.dumps(value)))
            for collection in collections:
                db.execute('INSERT INTO collections VALUES (?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name',(collection['id'],collection['name']))
                db.execute('DELETE FROM collection_items WHERE collection_id=?',(collection['id'],))
                db.executemany('INSERT INTO collection_items VALUES (?,?)',[(collection['id'],key) for key in set(collection['items'])])
            return {'ok':True,'progress':len(progress),'metadata':len(metadata)}
        if route == '/api/progress/clear':
            key = data.get('id')
            if key is not None and not re.fullmatch('[a-f0-9]{20}', str(key)): raise ValueError()
            rows = db.execute('SELECT id,value FROM progress WHERE id=?',(key,)).fetchall() if key else db.execute('SELECT id,value FROM progress').fetchall()
            for id_, raw in rows:
                value=json.loads(raw)
                for field in ('page','total','lastRead','completed'): value.pop(field,None)
                db.execute('UPDATE progress SET value=? WHERE id=?',(json.dumps(value),id_))
            return {'ok':True}
        if route == '/api/annotations':
            user=self.require_session(mutation=True)
            key=data.get('id');items=data.get('items')
            if not isinstance(key,str) or not re.fullmatch('[a-f0-9]{20}',key): raise ValueError()
            if not isinstance(items,list) or len(items)>3000: raise APIError(400,'Too many annotations.')
            if not any(item['id']==key for item in self.library_items()): raise APIError(404,'PDF not found.')
            for mark in items:
                if not isinstance(mark,dict) or mark.get('type') not in ('pen','highlight','note') or type(mark.get('page')) is not int or not 1<=mark['page']<=100000: raise ValueError()
                if mark['type']=='note':
                    if set(mark)-{'type','page','text'} or not isinstance(mark.get('text'),str) or not 0<len(mark['text'].strip())<=4000: raise ValueError()
                    continue
                if not isinstance(mark.get('color'),str) or not re.fullmatch('#[a-fA-F0-9]{6}',mark['color']): raise ValueError()
                points=mark.get('points')
                if not isinstance(points,list) or not 2<=len(points)<=1000: raise ValueError()
                if any(not isinstance(p,list) or len(p)!=2 or any(type(v) is not int or not 0<=v<=1000 for v in p) for p in points): raise ValueError()
                if set(mark)-{'type','page','color','points'}: raise ValueError()
            raw=json.dumps(items,separators=(',',':')).encode('utf-8')
            if len(raw)>262144: raise APIError(413,'Annotations exceed 256 KB for this PDF.')
            if items:
                db.execute('INSERT INTO annotations(user_id,document_id,payload) VALUES (?,?,?) ON CONFLICT(user_id,document_id) DO UPDATE SET payload=excluded.payload',(user['id'],key,zlib.compress(raw,6)))
            else: db.execute('DELETE FROM annotations WHERE user_id=? AND document_id=?',(user['id'],key))
            return {'ok':True}
        if route == '/api/progress':
            key=data.pop('id')
            if not isinstance(key,str) or not re.fullmatch('[a-f0-9]{20}',key): raise ValueError()
            if not data or set(data)-{'page','total','favorite','bookmarks','completed','zoom','rotation','mode','epubCfi'}: raise ValueError()
            if 'epubCfi' in data and (not isinstance(data['epubCfi'],str) or len(data['epubCfi'])>2048 or (data['epubCfi'] and not data['epubCfi'].startswith('epubcfi('))): raise ValueError()
            validate_reader_options(data)
            for field in ('page','total'):
                if field in data and (type(data[field]) is not int or not 1 <= data[field] <= 100000): raise ValueError()
            if 'page' in data and ('total' not in data or data['page'] > data['total']): raise ValueError()
            for field in ('favorite','completed'):
                if field in data and type(data[field]) is not bool: raise ValueError()
            if 'bookmarks' in data:
                marks=data['bookmarks']
                if not isinstance(marks,list) or len(marks)>1000 or any(type(n) is not int or not 1<=n<=100000 for n in marks): raise ValueError()
                data['bookmarks']=sorted(set(marks))
            row=db.execute('SELECT value FROM progress WHERE id=?',(key,)).fetchone()
            value=json.loads(row[0]) if row else {}
            value.update(data)
            if 'page' in data or 'epubCfi' in data: value['lastRead']=time.time()
            db.execute('INSERT OR REPLACE INTO progress VALUES (?,?)',(key,json.dumps(value)))
            return value
        if route == '/api/trash':
            key=data['id']
            item=next((i for i in self.library_items() if i['id']==key),None)
            if not item: raise APIError(404,'Magazine not found. Refresh the library.')
            root=self.server.roots[item['source']]
            source=checked_path(root,item['path'])
            token=uuid.uuid4().hex
            trash=root/'.pishelf-trash'
            if trash.is_symlink(): raise APIError(409,'Trash folder cannot be a symlink.')
            trash.mkdir(exist_ok=True)
            destination=trash/(token+Path(item['path']).suffix.lower())
            source.rename(destination)
            try:
                db.execute('DELETE FROM annotations WHERE document_id=?',(key,))
                db.execute('INSERT INTO trash (token,path,title,deleted,source) VALUES (?,?,?,?,?)',(token,item['path'],item['title'],time.time(),item['source']))
                db.commit()
            except Exception:
                destination.rename(source)
                raise
            return {'ok':True,'token':token}
        if route == '/api/trash/restore':
            token=data['token']
            if not isinstance(token,str) or not re.fullmatch('[a-f0-9]{32}',token): raise ValueError()
            row=db.execute('SELECT path,source FROM trash WHERE token=?',(token,)).fetchone()
            if not row: raise APIError(404,'Trash item not found.')
            root=self.server.roots.get(row[1])
            if root is None: raise APIError(409,'This library source is not configured.')
            destination=checked_path(root,row[0])
            if destination.exists(): raise APIError(409,'A file already exists at the original location. Rename it first.')
            destination.parent.mkdir(parents=True,exist_ok=True)
            source=root/'.pishelf-trash'/(token+Path(row[0]).suffix.lower())
            if source.is_symlink() or not source.resolve().is_relative_to(root): raise APIError(403,'Invalid trash path.')
            if not source.is_file(): raise APIError(404,'The trashed PDF is missing from disk.')
            # Hard-link creation refuses to overwrite a file created by another process.
            try:
                os.link(source,destination)
            except OSError as e:
                if e.errno not in (errno.EPERM,errno.EOPNOTSUPP,errno.EXDEV): raise
                # USB drives using FAT/exFAT may not support hard links.
                with source.open('rb') as src:
                    with destination.open('xb') as dst:
                        try: shutil.copyfileobj(src,dst,1024*1024)
                        except Exception:
                            destination.unlink()
                            raise
            try:
                db.execute('DELETE FROM trash WHERE token=?',(token,))
                db.commit()
            except Exception:
                destination.unlink()
                raise
            source.unlink()
            return {'ok':True}
        raise APIError(404,'Unknown action.')

    # do HEAD: handle this step of the server request or library workflow.
    def do_HEAD(self): self.do_GET(head=True)

    # do GET: handle this step of the server request or library workflow.
    def do_GET(self, head=False):
        path=unquote(urlsplit(self.path).path)
        try:
            if path == '/api/health': self.json_response({'status':'ok'},head=head); return
            if path == '/api/auth/setup-status':
                with sqlite3.connect(self.server.state_db) as db:
                    setup_needed=not bool(db.execute('SELECT 1 FROM auth_users LIMIT 1').fetchone())
                self.json_response({'setup_required':setup_needed},head=head);return
            if path not in ('/login.html','/login.js','/setup.html','/setup.js'):
                try:
                    user=self.require_session(admin=path in ('/admin.html','/admin.js'))
                except APIError as error:
                    if error.status==401 and path in ('/','/index.html','/admin.html'):
                        self.send_response(302)
                        with sqlite3.connect(self.server.state_db) as db:
                            needs_setup=not bool(db.execute('SELECT 1 FROM auth_users LIMIT 1').fetchone())
                        self.send_header('Location','/setup.html' if needs_setup else '/login.html')
                        self.send_header('Cache-Control','no-store')
                        self.end_headers()
                        return
                    raise
                if path == '/api/auth/me':
                    self.json_response({'username':user['username'],'role':user['role'],'csrf':user['csrf']},head=head);return
                if path == '/api/admin/paths/pin':
                    self.require_session(admin=True)
                    with sqlite3.connect(self.server.state_db) as db:
                        db.execute('CREATE TABLE IF NOT EXISTS library_path_pin (id INTEGER PRIMARY KEY CHECK(id=1),salt BLOB NOT NULL,hash BLOB NOT NULL)')
                        configured=db.execute('SELECT 1 FROM library_path_pin WHERE id=1').fetchone() is not None
                    self.json_response({'configured':configured},head=head);return
                if path == '/api/admin/paths':
                    self.require_session(admin=True)
                    with sqlite3.connect(self.server.state_db) as db:
                        row=db.execute('SELECT paths FROM library_config WHERE id=1').fetchone()
                    self.json_response(json.loads(row[0]) if row else {k:str(v) for k,v in self.server.roots.items()},head=head)
                    return
                if path == '/api/admin/users':
                    self.require_session(admin=True)
                    with sqlite3.connect(self.server.state_db) as db:
                        users=[dict(id=r[0],username=r[1],role=r[2],enabled=bool(r[3])) for r in db.execute('SELECT id,username,role,enabled FROM auth_users ORDER BY username')]
                    self.json_response(users,head=head);return
            if path == '/api/webp-cache':
                cache=self.server.state_db.parent/'page-images'
                with WEBP_CACHE_LOCK:
                    files=list(cache.glob('*.webp')) if cache.is_dir() else []
                    self.json_response({'files':len(files),'bytes':sum(p.stat().st_size for p in files),'limit':WEBP_CACHE_LIMIT},head=head)
                return
            if path.startswith('/api/page-image/'):
                parts=path.split('/')
                if len(parts)!=5 or not re.fullmatch('[a-f0-9]{20}',parts[3]) or not parts[4].isdigit():
                    raise APIError(404,'Page not found.')
                item=next((i for i in self.library_items() if i['id']==parts[3]),None)
                if not item: raise APIError(404,'Document not found.')
                if item['format']!='pdf': raise APIError(415,'Only PDF pages can be rendered as WebP.')
                n=int(parts[4]);params=parse_qs(urlsplit(self.path).query)
                width=int(params.get('width',['1600'])[0])
                if not 1<=n<=5000 or width not in (400,960,1600,2800):
                    raise APIError(400,'Invalid page or image width.')
                source=self.server.roots[item['source']]
                pdf=checked_path(source,item['path'])
                stat=pdf.stat()
                if stat.st_size > MAX_WEBP_SOURCE_BYTES: raise APIError(413,'PDF exceeds conversion size limit.')
                key=hashlib.sha256(f"{item['id']}:{stat.st_size}:{stat.st_mtime_ns}:{n}:{width}".encode()).hexdigest()
                cache=self.server.state_db.parent/'page-images'
                cache.mkdir(parents=True,exist_ok=True)
                target=cache/(key+'.webp')
                with WEBP_CACHE_LOCK:
                    if not target.is_file():
                        try:
                            import fitz
                            with fitz.open(pdf) as document:
                                if n>len(document): raise APIError(404,'Page not found.')
                                p=document[n-1]
                                rect=p.rect
                                if not all(0 < v <= MAX_PDF_PAGE_DIMENSION for v in (rect.width,rect.height)):
                                    raise APIError(413,'PDF page dimensions exceed conversion limits.')
                                scale=width/rect.width
                                # The requested width is bounded, but extremely tall pages
                                # can still allocate gigabytes unless pixels are capped.
                                target_height=rect.height*scale
                                if width*target_height > MAX_RENDER_PIXELS:
                                    raise APIError(413,'PDF page exceeds the image memory limit.')
                                pix=p.get_pixmap(matrix=fitz.Matrix(scale,scale),alpha=False)
                                if pix.width*pix.height > MAX_RENDER_PIXELS:
                                    raise APIError(413,'Rendered page exceeds the image memory limit.')
                                # Pillow writes WebP, with a predictable file size and quality.
                                from PIL import Image
                                import io
                                image=Image.frombytes('RGB',(pix.width,pix.height),pix.samples)
                                output=io.BytesIO()
                                image.save(output,format='WEBP',quality=85,method=4)
                            temporary=cache/(uuid.uuid4().hex+'.tmp')
                            try:
                                temporary.write_bytes(output.getvalue())
                                temporary.replace(target)
                            finally: temporary.unlink(missing_ok=True)
                        except APIError: raise
                        except Exception:
                            logging.exception('PiShelf WebP conversion failed')
                            raise APIError(500,'Image conversion failed.')
                    # Byte-limited, least-recently-used cache; keep the requested page.
                    # Touching on read records recent use without changing PDF identity.
                    data=target.read_bytes()
                    try:
                        os.utime(target,None)
                        max_bytes=WEBP_CACHE_LIMIT
                        entries=sorted(cache.glob('*.webp'),key=lambda p:p.stat().st_mtime_ns)
                        total=sum(p.stat().st_size for p in entries)
                        for old in entries:
                            if total<=max_bytes: break
                            if old==target: continue
                            size=old.stat().st_size
                            old.unlink(missing_ok=True)
                            total-=size
                    except OSError:
                        pass  # A cache maintenance error must not interrupt reading.
                self.send_response(200)
                self.send_header('Content-Type','image/webp')
                self.security_headers()
                self.send_header('Content-Length',str(len(data)))
                self.send_header('Cache-Control','private, max-age=86400')
                self.send_header('X-Content-Type-Options','nosniff')
                self.end_headers()
                if not head: self.wfile.write(data)
                return

            if path == '/api/library':
                if 'refresh=1' in urlsplit(self.path).query: self.server.scan_time=float('-inf')
                self.json_response(self.library_items(),head=head); return
            if path == '/api/categories': self.json_response(self.categories(),head=head); return
            if path == '/api/collections':
                with sqlite3.connect(self.server.state_db) as db: self.json_response(read_collections(db),head=head)
                return
            if path == '/api/backup':
                with sqlite3.connect(self.server.state_db) as db:
                    db.execute('BEGIN')
                    value=dict(format='pishelf-backup',version=1,created=datetime.datetime.now(datetime.timezone.utc).isoformat(),
                        progress={k:json.loads(v) for k,v in db.execute('SELECT id,value FROM progress')},
                        metadata={k:json.loads(v) for k,v in db.execute('SELECT id,value FROM metadata')},categories=self.categories(),collections=read_collections(db))
                self.json_response(value,head=head); return

            if path == '/api/annotations':
                user=self.require_session()
                query=parse_qs(urlsplit(self.path).query)
                key=query.get('id',[''])[0]
                if not re.fullmatch('[a-f0-9]{20}',key): raise APIError(400,'Invalid PDF ID.')
                if not any(item['id']==key for item in self.library_items()): raise APIError(404,'PDF not found.')
                with sqlite3.connect(self.server.state_db) as db:
                    row=db.execute('SELECT payload FROM annotations WHERE user_id=? AND document_id=?',(user['id'],key)).fetchone()
                self.json_response(json.loads(zlib.decompress(row[0])) if row else [],head=head);return
            if path in ('/api/progress','/api/trash'):
                with sqlite3.connect(self.server.state_db) as db:
                    if path.endswith('progress'):
                        result={key:json.loads(value) for key,value in db.execute('SELECT id,value FROM progress')}
                    else:
                        result=[dict(token=r[0],path=r[1],title=r[2],deleted=r[3],source=r[4]) for r in db.execute('SELECT token,path,title,deleted,source FROM trash ORDER BY deleted DESC')]
                self.json_response(result,head=head); return
            # Auto-generate an EPUB book cover only when requested by the shelf.
            # Cache it alongside existing JPEG covers; do not modify source EPUBs.
            if path.startswith('/api/epub-cover/'):
                book_id=path.removeprefix('/api/epub-cover/')
                if not re.fullmatch('[a-f0-9]{20}',book_id):
                    raise APIError(404,'Book cover not found.')
                item=next((entry for entry in self.library_items()
                           if entry['id']==book_id and entry['source']=='books'
                           and entry['format']=='epub'),None)
                if item is None: raise APIError(404,'Book cover not found.')
                cover_key=item['coverKey']
                destination=self.server.cover_dir/(cover_key+'.jpg')
                with self.server.cover_lock:
                    if not destination.is_file():
                        from epub_covers import embedded_cover_jpeg
                        ebook=checked_path(self.server.roots['books'],item['path'])
                        thumbnail=embedded_cover_jpeg(ebook)
                        if not thumbnail: raise APIError(404,'This EPUB has no supported embedded cover.')
                        temporary=self.server.cover_dir/(uuid.uuid4().hex+'.tmp')
                        try:
                            temporary.write_bytes(thumbnail)
                            temporary.replace(destination)
                        finally:
                            temporary.unlink(missing_ok=True)
                        self.server.cover_bytes+=len(thumbnail)
                self.send_response(302)
                self.send_header('Location','/api/covers/'+cover_key)
                self.send_header('Cache-Control','no-store')
                self.security_headers()
                self.end_headers()
                return

            cover = path.startswith('/api/covers/')
            if cover:
                key=path.rsplit('/',1)[-1]
                if not re.fullmatch('[a-f0-9]{64}',key): self.send_error(404); return
                root,relative=self.server.cover_dir,key+'.jpg'
            elif path.startswith('/books/'):
                root,relative=self.server.roots.get('books'),path[len('/books/'):]
                if root is None or Path(relative).suffix.lower() not in ('.pdf','.epub') or any(p.startswith('.') for p in Path(relative).parts):
                    self.send_error(404); return
            elif path.startswith('/newspapers/'):
                root,relative=self.server.roots.get('newspapers'),path[len('/newspapers/'):]
                if root is None or Path(relative).suffix.lower()!='.pdf' or any(p.startswith('.') for p in Path(relative).parts):
                    self.send_error(404); return
            elif path.startswith('/magazines/'):
                root,relative=self.server.library,path[len('/magazines/'):]
                if Path(relative).suffix.lower()!='.pdf' or any(p.startswith('.') for p in Path(relative).parts):
                    self.send_error(404); return
            else: root,relative=BASE/'static',path.lstrip('/') or 'index.html'
            target=(root/relative).resolve()
            if not target.is_relative_to(root.resolve()) or not target.is_file(): self.send_error(404); return
            info=target.stat()
            etag='"'+hashlib.sha256(f'{info.st_mtime_ns}:{info.st_size}'.encode()).hexdigest()+'"'
            if self.headers.get('If-None-Match') == etag:
                self.send_response(304); self.send_header('ETag',etag); self.end_headers(); return
            size=info.st_size
            start,end,status=0,size-1,200
            range_header=self.headers.get('Range')
            if range_header:
                match=re.fullmatch(r'bytes=(\d*)-(\d*)',range_header)
                try:
                    if not match or not any(match.groups()): raise ValueError()
                    a,b=match.groups()
                    if a: start,end=int(a),min(int(b),size-1) if b else size-1
                    else:
                        if int(b)<=0: raise ValueError()
                        start=max(0,size-int(b))
                    if start>end or start>=size: raise ValueError()
                    status=206
                except ValueError:
                    self.send_response(416);self.send_header('Content-Range',f'bytes */{size}');self.end_headers();return
            self.send_response(status)
            self.send_header('Content-Type','application/epub+zip' if target.suffix.lower()=='.epub' else 'text/javascript' if target.suffix=='.mjs' else mimetypes.guess_type(target.name)[0] or 'application/octet-stream')
            self.send_header('Content-Length',str(end-start+1))
            self.send_header('Accept-Ranges','bytes')
            self.send_header('ETag',etag)
            self.send_header('Cache-Control','public, max-age=31536000, immutable' if cover else 'no-cache')
            self.send_header('X-Content-Type-Options','nosniff')
            if 'download=1' in urlsplit(self.path).query:
                self.send_header('Content-Disposition',"attachment; filename*=UTF-8''"+quote(target.name))
            if status==206: self.send_header('Content-Range',f'bytes {start}-{end}/{size}')
            self.end_headers()
            if not head:
                with target.open('rb') as f:
                    f.seek(start);remaining=end-start+1
                    while remaining>0:
                        chunk=f.read(min(65536,remaining))
                        if not chunk: break
                        self.wfile.write(chunk);remaining-=len(chunk)
        except APIError as error: self.json_response({'error':error.message},error.status,head=head)
        except (ValueError,KeyError,TypeError): self.json_response({'error':'Invalid request.'},400,head=head)
        except (BrokenPipeError,ConnectionResetError): pass
        except (OSError,sqlite3.Error): self.send_error(500,'Unable to read library storage.')

# EPUB is a ZIP container; reject malformed and unusually expansive archives
# before allowing epub.js to handle it in the browser.
def validate_epub(path):
    try:
        with zipfile.ZipFile(path) as archive:
            files=archive.infolist()
            if not files or len(files)>4000: raise APIError(400,'EPUB contains too many files.')
            entry=archive.getinfo('mimetype')
            if entry.file_size>64 or archive.read('mimetype')!=b'application/epub+zip':
                raise APIError(400,'Invalid EPUB mimetype.')
            if 'META-INF/container.xml' not in archive.namelist():
                raise APIError(400,'EPUB is missing its package container.')
            total=0
            seen=set()
            for member in files:
                name=member.filename
                parts=name.split('/')
                if name.startswith('/') or '\\' in name or '..' in parts or any(part.startswith('.') for part in parts if part not in ('','META-INF')) or name in seen:
                    raise APIError(400,'EPUB contains unsafe archive names.')
                seen.add(name)
                if member.flag_bits & 1: raise APIError(400,'Encrypted EPUB archives are not supported.')
                if member.file_size>256*1024*1024: raise APIError(413,'An EPUB resource is too large.')
                total+=member.file_size
                if total>1024*1024*1024: raise APIError(413,'EPUB expands beyond the safety limit.')
    except (zipfile.BadZipFile,KeyError,RuntimeError):
        raise APIError(400,'Invalid or damaged EPUB archive.')

# item id: handle this step of the server request or library workflow.
def item_id(source,relative):
    identity=relative if source=='magazines' else source+':'+relative
    return hashlib.sha256(identity.encode()).hexdigest()[:20]


# safe relative: handle this step of the server request or library workflow.
def safe_relative(value):
    if not isinstance(value,str) or not value or len(value)>240 or '\\' in value or any(ord(c)<32 for c in value): raise ValueError()
    if value.startswith('/') or any(p in ('','.','..') or p.startswith('.') for p in value.split('/')): raise ValueError()
    return value


# checked path: handle this step of the server request or library workflow.
def checked_path(root,relative):
    safe_relative(relative)
    target=root/relative
    if not target.resolve().is_relative_to(root): raise APIError(403,'Path leaves the library.')
    cursor=root
    for part in Path(relative).parts:
        cursor=cursor/part
        if cursor.is_symlink(): raise APIError(403,'Symlinks cannot be modified.')
    return target


# move exclusive: handle this step of the server request or library workflow.
def move_exclusive(source,destination):
    try: os.link(source,destination)
    except OSError as error:
        if error.errno not in (errno.EPERM,errno.EOPNOTSUPP,errno.EXDEV): raise
        with source.open('rb') as src, destination.open('xb') as dst:
            try: shutil.copyfileobj(src,dst)
            except Exception:
                destination.unlink(); raise
    try: source.unlink()
    except Exception:
        destination.unlink(); raise


# infer issue: handle this step of the server request or library workflow.
def infer_issue(stem):
    title=stem.replace('_',' ')
    match=re.search(r'\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+(20\d{2}|19\d{2})\b',title,re.I)
    date=''
    if match:
        months=['january','february','march','april','may','june','july','august','september','october','november','december']
        date=f'{match[2]}-{months.index(match[1].lower())+1:02d}'
    else:
        iso=re.search(r'\b((?:19|20)\d{2})[-.]([01]\d)(?:[-.]([0-3]\d))?\b',title)
        if iso:
            candidate=iso[1]+'-'+iso[2]+(('-'+iso[3]) if iso[3] else '')
            try: datetime.date.fromisoformat(candidate if len(candidate)==10 else candidate+'-01'); date=candidate
            except ValueError: pass
    series=re.split(r'[, ]+vol(?:ume)?\.?\s*\d|\s*\((?:January|February|March|April|May|June|July|August|September|October|November|December)\b|\s+\b(?:19|20)\d{2}[-.]',title,maxsplit=1,flags=re.I)[0].strip(' ,-')
    return dict(series=series or title,issueDate=date,tags=[])


# validate metadata: handle this step of the server request or library workflow.
def validate_metadata(value):
    if not isinstance(value,dict) or set(value)-{'series','issueDate','tags'}: raise ValueError()
    for field in ('series','issueDate'):
        if field in value and (not isinstance(value[field],str) or len(value[field])>160): raise ValueError()
    date=value.get('issueDate','')
    if date:
        if not re.fullmatch(r'\d{4}-\d{2}(?:-\d{2})?',date): raise ValueError()
        datetime.date.fromisoformat(date if len(date)==10 else date+'-01')
    tags=value.get('tags',[])
    if not isinstance(tags,list) or len(tags)>30 or any(not isinstance(t,str) or not t.strip() or len(t)>40 for t in tags): raise ValueError()
    return dict(series=value.get('series','').strip(),issueDate=date,tags=list(dict.fromkeys(t.strip() for t in tags)))


# validate reader options: handle this step of the server request or library workflow.
def validate_reader_options(value):
    if 'zoom' in value and (type(value['zoom']) not in (int,float) or not .1<=value['zoom']<=3): raise ValueError()
    if 'rotation' in value and (type(value['rotation']) is not int or value['rotation'] not in (0,90,180,270)): raise ValueError()
    if 'mode' in value and value['mode'] not in ('scroll','single','book'): raise ValueError()


# collection name: handle this step of the server request or library workflow.
def collection_name(value):
    if not isinstance(value,str) or not value.strip() or len(value.strip())>80 or any(ord(c)<32 for c in value): raise ValueError()
    return value.strip()


# read collections: handle this step of the server request or library workflow.
def read_collections(db):
    members={}
    for collection_id,key in db.execute('SELECT collection_id,item_id FROM collection_items ORDER BY item_id'):
        members.setdefault(collection_id,[]).append(key)
    return [dict(id=key,name=name,items=members.get(key,[])) for key,name in db.execute('SELECT id,name FROM collections ORDER BY name COLLATE NOCASE')]


# validate collections: handle this step of the server request or library workflow.
def validate_collections(collections):
    if not isinstance(collections,list) or len(collections)>200: raise ValueError()
    ids=set();names=set()
    for collection in collections:
        if not isinstance(collection,dict): raise ValueError()
        key=collection.get('id');name=collection_name(collection.get('name'));items=collection.get('items')
        if not isinstance(key,str) or not re.fullmatch('[a-f0-9]{32}',key) or key in ids or name.casefold() in names: raise ValueError()
        if not isinstance(items,list) or len(items)>20000 or any(not isinstance(k,str) or not re.fullmatch('[a-f0-9]{20}',k) for k in items): raise ValueError()
        ids.add(key);names.add(name.casefold())


# remove reading state: handle this step of the server request or library workflow.
def remove_reading_state(db,key):
    db.execute('DELETE FROM annotations WHERE document_id=?',(key,))
    db.execute('DELETE FROM progress WHERE id=?',(key,))
    db.execute('DELETE FROM metadata WHERE id=?',(key,))
    db.execute('DELETE FROM collection_items WHERE item_id=?',(key,))


# validate progress: handle this step of the server request or library workflow.
def validate_progress(value):
    if not isinstance(value,dict) or set(value)-{'page','total','favorite','bookmarks','completed','lastRead','zoom','rotation','mode','epubCfi'}: raise ValueError()
    if 'epubCfi' in value and (not isinstance(value['epubCfi'],str) or len(value['epubCfi'])>2048 or (value['epubCfi'] and not value['epubCfi'].startswith('epubcfi('))): raise ValueError()
    validate_reader_options(value)
    for field in ('page','total'):
        if field in value and (type(value[field]) is not int or not 1<=value[field]<=100000): raise ValueError()
    if 'page' in value and ('total' not in value or value['page']>value['total']): raise ValueError()
    for field in ('favorite','completed'):
        if field in value and type(value[field]) is not bool: raise ValueError()
    marks=value.get('bookmarks',[])
    if not isinstance(marks,list) or len(marks)>1000 or any(type(n) is not int or not 1<=n<=100000 for n in marks): raise ValueError()
    if 'lastRead' in value and (type(value['lastRead']) not in (int,float) or not 0<=value['lastRead']<=1e12): raise ValueError()


# make server: handle this step of the server request or library workflow.
def make_server(host,port,library,data,newspapers=None,books=None):
    library=Path(library).expanduser().resolve();library.mkdir(parents=True,exist_ok=True)
    data=Path(data).expanduser().resolve();data.mkdir(parents=True,exist_ok=True)
    server=ThreadingHTTPServer((host,port),Handler)
    server.library=library;server.state_db=data/'progress.sqlite3';server.mutation_lock=threading.Lock()
    server.roots={'magazines':library}
    if newspapers:
        newspaper_root=Path(newspapers).expanduser().resolve()
        newspaper_root.mkdir(parents=True,exist_ok=True)
        if newspaper_root==library or newspaper_root.is_relative_to(library) or library.is_relative_to(newspaper_root):
            server.server_close(); raise ValueError('Magazine and newspaper folders must be separate, non-overlapping directories.')
        server.roots['newspapers']=newspaper_root
    if books:
        book_root=Path(books).expanduser().resolve()
        book_root.mkdir(parents=True,exist_ok=True)
        if any(book_root==existing or book_root.is_relative_to(existing) or existing.is_relative_to(book_root) for existing in server.roots.values()):
            server.server_close(); raise ValueError('Book folder must be separate from the other libraries.')
        server.roots['books']=book_root
    server.cover_dir=data/'covers'
    if server.cover_dir.is_symlink(): raise ValueError('Cover cache cannot be a symlink.')
    server.cover_dir.mkdir(exist_ok=True)
    server.cover_bytes=sum(p.stat().st_size for p in server.cover_dir.glob('*.jpg'))
    server.scan_lock=threading.Lock();server.cover_lock=threading.Lock();server.scan_time=float('-inf');server.scan_items=[];server.scan_categories=[];server.upload_lock=threading.Lock();server.auth_lock=threading.Lock();server.auth_attempts={}
    with sqlite3.connect(server.state_db) as db:
        auth.initialize(db)
        db.execute('CREATE TABLE IF NOT EXISTS library_config (id INTEGER PRIMARY KEY, paths TEXT NOT NULL)')
        row=db.execute('SELECT paths FROM library_config WHERE id=1').fetchone()
        if row:
            server.roots={k:Path(v) for k,v in json.loads(row[0]).items()}
            server.library=server.roots['magazines']
        db.execute('CREATE TABLE IF NOT EXISTS collections (id TEXT PRIMARY KEY,name TEXT NOT NULL COLLATE NOCASE UNIQUE)')
        db.execute('CREATE TABLE IF NOT EXISTS collection_items (collection_id TEXT NOT NULL,item_id TEXT NOT NULL,PRIMARY KEY(collection_id,item_id))')
        db.execute('CREATE INDEX IF NOT EXISTS collection_item_lookup ON collection_items(item_id)')
        db.execute('CREATE TABLE IF NOT EXISTS metadata (id TEXT PRIMARY KEY,value TEXT NOT NULL)')
        db.execute('CREATE TABLE IF NOT EXISTS progress (id TEXT PRIMARY KEY,value TEXT NOT NULL)')
        db.execute('CREATE TABLE IF NOT EXISTS annotations (user_id INTEGER NOT NULL,document_id TEXT NOT NULL,payload BLOB NOT NULL,PRIMARY KEY(user_id,document_id),FOREIGN KEY(user_id) REFERENCES auth_users(id) ON DELETE CASCADE)')
        db.execute('CREATE INDEX IF NOT EXISTS annotations_document_idx ON annotations(document_id)')
        db.execute('CREATE TABLE IF NOT EXISTS trash (token TEXT PRIMARY KEY,path TEXT NOT NULL,title TEXT NOT NULL,deleted REAL NOT NULL)')
    with sqlite3.connect(server.state_db) as db:
        if 'source' not in {row[1] for row in db.execute('PRAGMA table_info(trash)')}:
            db.execute("ALTER TABLE trash ADD COLUMN source TEXT NOT NULL DEFAULT 'magazines'")
    return server

if __name__=='__main__':
    parser=argparse.ArgumentParser()
    parser.add_argument('--host',default='0.0.0.0');parser.add_argument('--port',type=int,default=8080)
    parser.add_argument('--library',type=Path,default=BASE/'magazines');parser.add_argument('--data',type=Path,default=BASE/'data')
    parser.add_argument('--newspapers',type=Path,default=None)
    parser.add_argument('--books',type=Path,default=None)
    args=parser.parse_args();server=make_server(args.host,args.port,args.library,args.data,args.newspapers,args.books)
    print(f'PiShelf is running on port {args.port}. Library: {server.library}',flush=True)
    try: server.serve_forever()
    except KeyboardInterrupt: server.server_close()
