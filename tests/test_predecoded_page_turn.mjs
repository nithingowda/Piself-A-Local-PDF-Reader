import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
const js=readFileSync(new URL('../static/app.js',import.meta.url),'utf8');
const render=js.slice(js.indexOf('async function renderPages()'),js.indexOf('function trimCanvases()'));
test('client PDF.js renders pages and encodes WebP without server image requests',()=>{
 assert.match(render,/pdfPage\.render\(/);
 assert.match(render,/canvas\.toBlob\(resolve,'image\/webp'/);
 assert.doesNotMatch(render,/\/api\/page-image\//);
});
test('WebP load completes before replacing page pixels and canvas is retained on failure',()=>{
 assert.match(render,/await new Promise\(\(resolve,reject\)=>\{img\.onload=resolve;img\.onerror=reject;img\.src=url;/);
 assert.match(render,/let pixels=canvas/);
 assert.match(render,/replacePagePixels\(slot,pixels\)/);
 assert.match(render,/finally\{URL\.revokeObjectURL\(url\);\}/);
});
test('obsolete renders are cancelled and stale pixels discarded',()=>{
 assert.match(js,/function cancelActiveRender\(/);
 assert.match(render,/g!==generation\|\|epoch!==layoutEpoch\|\|!slot\.isConnected/);
 assert.match(render,/canvas\.width=canvas\.height=0/);
 assert.match(js,/function finishPinch\(cancelled=false\)/);
});
test('page changes never wait for paper fold or Web Animations API',()=>{
 assert.match(js,/function turnBook\(direction\)/);
 assert.doesNotMatch(js,/PAPER_TURN_DURATION_MS|activePageTurn|prepareTurnUnderlay|paper-dragging|animate\(frames/);
});
