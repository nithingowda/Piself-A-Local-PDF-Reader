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
        status,_,_=self.request('GET','/api/library')
        self.assertEqual(status,401)


if __name__=='__main__':
    unittest.main()
