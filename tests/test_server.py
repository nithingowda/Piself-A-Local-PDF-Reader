import hashlib
import http.client
import importlib.util
import json
from pathlib import Path
import sqlite3
import tempfile
import threading
import unittest

spec=importlib.util.spec_from_file_location('pishelf',Path(__file__).resolve().parents[1]/'server.py')
app=importlib.util.module_from_spec(spec);spec.loader.exec_module(app)

class LibraryTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.root=Path(self.tmp.name)
        self.mag=self.root/'magazines';self.news=self.root/'newspapers';self.data=self.root/'data'
        self.mag.mkdir();self.news.mkdir();self.data.mkdir()
        self.name='Astronomy, vol. 54.07 (July 2026).pdf'
        (self.mag/self.name).write_bytes(b'%PDF-test-data')
        (self.news/'Daily 2026-07-15.pdf').write_bytes(b'%PDF-news-data')
        # Verify upgrade from the previous schema.
        with sqlite3.connect(self.data/'progress.sqlite3') as db:
            db.execute('CREATE TABLE trash (token TEXT PRIMARY KEY,path TEXT NOT NULL,title TEXT NOT NULL,deleted REAL NOT NULL)')
        self.server=app.make_server('127.0.0.1',0,self.mag,self.data,self.news)
        self.thread=threading.Thread(target=self.server.serve_forever,daemon=True);self.thread.start()
    def tearDown(self):
        self.server.shutdown();self.server.server_close();self.thread.join();self.tmp.cleanup()
    def request(self,path,data=None,headers=None,raw=None):
        conn=http.client.HTTPConnection('127.0.0.1',self.server.server_port)
        headers=headers or {}
        body=raw if raw is not None else json.dumps(data) if data is not None else None
        if data is not None:headers['Content-Type']='application/json'
        try: conn.request('POST' if body is not None else 'GET',path,body,headers)
        except BrokenPipeError: pass  # Server may reject an upload before its body finishes.
        response=conn.getresponse();status=response.status;content=response.read();head=dict(response.getheaders());conn.close()
        try:value=json.loads(content)
        except (ValueError,UnicodeDecodeError):value=content
        return status,value,head
    def items(self):return self.request('/api/library?refresh=1')[1]
    def test_inference_sources_and_legacy_ids(self):
        items=self.items();mag=next(i for i in items if i['source']=='magazines')
        self.assertEqual(mag['id'],hashlib.sha256(self.name.encode()).hexdigest()[:20])
        self.assertEqual((mag['series'],mag['issueDate']),('Astronomy','2026-07'))
        news=next(i for i in items if i['source']=='newspapers');self.assertEqual(news['issueDate'],'2026-07-15')
        self.assertEqual(self.request('/newspapers/Daily%202026-07-15.pdf')[0],200)
    def test_edit_preserves_progress_and_conflicts(self):
        old=self.items()[0]['id'];self.request('/api/progress',{'id':old,'page':3,'total':20,'bookmarks':[2,3],'favorite':True})
        self.assertEqual(self.request('/api/categories',{'source':'magazines','path':'Science/Space'})[0],200)
        status,result,_=self.request('/api/issue/edit',{'id':old,'filename':'New.pdf','category':'Science/Space','series':'Astronomy','issueDate':'2026-07','tags':['Space']})
        self.assertEqual(status,200);new=result['id'];self.assertNotEqual(old,new)
        progress=self.request('/api/progress')[1];self.assertNotIn(old,progress);self.assertEqual(progress[new]['bookmarks'],[2,3])
        self.assertTrue((self.mag/'Science/Space/New.pdf').is_file())
        (self.mag/'Science/Space/Existing.pdf').write_bytes(b'keep')
        self.assertEqual(self.request('/api/issue/edit',{'id':new,'filename':'Existing.pdf'})[0],409)
        self.assertEqual((self.mag/'Science/Space/Existing.pdf').read_bytes(),b'keep')
    def test_backup_roundtrip_and_validation(self):
        key=self.items()[0]['id'];self.request('/api/progress',{'id':key,'page':4,'total':10,'bookmarks':[1,4]})
        self.request('/api/issue/edit',{'id':key,'series':'Astronomy','issueDate':'2026-07','tags':['Space']})
        backup=self.request('/api/backup')[1]
        self.request('/api/progress/clear',{'id':key})
        self.assertEqual(self.request('/api/backup/restore',backup)[0],200)
        self.assertEqual(self.request('/api/progress')[1][key]['page'],4)
        backup['progress'][key]['page']=-1
        self.assertEqual(self.request('/api/backup/restore',backup)[0],400)
        self.assertEqual(self.request('/api/progress')[1][key]['page'],4)
    def test_cover_persistence_and_invalidation(self):
        item=self.items()[0];path='/api/covers/'+item['coverKey'];jpeg=b'\xff\xd8test\xff\xd9'
        self.assertEqual(self.request(path)[0],404)
        self.assertEqual(self.request(path,raw=jpeg,headers={'Content-Type':'image/jpeg'})[0],200)
        status,body,headers=self.request(path);self.assertEqual(status,200);self.assertEqual(body,jpeg)
        self.assertIn('immutable',headers['Cache-Control']);self.assertTrue((self.data/'covers'/(item['coverKey']+'.jpg')).exists())
        self.assertEqual(self.request(path,headers={'If-None-Match':headers['ETag']})[0],304)
        (self.mag/self.name).write_bytes(b'%PDF-changed-size')
        self.assertNotEqual(self.items()[0]['coverKey'],item['coverKey'])
    def test_news_trash_restore(self):
        item=next(i for i in self.items() if i['source']=='newspapers')
        status,result,_=self.request('/api/trash',{'id':item['id']});self.assertEqual(status,200)
        self.assertFalse((self.news/item['path']).exists())
        self.assertEqual(self.request('/api/trash/restore',{'token':result['token']})[0],200)
        self.assertTrue((self.news/item['path']).exists())
    def test_path_origin_and_invalid_dates(self):
        self.assertEqual(self.request('/api/categories',{'path':'../outside'})[0],400)
        self.assertEqual(self.request('/api/categories',{'path':'Safe'},headers={'Origin':'http://evil.test'})[0],403)
        (self.mag/'Link').symlink_to(self.root/'data',target_is_directory=True)
        self.assertEqual(self.request('/api/categories',{'path':'Link/Bad'})[0],403)
        key=self.items()[0]['id']
        self.assertEqual(self.request('/api/issue/edit',{'id':key,'issueDate':'2026-19'})[0],400)
        self.assertEqual(self.request('/api/issue/edit',{'id':key,'filename':'../bad.pdf'})[0],400)
    def test_range_requests(self):
        status,body,headers=self.request('/newspapers/Daily%202026-07-15.pdf',headers={'Range':'bytes=0-3'})
        self.assertEqual((status,body),(206,b'%PDF'));self.assertEqual(headers['Content-Range'],'bytes 0-3/14')

if __name__=='__main__': unittest.main()
