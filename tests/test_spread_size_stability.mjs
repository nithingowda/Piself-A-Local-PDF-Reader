import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';

const source=readFileSync(new URL('../static/app.js',import.meta.url),'utf8');
const geometryStart=source.indexOf('async function primeSpreadDimensions(');
const geometryEnd=source.indexOf('/** size Slot:',geometryStart);
assert.ok(geometryStart>=0&&geometryEnd>geometryStart);
const makeGeometry=new Function('ctx','with(ctx){'+source.slice(geometryStart,geometryEnd)+'return primeSpreadDimensions;}');
test('read dimensions of both target pages and cache actual aspect ratios before layout',async()=>{
 const dimensions=new Map([[1,{width:500,height:700}]]);
 const requests=[];
 const pdf={
  getPage:async n=>{
   requests.push(n);
   return {getViewport:()=>n===2?{width:600,height:1000}:{width:750,height:800}};
  }
 };
 const prime=makeGeometry({dimensions,documentPDF:pdf,generation:2});
 await prime([2,3],pdf,2);
 assert.deepEqual(requests,[2,3]);
 assert.deepEqual(dimensions.get(2),{width:600,height:1000});
 assert.deepEqual(dimensions.get(3),{width:750,height:800});
 await prime([2,3],pdf,2);
 assert.deepEqual(requests,[2,3],'real dimensions should only be fetched once');
});

test('stale geometry for a closed document is never committed',async()=>{
 const dimensions=new Map();
 let release;
 const oldDoc={getPage:()=>new Promise(resolve=>release=resolve)};
 const prime=makeGeometry({dimensions,documentPDF:oldDoc,generation:4});
 const pending=prime([7],oldDoc,3);
 release({getViewport:()=>({width:600,height:900})});
 await pending;
 assert.equal(dimensions.has(7),false);
});

test('book spread navigates without a secondary animation',()=>{
 const start=source.indexOf('function move(n)');
 const end=source.indexOf('/** close Reader:',start);
 assert.ok(start>=0&&end>start);
 const navigation=source.slice(start,end);
 assert.doesNotMatch(navigation,/animate\(|paper-turn|paper-dragging|turn-forward|turn-backward/);
 assert.match(navigation,/if\(page===oldPage\)return;\s+automaticFit='auto';[\s\S]*?rebuild\(\)/);
 assert.match(source,/if\(isBookSpread\(\)\)await primeSpreadDimensions\(spreadPages\(page\),doc,g\)/);
 assert.match(source,/function finishPinch\(cancelled=false\)/);
});

test('one failed page lookup leaves the other spread dimensions usable',async()=>{
 const dimensions=new Map();
 const doc={getPage:async n=>{
  if(n===2)throw new Error('Page temporarily unavailable');
  return {getViewport:()=>({width:610,height:810})};
 }};
 await makeGeometry({dimensions,documentPDF:doc,generation:2})([2,3],doc,2);
 assert.deepEqual(dimensions.get(3),{width:610,height:810});
 assert.equal(dimensions.has(2),false);
});
