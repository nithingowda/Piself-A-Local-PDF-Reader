import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';

const js=readFileSync(new URL('../static/app.js',import.meta.url),'utf8');
const srcStart=js.indexOf('let imagePrefetches=new Map();');
const srcEnd=js.indexOf('function trimCanvases()',srcStart);
assert.ok(srcStart>=0&&srcEnd>srcStart);
const productionCache=new Function('ctx','with(ctx){'+js.slice(srcStart,srcEnd)+
 'return {ensureDecodedPreview,takeDecodedPreview,discardDecodedPreview,preloadMagazineNeighbors,neighborPreviewPages,clearMagazinePrefetches,imagePrefetches};}');

class FakeImage{
 static created=[];
 constructor(){this._src='';this.naturalWidth=0;this.naturalHeight=0;FakeImage.created.push(this);}
 set src(value){this._src=value;}
 get src(){return this._src;}
 decode(){return new Promise(resolve=>{this.finishDecode=resolve;});}
 startDecode(){
  this.naturalWidth=960;this.naturalHeight=1280;
  void this.onload?.();
 }
 completeDecode(){this.finishDecode?.();}
 cloneNode(){return {src:this.src,alt:''};}
}

function makeCache({book=false,page=2,count=8}={}){
 FakeImage.created=[];
 const ctx={
  documentPDF:{numPages:count},current:{id:'the-book'},page,slots:[],Image:FakeImage,encodeURIComponent,
  isBookSpread:()=>book,
  spreadStart:n=>n<=1?1:2+2*Math.floor((n-2)/2),
  spreadPages:n=>n===1?[1]:[n,n+1].filter(x=>x<=count)
 };
 return {...productionCache(ctx),ctx};
}

test('WebP preview is available only after image load AND decode and transferred without reloading',async()=>{
 const c=makeCache();
 const waiting=c.ensureDecodedPreview(3);
 const original=FakeImage.created[0];
 assert.match(original.src,/\/api\/page-image\/the-book\/3\?width=960/);
 assert.equal(c.imagePrefetches.get(3).ready,false);
 original.startDecode();
 await Promise.resolve();
 assert.equal(c.imagePrefetches.get(3).ready,false,'loaded but not decoded');
 original.completeDecode();
 assert.equal(await waiting,true);
 assert.equal(c.imagePrefetches.get(3).ready,true);
 assert.strictEqual(c.takeDecodedPreview(3),original);
 assert.equal(c.imagePrefetches.has(3),false,'transferred image is not evicted');
 assert.equal(original.src,'/api/page-image/the-book/3?width=960');
});

test('two-page book mode warms both upcoming pages and prior spread with bounded cache',async()=>{
 const c=makeCache({book:true,page:2});
 assert.deepEqual(c.neighborPreviewPages(),[1,4,5]);
 c.preloadMagazineNeighbors();
 assert.deepEqual([...c.imagePrefetches.keys()].sort(),[1,4,5]);
 assert.ok(c.imagePrefetches.size<=4);
 c.ctx.page=4;
 c.ctx.slots=[{dataset:{page:'4',ready:'yes'}},{dataset:{page:'5',ready:'yes'}}];
 c.preloadMagazineNeighbors();
 assert.deepEqual([...c.imagePrefetches.keys()].sort(),[2,3,6,7]);
 assert.ok(c.imagePrefetches.size<=4);
 c.clearMagazinePrefetches();
 assert.equal(c.imagePrefetches.size,0);
});

test('decoded second book page survives after first page renders, then releases after use',()=>{
 const c=makeCache({book:true,page:4});
 const image=new FakeImage();image.src='/api/page-image/the-book/5?width=960';
 const entry={img:image,id:'the-book',ready:true,cancelled:false,transferred:false,finish:()=>{},promise:Promise.resolve(true)};
 c.imagePrefetches.set(5,entry);
 const left={dataset:{page:'4',ready:'yes'}};
 const right={dataset:{page:'5',ready:'no'}};
 c.ctx.slots=[left,right];
 c.preloadMagazineNeighbors();
 assert.strictEqual(c.imagePrefetches.get(5),entry,'decoded right-hand page must not be discarded early');
 assert.strictEqual(c.takeDecodedPreview(5),image);
 assert.equal(image.src,'/api/page-image/the-book/5?width=960');
 c.preloadMagazineNeighbors();
 assert.equal(c.imagePrefetches.has(5),false,'cache entry transferred to visible page');
 c.clearMagazinePrefetches();
 assert.equal(image.src,'/api/page-image/the-book/5?width=960','visible image must survive cache cleanup');
});

test('canceling a pending decoded preview immediately resolves its wait',async()=>{
 const c=makeCache();
 const waiting=c.ensureDecodedPreview(3);
 const old=FakeImage.created[0];
 c.clearMagazinePrefetches();
 assert.equal(await waiting,false);
 assert.equal(old.src,'');
});

test('animation waits until both next spread pages have decoded, then shows predecoded underlay',async()=>{
 const start=js.indexOf('const PAPER_TURN_DURATION_MS=');
 const end=js.indexOf('/** close Reader:',start);
 assert.ok(start>=0&&end>start);
 let completeAnimation=()=>{};
 const calls=[],status={textContent:''};
 const sheet={isConnected:true,style:{},
  classList:{add(){},remove(){}},
  getBoundingClientRect:()=>({left:20,top:20,width:160,height:240}),
  animate(frames,options){
   calls.push({kind:'animate',frames,options});
   return {finished:new Promise(resolve=>completeAnimation=resolve),cancel(){}};
  }
 };
 const root={getBoundingClientRect:()=>({left:0,top:0}),append(node){calls.push({kind:'underlay',node});}};
 const generated=new Map(),previews=new Map(),toResolve=new Map();
 const ctx={
  documentPDF:{numPages:8},current:{id:'the-book'},page:2,generation:3,
  slots:[sheet,sheet],prefs:{motion:true},
  isAnimatedPageMode:()=>true,isBookSpread:()=>true,
  spreadStart:n=>n===1?1:2+2*Math.floor((n-2)/2),
  spreadPages:n=>n===1?[1]:[n,n+1].filter(x=>x<=8),
  matchMedia:()=>({matches:false}),imagePrefetches:previews,
  ensureDecodedPreview(n){return new Promise(resolve=>toResolve.set(n,resolve));},
  $:name=>name==='pages'?root:name==='reader-status'?status:{value:'book'},
  el:(tag,kind)=>({
   kind,style:{},classList:{add(){}},setAttribute(){},append(img){this.image=img;},
   remove(){calls.push({kind:'remove'});}
  }),
  move:(n,direction)=>calls.push({kind:'move',n,direction}),
  encodeURIComponent
 };
 const create=new Function('ctx','with(ctx){'+js.slice(start,end)+'return {turnBook,cancelPageTurn};}');
 const turn=create(ctx);
 const inProgress=turn.turnBook(1);
 assert.equal(status.textContent,'Preparing next page…');
 assert.equal(calls.some(x=>x.kind==='animate'),false);
 assert.deepEqual([...toResolve.keys()].sort(),[4,5]);
 previews.set(4,{id:'the-book',ready:true,img:{src:'page4.webp',cloneNode(){return {src:this.src};}}});
 toResolve.get(4)(true);
 await Promise.resolve();
 assert.equal(calls.some(x=>x.kind==='animate'),false,'both PDF pages must decode');
 previews.set(5,{id:'the-book',ready:true,img:{src:'page5.webp',cloneNode(){return {src:this.src};}}});
 toResolve.get(5)(true);
 await Promise.resolve();await Promise.resolve();await Promise.resolve();
 assert.equal(status.textContent,'');
 assert.equal(calls[0].kind,'underlay');
 assert.equal(calls[0].node.image.src,'page5.webp','right-hand leaf reveals already decoded next right page');
 assert.equal(calls[1].kind,'animate');
 assert.equal(calls.some(x=>x.kind==='move'),false,'new spread is not requested mid-turn');
 completeAnimation();
 await inProgress;
 assert.deepEqual(calls.filter(x=>x.kind==='move').map(x=>x.n),[4]);
});

test('renderPages uses the decoded image directly and avoids a second onload wait',()=>{
 assert.match(js,/const prefetched=takeDecodedPreview\(n\);/);
 assert.match(js,/const img=prefetched\|\|document\.createElement\('img'\);/);
 assert.match(js,/if\(!prefetched\)\{\s*await new Promise\(/);
 assert.match(js,/\/api\/page-image\/.*\?width=960/);
 assert.match(js,/function finishPinch\(cancelled=false\)/);
});
