import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';

const source=readFileSync(new URL('../static/app.js',import.meta.url),'utf8');
const geometryStart=source.indexOf('async function primeSpreadDimensions(');
const geometryEnd=source.indexOf('/** size Slot:',geometryStart);
assert.ok(geometryStart>=0&&geometryEnd>geometryStart);
const makeGeometry=new Function('ctx','with(ctx){'+source.slice(geometryStart,geometryEnd)+'return primeSpreadDimensions;}');
const turnStart=source.indexOf('const PAPER_TURN_DURATION_MS=');
const turnEnd=source.indexOf('/** close Reader:',turnStart);
assert.ok(turnStart>=0&&turnEnd>turnStart);
const makeTurn=new Function('ctx','with(ctx){'+source.slice(turnStart,turnEnd)+'return turnBook;}');

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

test('two-page paper turn only animates after both incoming sizes are prepared',async()=>{
 let primeResolve,finishAnimation;
 const events=[];
 const doc={numPages:12};
 const sheet={style:{},classList:{add(){},remove(){}},
  animate(){
   events.push('animate');
   return {finished:new Promise(resolve=>finishAnimation=resolve),cancel(){}};
  }
 };
 const ctx={
  documentPDF:doc,page:2,generation:10,slots:[sheet,sheet],
  prefs:{motion:true},current:null,
  imagePrefetches:new Map([4,5].map(n=>[n,{ready:true}])),
  isBookSpread:()=>true,isAnimatedPageMode:()=>true,
  spreadStart:n=>n<=1?1:2+2*Math.floor((n-2)/2),
  spreadPages:n=>n===1?[1]:[n,n+1],
  primeSpreadDimensions:pages=>{
   events.push('geometry-'+pages.join('-'));
   return new Promise(resolve=>primeResolve=resolve);
  },
  matchMedia:()=>({matches:false}),
  $:()=>({value:'book'}),
  move:(target,direction)=>events.push('move-'+target+'-'+direction)
 };
 const turn=makeTurn(ctx);
 const pending=turn(1);
 assert.deepEqual(events,['geometry-4-5']);
 assert.equal(typeof finishAnimation,'undefined','must not flip before PDF sizes are known');
 primeResolve();
 await Promise.resolve();await Promise.resolve();
 assert.deepEqual(events,['geometry-4-5','animate']);
 finishAnimation();
 await pending;
 assert.deepEqual(events,['geometry-4-5','animate','move-4-1']);
});

test('do not animate the incoming spread again after the leaf flips',()=>{
 const start=source.indexOf('function move(n,turn=0)');
 const end=source.indexOf('const PAPER_TURN_DURATION_MS=',start);
 assert.ok(start>=0&&end>start);
 const move=source.slice(start,end);
 assert.doesNotMatch(move,/classList\.add\(turn>0\?'turn-forward':'turn-backward'/);
 assert.match(move,/if\(wasAtFit\)zoom=fitEntirePageZoom\(page\)/);
 assert.match(source,/if\(isBookSpread\(\)\)await primeSpreadDimensions\(spreadPages\(page\),doc,g\)/);
 assert.match(source,/function finishPinch\(cancelled=false\)/);
});
