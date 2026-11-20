// Node's built-in test runner checks zoom anchor geometry without a browser.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const js=readFileSync(new URL('../static/app.js',import.meta.url),'utf8');
const css=readFileSync(new URL('../static/style.css',import.meta.url),'utf8');
const start=js.indexOf('async function zoomWithControls(targetZoom)');
const stop=js.indexOf("\n$('minus').onclick=",start);
assert.ok(start>=0&&stop>start,'Expected the standalone button zoom function');
// Isolate the production function; provide only the browser geometry that it uses.
const createZoom=new Function('ctx','with(ctx){return ('+js.slice(start,stop)+');}');

test('zoom buttons keep the visible PDF paragraph centered horizontally and vertically',async()=>{
 const area={
  scrollLeft:0,scrollTop:250,
  getBoundingClientRect(){return {left:0,top:0,width:400,height:600};}
 };
 const slot=(width,height,left=0,top=0)=>({
  dataset:{page:'1'},
  getBoundingClientRect(){
   const x=left-area.scrollLeft,y=top-area.scrollTop;
   return {left:x,top:y,right:x+width,bottom:y+height,width,height};
  }
 });
 const compact=slot(300,1000,50),enlarged=slot(600,2000);
 let redraws=0,updates=0,saves=0;
 const doc={id:1};
 const ctx={
  documentPDF:doc,pinch:null,layoutReady:true,zoom:1,page:1,
  generation:4,slots:[compact],pinchScrollLockUntil:0,
  performance:{now:()=>1000},
  $:name=>{assert.equal(name,'page-area');return area;},
  fitEntirePageZoom:()=>0.5,
  rebuild:async()=>{redraws++;area.scrollLeft=0;area.scrollTop=0;ctx.slots=[ctx.zoom>1?enlarged:compact];},
  updatePageUI:()=>updates++,remember:()=>saves++
 };
 const zoomWithControls=createZoom(ctx);
 await zoomWithControls(2);
 assert.equal(ctx.zoom,2);
 assert.equal(area.scrollLeft,100,'Zoomed page should not jump to the left edge');
 assert.equal(area.scrollTop,800,'Current paragraph should remain at the viewport center');
 assert.equal(redraws,1);

 await zoomWithControls(1);
 assert.equal(ctx.zoom,1);
 assert.equal(area.scrollLeft,0,'Fit-width page should be centered');
 assert.equal(area.scrollTop,250,'Original vertical reading position should be restored');
 assert.equal(redraws,2);
 assert.equal(updates,2);
 assert.equal(saves,2);
});

test('double tap toggles controls but cannot zoom or modify pinch geometry',()=>{
 assert.equal(js.includes('smartDoubleTapZoom'),false);
 assert.match(js,/toggleReaderControls\(\);lastTap=null;/);
 assert.match(js,/addEventListener\('dblclick',[^\n]*toggleReaderControls\(\)/);
 assert.match(js,/function finishPinch\(cancelled=false\)/);
 assert.match(js,/addEventListener\('touchstart'/);
 assert.match(js,/addEventListener\('touchmove'/);
 assert.match(js,/addEventListener\('touchend'/);
 assert.match(css,/#page-area\.zoomed-in #pages\{min-width:100%;width:max-content\}/);
 assert.match(css,/#page-area\.zoomed-in \.pdf-slot\{margin-left:auto;margin-right:auto\}/);
});
