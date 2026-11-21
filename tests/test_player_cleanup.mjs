import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
const js=readFileSync(new URL('../static/app.js',import.meta.url),'utf8');
const player=js.slice(js.indexOf('function speechPlayer('),js.indexOf('// Optional numbered paragraph'));
test('closing the PDF player clears pending picks and the native text range',()=>{
 const calls=[];
 const elements=new Map();
 function $(id){
  if(!elements.has(id))elements.set(id,{classList:{toggle(){}},setAttribute(){},contains:()=>true});
  return elements.get(id);
 }
 const action={hidden:false};
 const window={getSelection:()=>({anchorNode:{},removeAllRanges:()=>calls.push('range')})};
 const run=new Function('$','window','resetNumberedParagraphs','clearSpeechHighlight','rangeAction',player+"speechPlayer('pdf',false);");
 run($,window,kind=>calls.push('reset '+kind),kind=>calls.push('clear '+kind),action);
 assert.deepEqual(calls,['reset pdf','range']);
 assert.equal(action.hidden,true);
 assert.equal($('pdf-speech-player').hidden,true);
});
