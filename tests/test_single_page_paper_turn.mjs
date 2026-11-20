import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';

const js=readFileSync(new URL('../static/app.js',import.meta.url),'utf8');
const start=js.indexOf('const PAPER_TURN_DURATION_MS=');
const end=js.indexOf('/** close Reader:',start);
assert.ok(start>=0&&end>start,'Expected production page-turn implementation');
const create=new Function('ctx','with(ctx){'+js.slice(start,end)+'return {turnBook,isAnimatedPageMode};}');

function fixture(mode='single'){
 const events=[];
 const sheet={style:{},animate(){events.push('animate');throw Error('Unexpected paper animation');}};
 const ctx={
  page:2,
  documentPDF:{numPages:10},
  slots:[sheet,sheet],
  isBookSpread:()=>mode==='book',
  $:name=>({value:mode}),
  move:(n,direction)=>events.push({kind:'move',page:n,direction})
 };
 return {...create(ctx),events,ctx};
}

test('Single Page next and previous change exactly one page with no folding or animation',async()=>{
 const f=fixture('single');
 assert.equal(f.isAnimatedPageMode(),false);
 await f.turnBook(1);
 await f.turnBook(-1);
 assert.deepEqual(f.events,[
  {kind:'move',page:3,direction:undefined},
  {kind:'move',page:1,direction:undefined}
 ]);
 assert.equal(f.events.includes('animate'),false);
});

test('Continuous Scroll mode also remains unanimated',async()=>{
 const f=fixture('scroll');
 assert.equal(f.isAnimatedPageMode(),false);
 await f.turnBook(1);
 assert.deepEqual(f.events,[{kind:'move',page:3,direction:undefined}]);
});

test('Two-page Book retains the slow paper animation and predecoded next pages',()=>{
 const f=fixture('book');
 assert.equal(f.isAnimatedPageMode(),true);
 assert.match(js,/const PAPER_TURN_DURATION_MS=1050/);
 assert.match(js,/await Promise\.all\(incoming\.map\(ensureDecodedPreview\)\)/);
 assert.match(js,/turn\.underlay=prepareBookPageUnderlay\(sheet,target,direction\);/);
 assert.doesNotMatch(js,/prepareSinglePageUnderlay/);
});

test('Single Page does not activate the fold-on-drag gesture; pinch zoom is preserved',()=>{
 const first=js.indexOf('let bookPaperSwipe=null;');
 const last=js.indexOf("$('page-area').addEventListener('pointerdown'",first);
 assert.ok(first>=0&&last>first);
 const gesture=new Function('ctx','with(ctx){'+js.slice(first,last)+'return {beginBookPaperSwipe,previewBookPaperSwipe,endBookPaperSwipe};}');
 const ctx={
  prefs:{gestures:true},documentPDF:{numPages:8},
  isAnimatedPageMode:()=>false,pinch:null,layoutReady:true,
  gesturePointers:new Set([5]),zoom:1,fitEntirePageZoom:()=>.75,
  page:2
 };
 const swipe=gesture(ctx);
 const down={pointerType:'touch',pointerId:5,clientX:200,clientY:120};
 swipe.beginBookPaperSwipe(down);
 assert.equal(swipe.endBookPaperSwipe({...down,clientX:90}),false);
 assert.match(js,/function finishPinch\(cancelled=false\)/);
 assert.match(js,/addEventListener\('touchmove'/);
});
