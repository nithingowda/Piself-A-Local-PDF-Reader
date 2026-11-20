import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';

const src=readFileSync(new URL('../static/app.js',import.meta.url),'utf8');
const start=src.indexOf('function spreadStart(n)');
const end=src.indexOf('function pageWidth()',start);
assert.ok(start>=0&&end>start);
const definitions=src.slice(start,end);
const build=new Function('context','with(context){'+definitions+'return {spreadStart,spreadPages};}');
const navStart=src.indexOf('async function turnBook(direction,fromSwipe=null)');
const navEnd=src.indexOf('/** close Reader:',navStart);
assert.ok(navStart>=0&&navEnd>navStart);
const buildNavigator=new Function('context','with(context){'+src.slice(navStart,navEnd)+'return turnBook;}');

test('book spread uses page 1 as a cover, then 2-3, 4-5 with odd total',()=>{
 const ctx={documentPDF:{numPages:7}};
 const {spreadStart,spreadPages}=build(ctx);
 assert.deepEqual([1,2,3,4,5,6,7].map(spreadStart),[1,2,2,4,4,6,6]);
 assert.deepEqual(spreadPages(1),[1]);
 assert.deepEqual(spreadPages(2),[2,3]);
 assert.deepEqual(spreadPages(3),[2,3]);
 assert.deepEqual(spreadPages(6),[6,7]);
 assert.deepEqual(spreadPages(999),[6,7]);
});

test('even page count leaves last spread a single right-hand page',()=>{
 const ctx={documentPDF:{numPages:6}};
 const {spreadPages}=build(ctx);
 assert.deepEqual(spreadPages(6),[6]);
 assert.deepEqual(spreadPages(5),[4,5]);
});

test('turn controls navigate one spread and respect cover and endpoints',()=>{
 const ctx={documentPDF:{numPages:7},page:1,moves:[],activePageTurn:null,isBookSpread:()=>true,slots:[]};
 const helpers=build(ctx);ctx.spreadStart=helpers.spreadStart;
 ctx.move=(target,direction)=>{const next=helpers.spreadStart(target);ctx.moves.push([next,direction]);ctx.page=next;};
 const turn=buildNavigator(ctx);
 turn(1);turn(1);turn(-1);turn(-1);
 assert.deepEqual(ctx.moves,[[2,1],[4,1],[2,-1],[1,-1]]);
 ctx.page=6;turn(1);assert.equal(ctx.page,6);
});

test('legacy single and continuous readers and pinch handler remain in source',()=>{
 assert.match(src,/mode==='single'\?page:1/);
 assert.match(src,/function finishPinch\(cancelled=false\)/);
 assert.match(src,/function renderPages\(\)/);
 assert.match(src,/function zoomWithControls\(targetZoom\)/);
});
