"""Live HTTP integration tests for first-run setup and reader/admin authorization."""
import http.client
import json
import tempfile
import threading
import unittest
from pathlib import Path

from server import make_server


class AuthHttpTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory()
        base=Path(self.tmp.name)
        self.server=make_server('127.0.0.1',0,base/'magazines',base/'data')
        self.thread=threading.Thread(target=self.server.serve_forever,daemon=True)
        self.thread.start()
        self.cookies={}
    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=3)
        self.tmp.cleanup()
    def request(self,method,path,payload=None,cookie=None,csrf=None):
        connection=http.client.HTTPConnection('127.0.0.1',self.server.server_port,timeout=10)
        headers={}
        if payload is not None:
            headers['Content-Type']='application/json'
            payload=json.dumps(payload)
        if cookie: headers['Cookie']=cookie
        if csrf: headers['X-PiShelf-CSRF']=csrf
        connection.request(method,path,body=payload,headers=headers)
        response=connection.getresponse()
        body=response.read()
        status=response.status
        set_cookie=response.getheader('Set-Cookie')
        connection.close()
        try: parsed=json.loads(body)
        except (ValueError,UnicodeDecodeError): parsed=None
        return status,parsed,set_cookie
    def test_reader_state_survives_rename_and_trash(self):
        password='correct horse battery staple'
        self.request('POST','/api/auth/setup',{'username':'owner','password':password})

        def sign_in(name):
            status,_,cookie=self.request('POST','/api/auth/login',{'username':name,'password':password})
            self.assertEqual(status,200)
            cookie=cookie.split(';',1)[0]
            _,me,_=self.request('GET','/api/auth/me',cookie=cookie)
            def api(path,data=None):
                status,result,_=self.request('GET' if data is None else 'POST',path,data,cookie,me['csrf'])
                self.assertEqual(status,200,(path,result))
                return result
            return api

        owner=sign_in('owner')
        owner('/api/admin/users',{'action':'create','username':'reader','role':'reader','password':password})
        reader=sign_in('reader')
        library=self.server.library
        (library/'Original.pdf').write_bytes(b'%PDF-test')
        original=owner('/api/library?refresh=1')[0]['id']
        accounts=[(owner,2),(reader,8)]
        for api,page in accounts:
            api('/api/progress',{'id':original,'page':page,'total':10,'bookmarks':[page]})
            api('/api/annotations',{'id':original,'items':[{'type':'note','page':page,'text':str(page)}]})
        renamed=owner('/api/issue/edit',{'id':original,'filename':'New.pdf'})['id']
        token=owner('/api/trash',{'id':renamed})['token']
        (library/'New.pdf').write_bytes(b'%PDF-replacement')
        owner('/api/library?refresh=1')
        for api,page in accounts:
            self.assertEqual(api('/api/progress'),{})
            self.assertEqual(api('/api/annotations?id='+renamed),[])
        replacement=owner('/api/trash',{'id':renamed})['token']
        owner('/api/trash/restore',{'token':token})
        owner('/api/trash/delete',{'token':replacement,'confirm':True})
        for api,page in accounts:
            progress=api('/api/progress')
            self.assertEqual(set(progress),{renamed})
            self.assertEqual(progress[renamed]['page'],page)
            self.assertEqual(progress[renamed]['bookmarks'],[page])
            self.assertEqual(api('/api/annotations?id='+renamed),[{'type':'note','page':page,'text':str(page)}])

    def test_browser_first_admin_and_permissions(self):
        status,result,_=self.request('GET','/api/auth/setup-status')
        self.assertEqual((status,result['setup_required']),(200,True))
        status,_,_=self.request('GET','/')
        self.assertEqual(status,302)
        status,_,_=self.request('POST','/api/auth/setup',{'username':'owner','password':'correct horse battery staple'})
        self.assertEqual(status,200)
        status,result,_=self.request('GET','/api/auth/setup-status')
        self.assertEqual((status,result['setup_required']),(200,False))
        status,_,_=self.request('POST','/api/auth/setup',{'username':'intruder','password':'another secure password'})
        self.assertEqual(status,409)
        status,_,cookie=self.request('POST','/api/auth/login',{'username':'owner','password':'correct horse battery staple'})
        self.assertEqual(status,200)
        admin_cookie=cookie.split(';',1)[0]
        status,me,_=self.request('GET','/api/auth/me',cookie=admin_cookie)
        self.assertEqual((status,me['role']),(200,'admin'))
        status,_,_=self.request('POST','/api/admin/users',{'action':'create','username':'reader1','password':'reader password long','role':'reader'},cookie=admin_cookie)
        self.assertEqual(status,403)  # CSRF required
        status,_,_=self.request('POST','/api/admin/users',{'action':'create','username':'reader1','password':'reader password long','role':'reader'},cookie=admin_cookie,csrf=me['csrf'])
        self.assertEqual(status,200)
        status,_,reader_cookie=self.request('POST','/api/auth/login',{'username':'reader1','password':'reader password long'})
        self.assertEqual(status,200)
        reader_cookie=reader_cookie.split(';',1)[0]
        status,reader,_=self.request('GET','/api/auth/me',cookie=reader_cookie)
        self.assertEqual((status,reader['role']),(200,'reader'))
        status,_,_=self.request('POST','/api/progress',{'id':'a'*20,'page':1,'total':3},cookie=reader_cookie,csrf=reader['csrf'])
        self.assertEqual(status,200)
        status,_,_=self.request('POST','/api/collections',{'action':'create','name':'Forbidden'},cookie=reader_cookie,csrf=reader['csrf'])
        self.assertEqual(status,403)
        for route in ('/api/upload','/api/delete','/api/trash/delete'):
            status,_,_=self.request('POST',route,{},cookie=reader_cookie,csrf=reader['csrf'])
            self.assertEqual(status,403)
        connection=http.client.HTTPConnection('127.0.0.1',self.server.server_port,timeout=10)
        for filename,body in [('notes.txt',b'notes'),('renamed.pdf',b'notes containing %PDF-1.4')]:
            connection.request('POST','/api/upload?filename='+filename,body=body,
                               headers={'Content-Type':'application/pdf','Cookie':admin_cookie,'X-PiShelf-CSRF':me['csrf']})
            rejected=connection.getresponse()
            self.assertEqual(rejected.status,400)
            rejected.read()
        connection.request('POST','/api/upload?filename=sample.pdf',body=b'%PDF-1.4 temporary test document',
                           headers={'Content-Type':'application/pdf','Cookie':admin_cookie,'X-PiShelf-CSRF':me['csrf']})
        response=connection.getresponse()
        self.assertEqual(response.status,201)
        uploaded=json.loads(response.read())
        connection.close()
        delete={'id':uploaded['id'],'confirm':True,'coverKey':'stale-version'}
        status,_,_=self.request('POST','/api/delete',delete,cookie=admin_cookie,csrf=me['csrf'])
        self.assertEqual(status,409)
        del delete['coverKey']
        status,_,_=self.request('POST','/api/delete',delete,cookie=admin_cookie,csrf=me['csrf'])
        self.assertEqual(status,200)
        status,_,_=self.request('GET','/api/library')
        self.assertEqual(status,401)


if __name__=='__main__':
    unittest.main()
