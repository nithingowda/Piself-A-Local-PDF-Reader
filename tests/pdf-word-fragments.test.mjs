import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const source=await readFile(new URL('../static/pdf-reading-order.js',import.meta.url),'utf8');
const {pdfSpeechText}=await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
const run=(str,x,boxWidth)=>({str,x,y:100,boxWidth,boxHeight:12,readingRegion:0,readingColumn:0});
test('adjacent font runs preserve effort',()=>assert.equal(pdfSpeechText([run('ef',10,9),run('fort',19,18)]),'effort'));
test('visible word spacing remains intact',()=>assert.equal(pdfSpeechText([run('great',10,25),run('effort',39,28)]),'great effort'));
test('explicit whitespace remains intact',()=>assert.equal(pdfSpeechText([run('great ',10,28),run('effort',38,28)]),'great effort'));
