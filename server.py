#!/usr/bin/env python3
"""PiShelf: a local PDF library with durable reading state and recoverable trash."""
import argparse
import hashlib
import json
import mimetypes
import os
import re
import shutil
import errno
import sqlite3
import threading
import time
import uuid
import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlsplit, quote

BASE = Path(__file__).resolve().parent

class APIError(Exception):
    def __init__(self, status, message):
        self.status, self.message = status, message

class Handler(BaseHTTPRequestHandler):
    def json_response(self, value, status=200, head=False):
        body = json.dumps(value).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.end_headers()
        if not head: self.wfile.write(body)

    def library_items(self):
        with self.server.scan_lock:
            if time.monotonic() - self.server.scan_time < 10:
                return self.server.scan_items
            items = []
            with sqlite3.connect(self.server.state_db) as db:
                metadata = {key: json.loads(raw) for key, raw in db.execute('SELECT id,value FROM metadata')}
            for source, root in self.server.roots.items():
                for folder, dirs, files in os.walk(root, followlinks=False):
                    dirs[:] = [d for d in dirs if not d.startswith('.') and not (Path(folder)/d).is_symlink()]
                    for name in files:
                        path = Path(folder)/name
                        if name.startswith('.') or path.suffix.lower() != '.pdf' or path.is_symlink(): continue
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
                            modified=info.st_mtime, coverKey=cover_key, **inferred))
            self.server.scan_items = sorted(items, key=lambda i:(i['source'],i['path']))
            self.server.scan_time = time.monotonic()
            return self.server.scan_items

    def categories(self):
        result = []
        for source, root in self.server.roots.items():
            for folder, dirs, _ in os.walk(root, followlinks=False):
                dirs[:] = [d for d in dirs if not d.startswith('.') and not (Path(folder)/d).is_symlink()]
                result.append(dict(source=source, path=Path(folder).relative_to(root).as_posix()))
        return result

    def accept_origin(self):
        origin = self.headers.get('Origin')
        if (origin and urlsplit(origin).netloc != self.headers.get('Host')) or self.headers.get('Sec-Fetch-Site') == 'cross-site':
            raise APIError(403, 'Cross-origin changes are not allowed.')

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

    def do_POST(self):
        try:
            self.accept_origin()
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
            self.server.scan_time = float('-inf')
            self.json_response(result)
        except APIError as e: self.json_response({'error':e.message}, e.status)
        except (ValueError, KeyError, TypeError): self.json_response({'error':'Invalid request.'}, 400)
        except (OSError, sqlite3.Error): self.json_response({'error':'Could not write changes. Check folder permissions and free space.'}, 500)

    def mutate(self, data, db):
        route = urlsplit(self.path).path
        if route == '/api/categories':
            source = data.get('source','magazines')
            root = self.server.roots.get(source)
            if root is None: raise ValueError()
            path = safe_relative(data['path'])
            folder = checked_path(root, path)
            folder.mkdir(parents=True, exist_ok=True)
            return {'ok': True}
        if route == '/api/issue/edit':
            item = next((i for i in self.library_items() if i['id']==data.get('id')), None)
            if not item: raise APIError(404, 'Issue not found. Refresh your library.')
            metadata = validate_metadata({**{k:item[k] for k in ('series','issueDate','tags')}, **{k:data[k] for k in ('series','issueDate','tags') if k in data}})
            filename = data.get('filename',Path(item['path']).name)
            if not isinstance(filename,str) or '/' in filename or '\\' in filename or not filename.lower().endswith('.pdf'):
                raise APIError(400,'Use a PDF filename without slashes.')
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
                db.execute('INSERT OR REPLACE INTO metadata VALUES (?,?)',(new_id,json.dumps(metadata)))
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
        if route == '/api/progress':
            key=data.pop('id')
            if not isinstance(key,str) or not re.fullmatch('[a-f0-9]{20}',key): raise ValueError()
            if not data or set(data)-{'page','total','favorite','bookmarks','completed'}: raise ValueError()
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
            if 'page' in data: value['lastRead']=time.time()
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
            destination=trash/(token+'.pdf')
            source.rename(destination)
            try:
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
            source=root/'.pishelf-trash'/(token+'.pdf')
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

    def do_HEAD(self): self.do_GET(head=True)

    def do_GET(self, head=False):
        path=unquote(urlsplit(self.path).path)
        try:
            if path == '/api/health': self.json_response({'status':'ok'},head=head); return
            if path == '/api/library':
                if 'refresh=1' in urlsplit(self.path).query: self.server.scan_time=float('-inf')
                self.json_response(self.library_items(),head=head); return
            if path == '/api/categories': self.json_response(self.categories(),head=head); return
            if path == '/api/backup':
                with sqlite3.connect(self.server.state_db) as db:
                    db.execute('BEGIN')
                    value=dict(format='pishelf-backup',version=1,created=datetime.datetime.now(datetime.timezone.utc).isoformat(),
                        progress={k:json.loads(v) for k,v in db.execute('SELECT id,value FROM progress')},
                        metadata={k:json.loads(v) for k,v in db.execute('SELECT id,value FROM metadata')},categories=self.categories())
                self.json_response(value,head=head); return

            if path in ('/api/progress','/api/trash'):
                with sqlite3.connect(self.server.state_db) as db:
                    if path.endswith('progress'):
                        result={key:json.loads(value) for key,value in db.execute('SELECT id,value FROM progress')}
                    else:
                        result=[dict(token=r[0],path=r[1],title=r[2],deleted=r[3],source=r[4]) for r in db.execute('SELECT token,path,title,deleted,source FROM trash ORDER BY deleted DESC')]
                self.json_response(result,head=head); return
            cover = path.startswith('/api/covers/')
            if cover:
                key=path.rsplit('/',1)[-1]
                if not re.fullmatch('[a-f0-9]{64}',key): self.send_error(404); return
                root,relative=self.server.cover_dir,key+'.jpg'
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
            self.send_header('Content-Type','text/javascript' if target.suffix=='.mjs' else mimetypes.guess_type(target.name)[0] or 'application/octet-stream')
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
        except (BrokenPipeError,ConnectionResetError): pass
        except (OSError,sqlite3.Error): self.send_error(500,'Unable to read library storage.')

def item_id(source,relative):
    identity=relative if source=='magazines' else source+':'+relative
    return hashlib.sha256(identity.encode()).hexdigest()[:20]


def safe_relative(value):
    if not isinstance(value,str) or not value or len(value)>240 or '\\' in value or any(ord(c)<32 for c in value): raise ValueError()
    if value.startswith('/') or any(p in ('','.','..') or p.startswith('.') for p in value.split('/')): raise ValueError()
    return value


def checked_path(root,relative):
    safe_relative(relative)
    target=root/relative
    if not target.resolve().is_relative_to(root): raise APIError(403,'Path leaves the library.')
    cursor=root
    for part in Path(relative).parts:
        cursor=cursor/part
        if cursor.is_symlink(): raise APIError(403,'Symlinks cannot be modified.')
    return target


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


def validate_progress(value):
    if not isinstance(value,dict) or set(value)-{'page','total','favorite','bookmarks','completed','lastRead'}: raise ValueError()
    for field in ('page','total'):
        if field in value and (type(value[field]) is not int or not 1<=value[field]<=100000): raise ValueError()
    if 'page' in value and ('total' not in value or value['page']>value['total']): raise ValueError()
    for field in ('favorite','completed'):
        if field in value and type(value[field]) is not bool: raise ValueError()
    marks=value.get('bookmarks',[])
    if not isinstance(marks,list) or len(marks)>1000 or any(type(n) is not int or not 1<=n<=100000 for n in marks): raise ValueError()
    if 'lastRead' in value and (type(value['lastRead']) not in (int,float) or not 0<=value['lastRead']<=1e12): raise ValueError()


def make_server(host,port,library,data,newspapers=None):
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
    server.cover_dir=data/'covers'
    if server.cover_dir.is_symlink(): raise ValueError('Cover cache cannot be a symlink.')
    server.cover_dir.mkdir(exist_ok=True)
    server.cover_bytes=sum(p.stat().st_size for p in server.cover_dir.glob('*.jpg'))
    server.scan_lock=threading.Lock();server.cover_lock=threading.Lock();server.scan_time=float('-inf');server.scan_items=[]
    with sqlite3.connect(server.state_db) as db:
        db.execute('CREATE TABLE IF NOT EXISTS metadata (id TEXT PRIMARY KEY,value TEXT NOT NULL)')
        db.execute('CREATE TABLE IF NOT EXISTS progress (id TEXT PRIMARY KEY,value TEXT NOT NULL)')
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
    args=parser.parse_args();server=make_server(args.host,args.port,args.library,args.data,args.newspapers)
    print(f'PiShelf is running on port {args.port}. Library: {server.library}',flush=True)
    try: server.serve_forever()
    except KeyboardInterrupt: server.server_close()
