import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';

const js=readFileSync(new URL('../static/app.js',import.meta.url),'utf8');
const css=readFileSync(new URL('../static/style.css',import.meta.url),'utf8');
const start=js.indexOf('let activePageTurn=null;');
const end=js.indexOf('/** close Reader:',start);
assert.ok(start>=0&&end>start,'Expected page-turn animation implementation');

function fixture({motion=true,reduced=false}={}){
 let resolveFinished;
 const events=[],classes=new Set();
 const sheet={
  classList:{add:x=>classes.add(x),remove:(...xs)=>xs.forEach(x=>classes.delete(x))},
  style:{},
  animate(frames,options){
   events.push({type:'animate',frames,options});
   return {
    finished:new Promise(resolve=>{resolveFinished=resolve;}),
    cancel(){events.push({type:'cancel'});}
   };
  }
 };
 const doc={numPages:8};
 const ctx={
  documentPDF:doc,
  page:2,
  generation:7,
  slots:[sheet,sheet],
  prefs:{motion},
  isBookSpread:()=>true,
  isAnimatedPageMode:()=>true,
  current:null,
  spreadStart:n=>n===1?1:2+2*Math.floor((Math.min(8,n)-2)/2),
  matchMedia:()=>({matches:reduced}),
  move:(page,direction)=>events.push({type:'move',page,direction})
 };
 const make=new Function('ctx','with(ctx){'+js.slice(start,end)+'return {turnBook,cancelPageTurn};}');
 return {...make(ctx),events,classes,sheet,ctx,finish:()=>resolveFinished?.()};
}

test('button page turn finishes paper fold before loading next two-page spread',async()=>{
 const f=fixture();
 const pending=f.turnBook(1);
 assert.equal(f.events[0].type,'animate');
 assert.equal(f.events[0].options.fill,'forwards');
 assert.equal(f.events.some(e=>e.type==='move'),false,'must not swap PDF pages mid animation');
 assert.equal(f.events[0].frames.at(-1).transform.includes('-175deg'),true);
 assert.ok(f.classes.has('paper-turning'));
 f.finish();await pending;
 assert.ok(!f.classes.has('paper-turning'));
 assert.deepEqual(f.events.filter(e=>e.type==='move'),[{type:'move',page:4,direction:1}]);
});

test('swipe release continues from dragged paper angle without snapping back',async()=>{
 const f=fixture();
 f.sheet.style.transform='perspective(1000px) rotateY(-65deg)';
 const p=f.turnBook(1,{sheet:f.sheet,degrees:-65});
 assert.equal(f.events[0].frames[0].transform.includes('-65deg'),true);
 assert.equal(f.events[0].frames.at(-1).transform.includes('-175deg'),true);
 f.finish();await p;
 assert.deepEqual(f.events.filter(e=>e.type==='move').map(e=>e.page),[4]);
});

test('reduced-motion preference avoids all page flip animations',async()=>{
 const f=fixture({reduced:true});
 await f.turnBook(-1);
 assert.equal(f.events.some(e=>e.type==='animate'),false);
 assert.deepEqual(f.events.filter(e=>e.type==='move'),[{type:'move',page:1,direction:-1}]);
});

test('canceled animation does not navigate to a new spread',async()=>{
 const f=fixture();
 const pending=f.turnBook(1);
 f.cancelPageTurn();
 f.finish();await pending;
 assert.ok(!f.events.some(e=>e.type==='move'));
 assert.ok(!f.classes.has('paper-turning'));
});

test('page back uses shaded CSS and Safari pinch gesture remains intact',()=>{
 assert.match(css,/\.pdf-slot\.paper-turning::after/);
 assert.match(css,/transform:rotateY\(180deg\)/);
 assert.match(js,/cancelPageTurn\(\);clearBookPaperSwipe\(\)/);
 assert.match(js,/function finishPinch\(cancelled=false\)/);
 assert.match(js,/addEventListener\('touchmove'/);
 assert.match(js,/function renderPages\(\)/);
});
