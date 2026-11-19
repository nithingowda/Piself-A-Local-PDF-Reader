import http.client
import socket
import unittest
import test_server

class AddedFeatureTests(unittest.TestCase):
    setUp=test_server.LibraryTests.setUp
    tearDown=test_server.LibraryTests.tearDown
    request=test_server.LibraryTests.request
    items=test_server.LibraryTests.items
    def test_collections_rename_backup_and_remove(self):
        key=self.items()[0]['id']
        status,created,_=self.request('/api/collections',{'name':'Read later'});self.assertEqual(status,200)
        collection=created['id']
        self.assertEqual(self.request('/api/collections',{'name':'read later'})[0],409)
        self.assertEqual(self.request('/api/issue/edit',{'id':key,'collectionIds':[collection]})[0],200)
        new=self.request('/api/issue/edit',{'id':key,'filename':'Renamed.pdf'})[1]['id']
        self.assertEqual(self.request('/api/collections')[1][0]['items'],[new])
        self.assertEqual(self.request('/api/collections',{'action':'rename','id':collection,'name':'Weekend'})[0],200)
        backup=self.request('/api/backup')[1]
        self.assertEqual(backup['collections'][0]['name'],'Weekend')
        self.request('/api/collections',{'action':'delete','id':collection})
        self.assertTrue((self.mag/'Renamed.pdf').exists())
        self.assertEqual(self.request('/api/backup/restore',backup)[0],200)
        self.assertEqual(self.request('/api/collections')[1][0]['items'],[new])
    def test_permanent_delete_and_trash_delete(self):
        key=self.items()[0]['id']
        self.request('/api/progress',{'id':key,'favorite':True})
        self.assertEqual(self.request('/api/delete',{'id':key})[0],400)
        self.assertTrue((self.mag/self.name).exists())
        self.assertEqual(self.request('/api/delete',{'id':key,'confirm':True})[0],200)
        self.assertFalse((self.mag/self.name).exists());self.assertNotIn(key,self.request('/api/progress')[1])
        news=self.items()[0];token=self.request('/api/trash',{'id':news['id']})[1]['token']
        trashed=self.news/'.pishelf-trash'/(token+'.pdf');self.assertTrue(trashed.exists())
        self.assertEqual(self.request('/api/trash/delete',{'token':token,'confirm':True})[0],200)
        self.assertFalse(trashed.exists());self.assertEqual(self.request('/api/trash')[1],[])
    def test_upload_validation_conflict_and_destination(self):
        body=b'%PDF-1.7\n'+b'example '*100000
        path='/api/upload?filename=Uploaded.pdf&source=newspapers&category=Daily'
        status,result,_=self.request(path,raw=body,headers={'Content-Type':'application/pdf'})
        self.assertEqual(status,201);self.assertEqual((self.news/'Daily/Uploaded.pdf').read_bytes(),body)
        self.assertEqual(self.request(path,raw=body,headers={'Content-Type':'application/pdf'})[0],409)
        self.assertEqual(self.request('/api/upload?filename=Bad.pdf',raw=b'not pdf',headers={'Content-Type':'application/pdf'})[0],400)
        self.assertFalse((self.mag/'Bad.pdf').exists())
        self.assertEqual(self.request('/api/upload?filename=../Escape.pdf',raw=body,headers={'Content-Type':'application/pdf'})[0],400)
        self.assertEqual(self.request('/api/upload?filename=Huge.pdf',raw=b'',headers={'Content-Type':'application/pdf','Content-Length':str(513*1024*1024)})[0],413)
        self.assertFalse(list(self.mag.glob('.pishelf-upload-*')))
    def test_interrupted_upload_is_not_published(self):
        conn=http.client.HTTPConnection('127.0.0.1',self.server.server_port)
        conn.request('POST','/api/upload?filename=Partial.pdf',b'%PDF-1.7',{'Content-Type':'application/pdf','Content-Length':'9999'})
        conn.sock.shutdown(socket.SHUT_WR)
        response=conn.getresponse();self.assertEqual(response.status,400);response.read();conn.close()
        self.assertFalse((self.mag/'Partial.pdf').exists());self.assertFalse(list(self.mag.glob('.pishelf-upload-*')))
    def test_reader_options_and_scan_cache(self):
        key=self.items()[0]['id'];scan=self.server.scan_time
        self.assertEqual(self.request('/api/progress',{'id':key,'page':2,'total':5,'zoom':2,'mode':'single','rotation':90})[0],200)
        self.assertEqual(self.server.scan_time,scan)
        state=self.request('/api/progress')[1][key];self.assertEqual((state['zoom'],state['mode'],state['rotation']),(2,'single',90))
        self.assertEqual(self.request('/api/progress',{'id':key,'zoom':999})[0],400)
        self.assertEqual(self.request('/api/progress',{'id':key,'rotation':2})[0],400)
        backup=self.request('/api/backup')[1];self.assertEqual(self.request('/api/backup/restore',backup)[0],200)
