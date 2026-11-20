"""Integration tests for Books and DRM-free EPUB support."""
import http.client
import io
import json
import sqlite3
import tempfile
import threading
import unittest
import zipfile
from pathlib import Path

import auth
from server import APIError, make_server, validate_epub


def example_epub(bad_name=False):
    data=io.BytesIO()
    with zipfile.ZipFile(data,'w') as archive:
        archive.writestr('mimetype','application/epub+zip',compress_type=zipfile.ZIP_STORED)
        archive.writestr('META-INF/container.xml','<container/>')
        archive.writestr('../bad.xhtml' if bad_name else 'OEBPS/chapter.xhtml','<html><body>Book</body></html>')
    return data.getvalue()


class BookEpubTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory()
        root=Path(self.temp.name)
        self.magazines=root/'Magazines'
        self.news=root/'NewsPapers'
        self.books=root/'Books'
        self.server=make_server('127.0.0.1',0,self.magazines,root/'data',self.news,self.books)
        self.thread=threading.Thread(target=self.server.serve_forever,daemon=True)
        self.thread.start()
        with sqlite3.connect(self.server.state_db) as db:
            auth.create_user(db,'owner','correct horse battery staple','admin')
            self.token,self.csrf=auth.new_session(db,db.execute("SELECT id FROM auth_users").fetchone()[0])

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=3)
        self.temp.cleanup()

    def request(self,method,path,payload=None,content_type=None,authorize=True,csrf=False,headers=None):
        request_headers=dict(headers or {})
        if authorize:request_headers['Cookie']='pishelf_session='+self.token
        if csrf:request_headers['X-PiShelf-CSRF']=self.csrf
        if isinstance(payload,dict):
            payload=json.dumps(payload).encode()
            request_headers['Content-Type']='application/json'
        elif content_type:
            request_headers['Content-Type']=content_type
        c=http.client.HTTPConnection('127.0.0.1',self.server.server_port,timeout=10)
        c.request(method,path,body=payload,headers=request_headers)
        response=c.getresponse()
        raw=response.read()
        status=response.status
        response_headers=dict(response.getheaders())
        c.close()
        try: value=json.loads(raw)
        except (ValueError,UnicodeDecodeError): value=raw
        return status,value,response_headers

    def test_book_source_and_formats(self):
        (self.books/'Novel.epub').write_bytes(example_epub())
        (self.books/'Manual.pdf').write_bytes(b'%PDF-1.4\n')
        (self.magazines/'NotABook.epub').write_bytes(example_epub())
        status,items,_=self.request('GET','/api/library?refresh=1')
        self.assertEqual(status,200)
        books=[x for x in items if x['source']=='books']
        self.assertEqual({x['format'] for x in books},{'epub','pdf'})
        self.assertEqual(len(books),2)
        self.assertEqual(len([x for x in items if x['source']=='magazines']),0)
        self.assertEqual(len({x['id'] for x in books}),2)
        status,body,headers=self.request('GET','/books/Novel.epub',headers={'Range':'bytes=0-3'})
        self.assertEqual(status,206)
        self.assertEqual(body,b'PK\x03\x04')
        self.assertEqual(headers.get('Content-Type'),'application/epub+zip')
        status,_,_=self.request('GET','/books/Novel.epub',authorize=False)
        self.assertEqual(status,401)
        epub=next(x for x in books if x['format']=='epub')
        status,_,_=self.request('GET','/api/page-image/'+epub['id']+'/1?width=960')
        self.assertEqual(status,415)

    def test_epub_upload_and_shared_resume(self):
        body=example_epub()
        status,result,_=self.request('POST','/api/upload?source=books&filename=Book.epub',body,'application/epub+zip',csrf=True)
        self.assertEqual(status,201,result)
        id_=result['id']
        status,result,_=self.request('POST','/api/progress',{'id':id_,'epubCfi':'epubcfi(/6/4!/4/2:0)','page':1,'total':4},csrf=True)
        self.assertEqual(status,200,result)
        status,progress,_=self.request('GET','/api/progress')
        self.assertEqual(status,200)
        self.assertEqual(progress[id_]['epubCfi'],'epubcfi(/6/4!/4/2:0)')
        self.assertGreater(progress[id_]['lastRead'],0)
        status,_,_=self.request('POST','/api/upload?source=magazines&filename=Book.epub',body,'application/epub+zip',csrf=True)
        self.assertEqual(status,400)
        status,_,_=self.request('POST','/api/upload?source=books&filename=Book.epub',body,'application/epub+zip',csrf=True)
        self.assertEqual(status,409)

    def test_pdf_upload_requires_csrf_and_accepts_valid_token(self):
        # The browser upload XHR must send the session-specific security token.
        payload=b'%PDF-1.4\\n1 0 obj\\n<<>>\\nendobj\\n%%EOF'
        path='/api/upload?source=books&filename=SecurityTest.pdf'
        status,data,_=self.request('POST',path,payload,'application/pdf')
        self.assertEqual(status,403)
        self.assertEqual(data.get('error'),'Invalid security token.')
        self.assertFalse((self.books/'SecurityTest.pdf').exists())

        status,data,_=self.request('POST',path,payload,'application/pdf',csrf=True)
        self.assertEqual(status,201,data)
        self.assertTrue((self.books/'SecurityTest.pdf').exists())

    def test_pdf_upload_rejects_invalid_csrf_token(self):
        payload=b'%PDF-1.4\\n%%EOF'
        path='/api/upload?source=magazines&filename=WrongToken.pdf'
        status,data,_=self.request('POST',path,payload,'application/pdf',
                                   headers={'X-PiShelf-CSRF':'not-the-session-token'})
        self.assertEqual(status,403)
        self.assertEqual(data.get('error'),'Invalid security token.')
        self.assertFalse((self.magazines/'WrongToken.pdf').exists())

    def test_invalid_epub_archive_rejected(self):
        (self.books/'bad.epub').write_bytes(example_epub(bad_name=True))
        with self.assertRaises(APIError):
            validate_epub(self.books/'bad.epub')
        status,_,_=self.request('POST','/api/upload?source=books&filename=malicious.epub',example_epub(True),'application/epub+zip',csrf=True)
        self.assertEqual(status,400)
        self.assertFalse((self.books/'malicious.epub').exists())

    def test_book_source_does_not_overlap_other_folders(self):
        with self.assertRaises(ValueError):
            server=make_server('127.0.0.1',0,self.magazines,self.server.state_db.parent,self.news,self.magazines)
            server.server_close()


if __name__=='__main__':
    unittest.main()
