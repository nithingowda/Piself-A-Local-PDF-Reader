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
        items = []
        for folder, dirs, files in os.walk(self.server.library, followlinks=False):
            dirs[:] = [d for d in dirs if not d.startswith('.') and not (Path(folder)/d).is_symlink()]
            for name in files:
                p = Path(folder)/name
                if name.startswith('.') or p.suffix.lower() != '.pdf' or p.is_symlink(): continue
                try:
                    if not p.resolve().is_relative_to(self.server.library): continue
                    st = p.stat()
                except OSError: continue
                rel = p.relative_to(self.server.library).as_posix()
                items.append(dict(id=hashlib.sha256(rel.encode()).hexdigest()[:20], path=rel, title=p.stem.replace('_',' '), category=p.parent.relative_to(self.server.library).as_posix(), size=st.st_size, modified=st.st_mtime))
        return sorted(items, key=lambda i: i['path'])

    def do_POST(self):
        try:
            origin = self.headers.get('Origin')
            if (origin and urlsplit(origin).netloc != self.headers.get('Host')) or self.headers.get('Sec-Fetch-Site') == 'cross-site':
                raise APIError(403, 'Cross-origin changes are not allowed.')
            length = int(self.headers.get('Content-Length', '0'))
            if not 0 < length <= 16384 or self.headers.get_content_type() != 'application/json':
                raise APIError(400, 'Expected a small JSON request.')
            data = json.loads(self.rfile.read(length))
            if not isinstance(data, dict): raise APIError(400, 'Invalid request.')
            with self.server.mutation_lock:
                with sqlite3.connect(self.server.state_db) as db:
                    result = self.mutate(data, db)
            self.json_response(result)
        except APIError as e: self.json_response({'error':e.message}, e.status)
        except (ValueError, KeyError, TypeError): self.json_response({'error':'Invalid request.'}, 400)
        except (OSError, sqlite3.Error): self.json_response({'error':'Could not write changes. Check folder permissions and free space.'}, 500)

    def mutate(self, data, db):
        route = urlsplit(self.path).path
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
            source=self.server.library/item['path']
            token=uuid.uuid4().hex
            trash=self.server.library/'.pishelf-trash'
            if trash.is_symlink(): raise APIError(409,'Trash folder cannot be a symlink.')
            trash.mkdir(exist_ok=True)
            destination=trash/(token+'.pdf')
            source.rename(destination)
            try:
                db.execute('INSERT INTO trash VALUES (?,?,?,?)',(token,item['path'],item['title'],time.time()))
                db.commit()
            except Exception:
                destination.rename(source)
                raise
            return {'ok':True,'token':token}
        if route == '/api/trash/restore':
            token=data['token']
            if not isinstance(token,str) or not re.fullmatch('[a-f0-9]{32}',token): raise ValueError()
            row=db.execute('SELECT path FROM trash WHERE token=?',(token,)).fetchone()
            if not row: raise APIError(404,'Trash item not found.')
            destination=self.server.library/row[0]
            if not destination.resolve().is_relative_to(self.server.library): raise APIError(403,'Invalid restore path.')
            if destination.exists(): raise APIError(409,'A file already exists at the original location. Rename it first.')
            destination.parent.mkdir(parents=True,exist_ok=True)
            source=self.server.library/'.pishelf-trash'/(token+'.pdf')
            if source.is_symlink() or not source.resolve().is_relative_to(self.server.library): raise APIError(403,'Invalid trash path.')
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
            if path == '/api/library': self.json_response(self.library_items(),head=head); return
            if path in ('/api/progress','/api/trash'):
                with sqlite3.connect(self.server.state_db) as db:
                    if path.endswith('progress'):
                        result={key:json.loads(value) for key,value in db.execute('SELECT id,value FROM progress')}
                    else:
                        result=[dict(token=r[0],path=r[1],title=r[2],deleted=r[3]) for r in db.execute('SELECT * FROM trash ORDER BY deleted DESC')]
                self.json_response(result,head=head); return
            if path.startswith('/magazines/'):
                root,relative=self.server.library,path[len('/magazines/'):]
                if Path(relative).suffix.lower()!='.pdf' or any(p.startswith('.') for p in Path(relative).parts):
                    self.send_error(404); return
            else: root,relative=BASE/'static',path.lstrip('/') or 'index.html'
            target=(root/relative).resolve()
            if not target.is_relative_to(root.resolve()) or not target.is_file(): self.send_error(404); return
            size=target.stat().st_size
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

def make_server(host,port,library,data):
    library=Path(library).expanduser().resolve();library.mkdir(parents=True,exist_ok=True)
    data=Path(data).expanduser().resolve();data.mkdir(parents=True,exist_ok=True)
    server=ThreadingHTTPServer((host,port),Handler)
    server.library=library;server.state_db=data/'progress.sqlite3';server.mutation_lock=threading.Lock()
    with sqlite3.connect(server.state_db) as db:
        db.execute('CREATE TABLE IF NOT EXISTS progress (id TEXT PRIMARY KEY,value TEXT NOT NULL)')
        db.execute('CREATE TABLE IF NOT EXISTS trash (token TEXT PRIMARY KEY,path TEXT NOT NULL,title TEXT NOT NULL,deleted REAL NOT NULL)')
    return server

if __name__=='__main__':
    parser=argparse.ArgumentParser()
    parser.add_argument('--host',default='0.0.0.0');parser.add_argument('--port',type=int,default=8080)
    parser.add_argument('--library',type=Path,default=BASE/'magazines');parser.add_argument('--data',type=Path,default=BASE/'data')
    args=parser.parse_args();server=make_server(args.host,args.port,args.library,args.data)
    print(f'PiShelf is running on port {args.port}. Library: {server.library}',flush=True)
    try: server.serve_forever()
    except KeyboardInterrupt: server.server_close()
