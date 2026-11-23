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
 const zoom=production('async function zoomWithControls(targetZoom,tap)',"$('minus').onclick=", 'zoomWithControls',ctx);
 await zoom(.5);
 assert.equal(ctx.zoom,.8);
 assert.equal(area.scrollLeft,0);
 assert.equal(area.scrollTop,0);
 await zoom(.8);
 assert.equal(area.scrollLeft,0);
 assert.match(style,/#pages\.book-layout\{[^}]*min-width:100%;[^}]*margin-inline:auto/);
 assert.match(style,/#pages\.book-layout \.book-spread\{[^}]*justify-content:center/);
});

test('one-finger touch navigation tracks the fold and retains fallback navigation',()=>{
 const gestureStart=source.indexOf("$('page-area').addEventListener('pointerdown'");
 const gestureEnd=source.indexOf("$('page-area').addEventListener('dblclick'",gestureStart);
 assert.ok(gestureStart>0&&gestureEnd>gestureStart);
 const pointerHandlers=source.slice(gestureStart,gestureEnd);
 assert.match(pointerHandlers,/turnFromControl\(dx<0\?1:-1\)/);
 assert.match(pointerHandlers,/gesturePointers\.size===1/);
 assert.match(pointerHandlers,/gestureStart\.multi/);
 assert.match(pointerHandlers,/pointermove/);
 assert.match(pointerHandlers,/settleCurl\(curl.progress/);
 assert.match(source,/function finishPinch\(cancelled=false\)/);
});

test('a cold preview cache still animates both directions before navigating',()=>{
 for(const book of [true,false])for(const direction of [-1,1]){
  let frame,turns=0,frontDraws=0;
  const front={width:200,height:300};
  const slots=[4,5].map((n,i)=>({
   dataset:{page:String(n)},isConnected:true,querySelector:()=>front,
   getBoundingClientRect:()=>({left:i*200,right:(i+1)*200,top:0,bottom:300,width:200,height:300})
  }));
  const drawing=new Proxy({}, {get:(_,name)=>{
   if(name==='drawImage')return image=>{assert.equal(image,front);frontDraws++;};
   if(name==='createLinearGradient')return ()=>({addColorStop(){}});
   return ()=>{};
  }});
  const canvas={style:{},setAttribute(){},remove(){},getContext:()=>drawing};
  const ctx={
   page:4,documentPDF:{numPages:8},rotation:0,layoutEpoch:1,slots,
   isBookSpread:()=>book,spreadPages:n=>[n,n+1],imagePrefetches:new Map(),
   $:()=>({value:book?'book':'single',append(){},getBoundingClientRect:()=>({bottom:300})}),
   matchMedia:()=>({matches:false}),document:{createElement:()=>canvas},devicePixelRatio:1,
   getComputedStyle:()=>({filter:'none'}),performance:{now:()=>0},
   requestAnimationFrame:callback=>{frame=callback;return 1;},cancelAnimationFrame(){},
   turnBook:d=>{assert.equal(d,direction);turns++;}
  };
  const turn=production('let curl=null;',"$('page-area').addEventListener('pointerdown'",'turnFromControl',ctx);
  turn(direction);
  assert.ok(frontDraws>0);
  frame(150);
  assert.equal(turns,0);
  frame(500);
  assert.equal(turns,1);
 }
});

test('automatic PDF fit follows portrait touch width or desktop height',()=>{
 for(const book of [false,true])for(const portrait of [false,true]){
  const area=portrait?{clientWidth:390,clientHeight:500}:{clientWidth:1200,clientHeight:740};
  const ctx={rotation:0,dimensions:new Map([[1,{width:600,height:1000}]]),
   isBookSpread:()=>book,spreadPages:()=>[1,2],$:()=>area,
   matchMedia:()=>({matches:portrait})};
  const fit=production('function bookPageBaseWidth()','/** size Slot:', 'deviceFitZoom',ctx);
  const before=fit(1);
  area.clientHeight-=100;
  if(portrait)assert.equal(fit(1),before);
  else assert.ok(fit(1)<before);
 }
});
