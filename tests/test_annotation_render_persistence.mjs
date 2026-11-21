import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
const js=readFileSync(new URL('../static/app.js',import.meta.url),'utf8');
const begin=js.indexOf('function replacePagePixels(slot,...nodes)');
const end=js.indexOf('function annotationDrawAll()',begin);
assert.ok(begin>=0&&end>begin,'Page pixel replacement helper is present');
const replace=new Function('return ('+js.slice(begin,end)+')')();

test('image refresh retains annotation overlay',()=>{
 const overlay={className:'annotation-layer'},preview={type:'preview'},sharp={type:'sharp'};
 const slot={nodes:[overlay],querySelector(selector){return selector==='.annotation-layer'?this.nodes.find(x=>x===overlay)||null:null;},replaceChildren(...nodes){this.nodes=nodes;},append(node){this.nodes.push(node);}};
 replace(slot,preview);assert.deepEqual(slot.nodes,[preview,overlay]);
 replace(slot,sharp);assert.deepEqual(slot.nodes,[sharp,overlay]);
});
test('replacement also works before an annotation layer exists',()=>{
 const slot={nodes:[],querySelector(){return null;},replaceChildren(...nodes){this.nodes=nodes;},append(node){this.nodes.push(node);}};
 replace(slot,{type:'canvas'});assert.equal(slot.nodes.length,1);
});
test('all PDF rendering paths preserve annotation layers',()=>{
 for(const target of ['img','sharp','canvas'])assert.ok(js.includes('replacePagePixels(slot,'+target+')'));
 assert.ok(js.includes("replacePagePixels(slot,el('span','page-placeholder'"));
 assert.ok(js.includes("replacePagePixels(slot,el('p','page-placeholder'"));
});
