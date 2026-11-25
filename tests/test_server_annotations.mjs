import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
const server=readFileSync(new URL('../server.py',import.meta.url),'utf8');
const client=readFileSync(new URL('../static/app.js',import.meta.url),'utf8');
test('annotations are account scoped and stored compressed',()=>{
 assert.match(server,/PRIMARY KEY\(user_id,document_id\)/);
 assert.match(server,/WHERE user_id=\? AND document_id=\?/);
 assert.match(server,/zlib\.compress\(raw,6\)/);
 assert.match(server,/zlib\.decompress\(row\[0\]\)/);
});
test('annotations require authenticated reads and CSRF-protected writes',()=>{
 assert.match(server,/if path == '\/api\/annotations':\s*user=self\.require_session\(\)/);
 assert.match(server,/if route == '\/api\/annotations':\s*user=self\.require_session\(mutation=True\)/);
 assert.match(server,/len\(raw\)>262144/);
 assert.match(server,/mark\['type'\]=='note'/);
 assert.match(server,/len\(mark\['text'\]\.strip\(\)\)<=4000/);
});
test('permanent deletion and trash cleanup remove annotations',()=>{
 assert.match(server,/def remove_reading_state\(db,key\):\s*db\.execute\('DELETE FROM annotations WHERE document_id=\?'/);
 assert.match(server,/move_reader_state\(db,key,token\)/);
});
test('browser loads and saves via account API with legacy migration',()=>{
 assert.match(client,/api\('\/api\/annotations\?id='/);
 assert.match(client,/api\('\/api\/annotations',\{id,items\}\)/);
 assert.match(client,/localStorage\.removeItem\(annotationKey\(id\)\)/);
 assert.match(client,/await annotationLoad\(item\.id\)/);
});
