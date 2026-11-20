import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';

const source=readFileSync(new URL('../static/app.js',import.meta.url),'utf8');
const css=readFileSync(new URL('../static/style.css',import.meta.url),'utf8');
const start=source.indexOf('const PAPER_TURN_DURATION_MS=');
const end=source.indexOf('/** close Reader:',start);
assert.ok(start>=0&&end>start,'Expected production single-page paper animation');

function fixture({mode='single',motion=true,reduced=false,page=2}={}){
 const events=[],classes=new Set();
 let finishAnimation=()=>{};
 const underlays=[];
 const root={
  getBoundingClientRect(){return {left:0,top:0};},
  append(item){underlays.push(item);events.push({type:'underlay',item});}
 };
 const sheet={
  isConnected:true,
  classList:{add:c=>classes.add(c),remove:(...cs)=>cs.forEach(c=>classes.delete(c))},
  style:{},
  getBoundingClientRect(){return {left:30,top:60,width:360,height:500};},
  animate(frames,options){
   events.push({type:'animate',frames,options});
   return {
    finished:new Promise(resolve=>{finishAnimation=resolve;}),
    cancel(){events.push({type:'cancel'});}
   };
  }
 };
 const document={createElement:()=>({alt:'',decoding:'',src:''})};
 const el=(tag,name)=>{
  const elem={tag,name,style:{},children:[],attributes:{},
   setAttribute(k,v){this.attributes[k]=v;},
   append(child){this.children.push(child);},
   remove(){this.removed=true;events.push({type:'underlay-removed'});}
  };
  return elem;
 };
 const ctx={
  documentPDF:{numPages:7},current:{id:'bookid123'},
  page,generation:4,slots:[sheet,sheet],
  prefs:{motion},isBookSpread:()=>mode==='book',
  isAnimatedPageMode:()=>mode!=='scroll',
  spreadStart:n=>n===1?1:2+2*Math.floor((Math.min(7,n)-2)/2),
  matchMedia:()=>({matches:reduced}),
  $:name=>name==='pages'?root:{value:mode},
  el,document,encodeURIComponent,
  move:(target,direction)=>{events.push({type:'move',target,direction});ctx.page=target;}
 };
 const factory=new Function('ctx','with(ctx){'+source.slice(start,end)+'return {turnBook,cancelPageTurn};}');
 return {...factory(ctx),events,classes,sheet,underlays,ctx,finish:()=>finishAnimation()};
}

test('single page turns slowly with 7-stage physical paper movement and next-page preview',async()=>{
 const f=fixture();
 const turning=f.turnBook(1);
 assert.equal(f.events[0].type,'underlay');
 assert.equal(f.events[1].type,'animate');
 const underlay=f.underlays[0];
 assert.equal(underlay.children[0].src,'/api/page-image/bookid123/3?width=960');
 assert.equal(underlay.attributes['aria-hidden'],'true');
 const {frames,options}=f.events[1];
 assert.equal(frames.length,7);
 assert.ok(options.duration>=1000,'The turn should take reading time, not 350ms');
 assert.equal(frames.at(-1).transform.includes('-178deg'),true);
 assert.equal(frames[3].offset,.53);
 assert.ok(f.classes.has('paper-turning'));
 assert.equal(f.events.filter(x=>x.type==='move').length,0,'Do not switch page before turn finishes');
 f.finish();await turning;
 assert.deepEqual(f.events.filter(x=>x.type==='move'),[{type:'move',target:3,direction:1}]);
 assert.equal(underlay.removed,true);
 assert.equal(f.classes.has('paper-turning'),false);
});

test('reverse single-page turn moves to previous page and hinges from the right',async()=>{
 const f=fixture({page:4});
 const turning=f.turnBook(-1);
 assert.equal(f.sheet.style.transformOrigin,'right center');
 assert.match(f.events.find(x=>x.type==='animate').frames.at(-1).transform,/178deg/);
 assert.equal(f.underlays[0].children[0].src,'/api/page-image/bookid123/3?width=960');
 f.finish();await turning;
 assert.equal(f.ctx.page,3);
});

test('continuous mode remains unanimated, and reduced motion bypasses page turn',async()=>{
 const continuous=fixture({mode:'scroll'});
 await continuous.turnBook(1);
 assert.equal(continuous.events[0].type,'move');
 assert.equal(continuous.underlays.length,0);
 const reduced=fixture({mode:'single',reduced:true});
 await reduced.turnBook(-1);
 assert.equal(reduced.events[0].type,'move');
 assert.equal(reduced.underlays.length,0);
});

test('canceling single-page turn removes the underlay and never navigates',async()=>{
 const f=fixture();
 const pending=f.turnBook(1);
 f.cancelPageTurn();
 f.finish();await pending;
 assert.equal(f.events.filter(x=>x.type==='move').length,0);
 assert.equal(f.underlays[0].removed,true);
});

test('paper features and touch gestures remain isolated',()=>{
 assert.match(source,/const PAPER_TURN_DURATION_MS=1050/);
 assert.match(source,/function isAnimatedPageMode\(\)/);
 assert.match(source,/function prepareSinglePageUnderlay\(sheet,target\)/);
 assert.match(source,/function beginBookPaperSwipe\(e\)/);
 assert.match(source,/function finishPinch\(cancelled=false\)/);
 assert.match(source,/addEventListener\('touchmove'/);
 assert.match(source,/function renderPages\(\)/);
 assert.match(css,/#pages \.paper-turn-underlay/);
 assert.match(css,/#pages \.pdf-slot\.paper-turning::after/);
});
