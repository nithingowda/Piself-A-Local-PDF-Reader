import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
const js=readFileSync(new URL('../static/app.js',import.meta.url),'utf8');
const html=readFileSync(new URL('../static/index.html',import.meta.url),'utf8');
const css=readFileSync(new URL('../static/style.css',import.meta.url),'utf8');

test('PDF annotations are kept separate from original files and stored by document',()=>{
 assert.match(js,/pishelf:annotations:v1:/);
 assert.match(js,/localStorage\.setItem\(annotationKey\(annotationDocument\)/);
 assert.doesNotMatch(js,/fetch\([^\n]*\.pdf[^\n]*method:\s*['"]PUT/);
});
test('drawing positions are normalized for zoom-safe overlays',()=>{
 assert.match(js,/event\.clientX-r\.left\)\/r\.width\*1000/);
 assert.match(js,/event\.clientY-r\.top\)\/r\.height\*1000/);
 assert.match(js,/setAttribute\('viewBox','0 0 1000 1000'\)/);
 assert.match(css,/\.annotation-layer\{position:absolute/);
});
test('tools, notes, undo, deletion and export are available',()=>{
 for(const type of ['highlight','pen','underline','circle'])assert.match(html,new RegExp('value="'+type+'"'));
 for(const id of ['annotation-save-note','annotation-undo','annotation-export','annotation-list'])assert.ok(html.includes('id="'+id+'"'));
 assert.match(js,/new Blob\(\[lines\.join/);
 assert.match(js,/annotationItems\.splice\(index,1\)/);
});
test('annotations are redrawn after page layout rebuild',()=>{
 assert.match(js,/\$\('pages'\)\.append\(fragment\);\s*annotationDrawAll\(\);/);
 assert.match(js,/annotationLoad\(item\.id\)/);
});
