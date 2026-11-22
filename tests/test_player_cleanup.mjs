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
 assert.deepEqual(calls,['reset pdf','clear pdf','range']);
 assert.equal(action.hidden,true);
 assert.equal($('pdf-speech-player').hidden,true);
});

test('finishing a selection lets the open PDF or EPUB player accept a fresh queue',()=>{
 const source=js.slice(js.indexOf('function speechState('),js.indexOf('// One-shot starting positions'));
 for(const kind of ['pdf','epub']){
  const controls=new Map(),picks={[kind]:true},playing={[kind]:true},queue=['first'];
  const $=id=>{
   if(!controls.has(id))controls.set(id,{hidden:false,setAttribute(){}});
   return controls.get(id);
  };
  const notify=new Function('$','numberedPlayback','numberedPickMode','clearSpeechHighlight','resetNumberedParagraphs',source+'return speechState;')(
   $,playing,picks,()=>{},()=>{queue.length=0;playing[kind]=false;picks[kind]=false;});
  notify(kind,{active:false,paused:false});
  assert.equal(picks[kind],true);
  assert.deepEqual(queue,[]);
  assert.equal($(kind+'-remaining').hidden,true);
 }
});
