import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';

const source=readFileSync(new URL('../static/app.js',import.meta.url),'utf8');
const style=readFileSync(new URL('../static/style.css',import.meta.url),'utf8');
function production(start,end,returns,ctx){
 const first=source.indexOf(start),last=source.indexOf(end,first);
 assert.ok(first>=0&&last>first,'Missing production snippet '+start);
 return new Function('ctx','with(ctx){'+source.slice(first,last)+'return '+returns+';}')(ctx);
}

test('book fit is calculated from both PDF pages, gutter and padding',()=>{
 const cases=[{width:390,height:630,mobile:true},{width:1100,height:760,mobile:false}];
 for(const c of cases){
  const ctx={
   documentPDF:{numPages:12},rotation:0,
   dimensions:new Map([[1,{width:600,height:900}],[2,{width:600,height:1000}],[3,{width:680,height:1100}]]),
   isBookSpread:()=>true,spreadPages:n=>n===1?[1]:[2,3],
   $:()=>({clientWidth:c.width,clientHeight:c.height}),
   matchMedia:()=>({matches:c.mobile})
  };
  const {fitEntirePageZoom,bookPageBaseWidth}=production('function bookPageBaseWidth()','/** size Slot:', '{fitEntirePageZoom,bookPageBaseWidth}',ctx);
  const fit=fitEntirePageZoom(2),base=bookPageBaseWidth();
  assert.ok(fit>=.1&&Number.isFinite(fit));
  const gap=c.mobile?4:8,padX=c.mobile?10:32,padY=c.mobile?16:36;
  const spreadWidth=2*base*fit+gap+padX;
  const spreadHeight=Math.max(base*1000/600,base*1100/680)*fit+padY;
  assert.ok(spreadWidth<=c.width-12+.01,'Both pages fit width: '+JSON.stringify({c,spreadWidth,fit}));
  assert.ok(spreadHeight<=c.height-12+.01,'Taller book page fits height');
  assert.ok(fitEntirePageZoom(1)>=fit*.8,'Cover has independent one-page fit');
 }
});

test('zooming out to minimum resets stale horizontal pan and centers full spread',async()=>{
 const area={clientWidth:420,clientHeight:680,scrollLeft:150,scrollTop:320,
  getBoundingClientRect(){return {left:0,top:0,width:420,height:680};}};
 const bookSpread={getBoundingClientRect(){return {left:20-area.scrollLeft,top:20-area.scrollTop,width:650,height:1050};}};
 const ctx={
  documentPDF:{id:1},pinch:null,layoutReady:true,zoom:1.6,page:2,generation:4,
  isBookSpread:()=>true,spreadStart:()=>2,slots:[],pinchScrollLockUntil:0,
  $:name=>name==='page-area'?area:{querySelector:()=>bookSpread},
  performance:{now:()=>1000},fitEntirePageZoom:()=>.8,
  rebuild:async()=>{},updatePageUI:()=>{},remember:()=>{}
 };
 const zoom=production('async function zoomWithControls(targetZoom)',"$('minus').onclick=", 'zoomWithControls',ctx);
 await zoom(.5);
 assert.equal(ctx.zoom,.8);
 assert.equal(area.scrollLeft,0);
 assert.equal(area.scrollTop,0);
 await zoom(.8);
 assert.equal(area.scrollLeft,0);
 assert.match(style,/#pages\.book-layout\{[^}]*min-width:100%;[^}]*margin-inline:auto/);
 assert.match(style,/#pages\.book-layout \.book-spread\{[^}]*justify-content:center/);
});

test('one-finger paper drag folds current page and commits a whole spread turn',()=>{
 const names=new Set(),classes={add:v=>names.add(v),remove:v=>names.delete(v)};
 const sheet={style:{},classList:classes};
 let time=1000,turned=[];
 const pointers=new Set([10]);
 const ctx={prefs:{gestures:true},documentPDF:{numPages:8},layoutReady:true,
  zoom:.8,page:2,pinch:null,slots:[sheet,sheet],gesturePointers:pointers,
  gestureStart:null,lastTap:null,suppressTapUntil:0,
  isBookSpread:()=>true,isAnimatedPageMode:()=>true,fitEntirePageZoom:()=>.8,
  performance:{now:()=>time},
  $:key=>key==='page-area'?{clientWidth:400}:key==='book-turn-next'?{disabled:false}:{disabled:false},
  turnBook:(dir,fromSwipe)=>turned.push({dir,fromSwipe})
 };
 const swipe=production('let bookPaperSwipe=null;',"$('page-area').addEventListener('pointerdown'",'{beginBookPaperSwipe,previewBookPaperSwipe,endBookPaperSwipe,clearBookPaperSwipe}',ctx);
 swipe.beginBookPaperSwipe({pointerType:'touch',pointerId:10,clientX:320,clientY:200});
 swipe.previewBookPaperSwipe({pointerId:10,clientX:200,clientY:204});
 assert.ok(names.has('paper-dragging'));
 assert.match(sheet.style.transform,/rotateY\(-/);
 time=1200;
 assert.equal(swipe.endBookPaperSwipe({pointerId:10,clientX:170,clientY:204}),true);
 assert.equal(turned.length,1);
 assert.equal(turned[0].dir,1);
 assert.match(sheet.style.transform,/rotateY\(-/);
 // The released page stays folded until turnBook takes over the animation.
 assert.ok(names.has('paper-dragging'));
 // Two-finger pinch must not be captured by paper turning.
 ctx.pinch={};
 swipe.beginBookPaperSwipe({pointerType:'touch',pointerId:10,clientX:320,clientY:200});
 assert.equal(swipe.endBookPaperSwipe({pointerId:10,clientX:120,clientY:200}),false);
 assert.equal(turned.length,1);
});

test('production still uses Safari two-touch pinch and WebP image pages',()=>{
 assert.match(source,/function finishPinch\(cancelled=false\)/);
 assert.match(source,/addEventListener\('touchstart'/);
 assert.match(source,/addEventListener\('touchmove'/);
 assert.match(source,/function renderPages\(\)/);
 assert.match(source,/function openEpubBook\(item,start\)/);
 assert.match(style,/@media\(prefers-reduced-motion:reduce\)/);
});
