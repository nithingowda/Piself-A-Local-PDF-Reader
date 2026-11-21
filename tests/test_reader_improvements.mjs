import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';

const js=readFileSync(new URL('../static/app.js',import.meta.url),'utf8');
const html=readFileSync(new URL('../static/index.html',import.meta.url),'utf8');

// Exercise the production adaptive prefetch policy without a browser.
const start=js.indexOf('function readerPrefetchMargin()');
const stop=js.indexOf('/** rebuild:',start);
assert.ok(start>=0&&stop>start,'Adaptive prefetch function exists');
const getMargin=new Function('ctx','with(ctx){return ('+js.slice(start,stop)+')();}');
const ctx=(memory,height)=>({navigator:{deviceMemory:memory},$:()=>({clientHeight:height})});

test('low-memory Pi prefetch remains bounded',()=>{
 assert.equal(getMargin(ctx(2,900)),'240px');
 assert.equal(getMargin(ctx(1,1800)),'240px');
});
test('desktop prefetch adapts to reader height and stays bounded',()=>{
 assert.equal(getMargin(ctx(8,600)),'480px');
 assert.equal(getMargin(ctx(8,2000)),'900px');
});
test('thumbnail browser requests small previews and offers page jump',()=>{
 assert.match(js,/img\.dataset\.src=.*width=320/);
 assert.match(js,/aria-label','Jump to thumbnail page'/);
 assert.match(js,/Math\.floor\(\(target-1\)\/60\)\*60\+1/);
});
test('progress and magazine fit remain available',()=>{
 assert.match(js,/Math\.round\(page\/documentPDF\.numPages\*100\)/);
 assert.match(js,/reader-page-slider-label.*percent\+'%'/);
 assert.match(js,/primeSpreadDimensions\(isBookSpread\(\)\?spreadPages\(page\):\[page\]\)/);
 assert.match(html,/Magazine · cover then spreads/);
});
