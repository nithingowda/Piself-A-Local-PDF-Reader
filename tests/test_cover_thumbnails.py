"""Regression tests for newspaper and book first-page / embedded EPUB covers."""
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
from PIL import Image
from epub_covers import embedded_cover_jpeg
from server import make_server


def epub_bytes(with_cover=True, epub2=False, unsafe=False):
    image=Image.new('RGB',(360,520),(78,122,168))
    image_buffer=io.BytesIO()
    image.save(image_buffer,format='PNG')
    manifest=('<item id="cover-id" href="Images/front.png" media-type="image/png"'
              +(' properties="cover-image"' if not epub2 else '')+' />') if with_cover else ''
    metadata='<meta name="cover" content="cover-id"/>' if epub2 and with_cover else ''
    package=('<package xmlns="http://www.idpf.org/2007/opf"><metadata>'+metadata+
             '</metadata><manifest>'+manifest+'</manifest></package>')
    container=('<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container">'
               '<rootfiles><rootfile full-path="OEBPS/book.opf" '
               'media-type="application/oebps-package+xml"/></rootfiles></container>')
    stream=io.BytesIO()
    with zipfile.ZipFile(stream,'w') as z:
        z.writestr('mimetype','application/epub+zip',compress_type=zipfile.ZIP_STORED)
        z.writestr('META-INF/container.xml',container)
        z.writestr('OEBPS/book.opf',package)
        if with_cover:z.writestr('../unsafe.png' if unsafe else 'OEBPS/Images/front.png',image_buffer.getvalue())
    return stream.getvalue()


def pdf_bytes():
    output=io.BytesIO()
    with Image.new('RGB',(612,792),'red') as image:
        image.save(output,format='PDF',resolution=72)
    return output.getvalue()


class LibraryCoverTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory()
        root=Path(self.tmp.name)
        self.mag=root/'magazines'
        self.news=root/'newspapers'
        self.books=root/'books'
        self.server=make_server('127.0.0.1',0,self.mag,root/'data',self.news,self.books)
        with sqlite3.connect(self.server.state_db) as db:
            auth.create_user(db,'owner','correct horse battery staple','admin')
            user_id=db.execute("SELECT id FROM auth_users WHERE username='owner'").fetchone()[0]
            self.token,self.csrf=auth.new_session(db,user_id)
        self.thread=threading.Thread(target=self.server.serve_forever,daemon=True)
        self.thread.start()

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=3)
        self.tmp.cleanup()

    def get(self,path,authorize=True):
        conn=http.client.HTTPConnection('127.0.0.1',self.server.server_port,timeout=15)
        headers={'Cookie':'pishelf_session='+self.token} if authorize else {}
        conn.request('GET',path,headers=headers)
        response=conn.getresponse()
        body=response.read()
        code=response.status
        response_headers=dict(response.getheaders())
        conn.close()
        return code,body,response_headers

    def items(self):
        status,raw,_=self.get('/api/library?refresh=1')
        self.assertEqual(status,200)
        return json.loads(raw)

    def test_first_page_webp_for_newspaper_and_pdf_book(self):
        (self.news/'Daily.pdf').write_bytes(pdf_bytes())
        (self.books/'Guide.pdf').write_bytes(pdf_bytes())
        for item in self.items():
            if item['source'] not in ('books','newspapers'):continue
            status,body,headers=self.get('/api/page-image/'+item['id']+'/1?width=400')
            self.assertEqual(status,200)
            self.assertEqual(headers['Content-Type'],'image/webp')
            with Image.open(io.BytesIO(body)) as decoded:
                self.assertEqual(decoded.format,'WEBP')
                self.assertEqual(decoded.size,(400,518))
                red,green,blue=decoded.convert("RGB").getpixel((200,250))
                self.assertGreater(red,max(green,blue)+150)
            # Cover endpoint is used for manual cached JPEGs; WebP is the fallback.
            status,_,_=self.get('/api/covers/'+item['coverKey'])
            self.assertEqual(status,404)

    def test_epub3_cover_is_extracted_and_cached(self):
        (self.books/'Novel.epub').write_bytes(epub_bytes())
        item=next(i for i in self.items() if i['format']=='epub')
        status,_,_=self.get('/api/epub-cover/'+item['id'],authorize=False)
        self.assertEqual(status,401)
        status,body,headers=self.get('/api/epub-cover/'+item['id'])
        self.assertEqual(status,302,body)
        self.assertEqual(headers['Location'],'/api/covers/'+item['coverKey'])
        status,body,headers=self.get(headers['Location'])
        self.assertEqual(status,200)
        self.assertEqual(headers['Content-Type'],'image/jpeg')
        with Image.open(io.BytesIO(body)) as img:
            self.assertEqual(img.format,'JPEG')
            self.assertLessEqual(img.width,600)
            self.assertLessEqual(img.height,900)
        status,_,_=self.get('/api/epub-cover/'+item['id'])
        self.assertEqual(status,302)

    def test_epub2_cover_metadata_supported(self):
        path=self.books/'Old.epub'
        path.write_bytes(epub_bytes(epub2=True))
        raw=embedded_cover_jpeg(path)
        self.assertIsNotNone(raw)
        with Image.open(io.BytesIO(raw)) as image:
            self.assertEqual(image.format,'JPEG')

    def test_missing_cover_falls_back_to_book_title(self):
        path=self.books/'Plain.epub'
        path.write_bytes(epub_bytes(with_cover=False))
        self.assertIsNone(embedded_cover_jpeg(path))
        item=next(i for i in self.items() if i['format']=='epub')
        code,_,_=self.get('/api/epub-cover/'+item['id'])
        self.assertEqual(code,404)

    def test_unsafe_epub_member_not_extracted(self):
        path=self.books/'Unsafe.epub'
        path.write_bytes(epub_bytes(unsafe=True))
        self.assertIsNone(embedded_cover_jpeg(path))


if __name__=='__main__':
    unittest.main()
