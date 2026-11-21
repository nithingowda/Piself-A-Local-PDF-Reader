import assert from 'node:assert/strict';
import test from 'node:test';
import {selectedPassage} from '../static/pdf-text-selection.js';

test('an exact range inside a sidebar uses its characters and its own bounds',()=>{
 const surface={
  parentElement:{dataset:{page:'6'}},
  contains:node=>node===end,
  getBoundingClientRect:()=>({left:10,top:20,width:500,height:800})
 };
 const item=index=>({parentElement:{dataset:{item:String(index)},closest:()=>surface}});
 const start=item(70),end=item(71);
 const range={startContainer:start,endContainer:end,startOffset:4,endOffset:9,
  toString:()=> 'The debate over how to reverse',
  getClientRects:()=>[{left:35,top:620,width:200,height:16}]};
 const selection={rangeCount:1,isCollapsed:false,getRangeAt:()=>range};
 const passage=selectedPassage(selection);
 assert.equal(passage.text,range.toString());
 assert.equal(passage.key,'6:70:4:71:9');
 assert.deepEqual(passage.boxes,[{x:.05,y:.75,w:.4,h:.02}]);
 range.endContainer=item(100);
 assert.equal(selectedPassage(selection),null);
});
