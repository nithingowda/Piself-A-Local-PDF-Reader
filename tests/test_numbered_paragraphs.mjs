import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {numberedPdfParagraphs,paragraphAtPoint,reorderParagraphs} from '../static/paragraph-queue.js';

const root=new URL('../static/',import.meta.url);
const app=readFileSync(new URL('app.js',root),'utf8');
const html=readFileSync(new URL('index.html',root),'utf8');
const epub=readFileSync(new URL('epub-reader.js',root),'utf8');
const css=readFileSync(new URL('style.css',root),'utf8');
const viewport={width:600,height:800,convertToViewportPoint:(x,y)=>[x,y]};
const line=(str,x,y,id)=>({
 str,transform:[1,0,0,1,x,y],width:165,height:12,boxHeight:12,boxWidth:165,
 readingColumn:0,readingRegion:0,sourceIndex:id
});

test('PDF paragraphs are grouped top-to-bottom from actual PDF text',()=>{
 const paragraphs=numberedPdfParagraphs([
  line('First sentence of paragraph one.',25,110,0),
  line('The same paragraph continues.',25,125,1),
  line('Second paragraph starts here.',25,175,2),
  line('Third paragraph starts here.',25,235,3)
 ],viewport);
 assert.deepEqual(paragraphs.map(p=>p.text),[
  'First sentence of paragraph one. The same paragraph continues.',
  'Second paragraph starts here.',
  'Third paragraph starts here.'
 ]);
 assert.equal(paragraphAtPoint(paragraphs,30,120,viewport)?.text,paragraphs[0].text);
 assert.equal(paragraphAtPoint(paragraphs,40,180,viewport)?.text,paragraphs[1].text);
 assert.equal(paragraphAtPoint(paragraphs,250,400,viewport),null);
 assert.deepEqual(paragraphs[0].boxes.length,2);
});

test('paragraph choice supports arbitrary selected order 1,2,3,4,5,6,7',()=>{
 const chosen=Array.from({length:7},(_,index)=>({text:'Paragraph '+(index+1)}));
 const reordered=reorderParagraphs(chosen,6,-1);
 assert.deepEqual(reordered.map(p=>p.text),[
  'Paragraph 1','Paragraph 2','Paragraph 3','Paragraph 4',
  'Paragraph 5','Paragraph 7','Paragraph 6'
 ]);
 assert.deepEqual(chosen.map(p=>p.text),Array.from({length:7},(_,i)=>'Paragraph '+(i+1)));
 assert.deepEqual(reorderParagraphs(chosen,0,-1),chosen);
});

test('existing automatic PDF/EPUB Read Aloud remains available by default',()=>{
 assert.match(app,/function beginSpeechPick\(kind\)/);
 assert.match(app,/async function startPdfSpeech\(\)/);
 assert.match(app,/orderPdfSpeechItems\(content\.items/);
 assert.match(app,/pdfSpeechText\(ordered\.slice\(start\)\)/);
 assert.match(app,/readAloudNext\(\)/);
 assert.match(app,/function markPdfReading\(/);
 assert.match(app,/function markEpubReading\(/);
 assert.match(app,/if\(numberedPlayback\.pdf\)return numberedParagraphs\.pdf/);
 assert.match(app,/if\(numberedPlayback\.epub\)/);
});

test('numbered selections use inline playback controls',()=>{
 for(const kind of ['pdf','epub'])assert.ok(html.includes('id="'+kind+'-play-selected"'));
 assert.doesNotMatch(app,/Paragraph reading order/);
 assert.ok(app.includes('list.splice(index,1)'));
 assert.ok(css.includes('rgba(255,200,45,.20)'));
});

test('selected paragraphs use the same Edge player and prefetch as automatic reading',()=>{
 assert.match(app,/controller\.stop\(\);numberedPlayback\[kind\]=true/);
 assert.match(app,/numberedCursor\[kind\]=0/);
 assert.match(app,/speechPlayer\(kind,true\)/);
 assert.match(app,/controller\.play\(\)/);
 assert.match(app,/if\(numberedPlayback\.pdf\)return numberedParagraphs\.pdf\[numberedCursor\.pdf\+1\]/);
 assert.match(app,/if\(numberedPlayback\.epub\)\{/);
 assert.match(app,/if\(following>=numberedParagraphs\.pdf\.length\)return false/);
});

test('PDF picks while narration runs do not automatically interrupt playback',()=>{
 const i=app.indexOf('async function pickNumberedPdfParagraph(event,slot)');
 const j=app.indexOf("$('pages').addEventListener('click'",i);
 const snippet=app.slice(i,j);
 assert.match(snippet,/addNumberedParagraph\('pdf'/);
 assert.doesNotMatch(snippet,/pdfSpeech\?\.stop\(\)/);
 assert.doesNotMatch(snippet,/pdfSpeech\.play\(\)/);
 assert.match(app,/event\.stopImmediatePropagation\(\)/);
 assert.match(app,/const slot=event\.target\.closest\('\.pdf-slot'\)/);
});

test('WebP page replacement and book spread rebuild retain numbered markers',()=>{
 assert.match(app,/querySelectorAll\('\.annotation-layer,\.numbered-pick-overlay'\)/);
 assert.match(app,/for\(const overlay of overlays\)slot\.append\(overlay\)/);
 assert.match(app,/renderNumberedMarkers\(\);\s*annotationDrawAll\(\)/);
 assert.match(app,/slot\.append\(overlay\)/);
});

test('EPUB taps can select full headlines and paragraphs with visual numbers',()=>{
 assert.match(epub,/onTextTap\?\.\(block\.textContent\.trim\(\),block\)/);
 assert.match(epub,/pishelf-numbered-paragraph/);
 assert.match(app,/canSelectSpeechText:\(\)=>speechPickMode==='epub'\|\|numberedPickMode\.epub/);
 assert.match(app,/if\(numberedPickMode\.epub\)\{/);
 assert.match(app,/node\.dataset\.pishelfParagraphChoiceId/);
 assert.match(app,/entry\.node\.setAttribute\('data-pishelf-paragraph-number'/);
});

test('queue resets on document switch and close',()=>{
 assert.match(app,/resetNumberedParagraphs\('pdf'\);pdfSpeech\?\.stop\(\)/);
 assert.match(app,/resetNumberedParagraphs\('epub'\);epubSpeech\?\.stop\(\)/);
 assert.match(app,/function resetNumberedParagraphs\(kind\)/);
});


test('a column ending mid-sentence stays separate from the lower debate sidebar',()=>{
 const groups=numberedPdfParagraphs([
  line('This is a long way from the COP28',205,640,0),
  {...line('The debate over how to reverse global warming',40,666,1),fontName:'heading'},
  {...line('Electrification is not the only debate',40,682,2),fontName:'body'},
  {...line('in the energy delivered',205,220,3),readingColumn:1}
 ],viewport);
 assert.equal(paragraphAtPoint(groups,210,636,viewport).text,'This is a long way from the COP28');
 assert.equal(paragraphAtPoint(groups,48,663,viewport).text,'The debate over how to reverse global warming');
 assert.equal(paragraphAtPoint(groups,210,216,viewport).text,'in the energy delivered');
});


test('slightly wider spacing includes the next aligned body line',()=>{
 const groups=numberedPdfParagraphs([
  line('The article continues',205,420,0),
  line('on this slightly indented line.',214,447,1),
  line('A separate paragraph.',205,478,2)
 ],viewport);
 assert.deepEqual(groups.map(group=>group.text),[
  'The article continues on this slightly indented line.','A separate paragraph.'
 ]);
});

test('tapping any line selects the whole paragraph across inline emphasis',()=>{
 const body=(text,x,y,id,width,fontName='body')=>({...line(text,x,y,id),width,boxWidth:width,fontName});
 const groups=numberedPdfParagraphs([
  body('Energy use',25,100,0,75),body('rose',106,100,1,24,'italic'),
  body('again this year.',25,116,2,102),
  body('The trend continued.',25,132,3,126),
  body('Another paragraph.',38,148,4,128)
 ],viewport);
 for(const y of [97,113,129]){
  assert.equal(paragraphAtPoint(groups,40,y,viewport).text,'Energy use rose again this year. The trend continued.\nAnother paragraph.');
 }
 assert.equal(paragraphAtPoint(groups,45,145,viewport).text,'Another paragraph.');
});

test('one tap selects all remaining contiguous body paragraphs before a sidebar',()=>{
 const lines=Array.from({length:10},(_,i)=>({
  ...line('Body paragraph '+i+'.',40,100+i*32,i),fontName:'body'
 }));
 lines.push({...line('The debate over how to reverse global warming',40,423,10),fontName:'heading'});
 const paragraphs=numberedPdfParagraphs(lines,viewport);
 const passage=paragraphAtPoint(paragraphs,50,160,viewport);
 assert.deepEqual(passage.text.split('\n'),lines.slice(2,10).map(item=>item.str));
 assert.equal(passage.boxes.length,8);
});

test('opening Read prepares selection without starting narration',async()=>{
 const source=app.slice(app.indexOf('async function beginSpeechPick(kind)'),app.indexOf('async function readPdfFromTap'));
 for(const kind of ['pdf','epub']){
  const picks={pdf:false,epub:false},events=[];
  const controller={stop(){events.push('stop')},play(){assert.fail('unexpected playback')}};
  const open=new Function('$','current','cancelSpeechPick','startPdfSpeech','startEpubSpeech','pdfSpeech','epubSpeech','resetNumberedParagraphs','numberedPickMode','speechPlayer','refreshNumberedSelection','toast',source+'return beginSpeechPick;')(
   ()=>({hidden:false,setAttribute(){}}),{id:'book'},()=>{},async()=>{},async()=>{},controller,controller,
   ()=>{},picks,()=>events.push('show player'),()=>{},message=>assert.match(message,/Play selected/));
  await open(kind);
  assert.equal(picks[kind],true);
  assert.deepEqual(events,['stop','show player']);
 }
});

test('a wrapped sentence continues into the next column but stops at a sidebar',()=>{
 const body=(text,x,y,id,column,region=0)=>({
  ...line(text,x,y,id),fontName:'body',readingColumn:column,readingRegion:region
 });
 const paragraphs=numberedPdfParagraphs([
  body('Power use is rising across',25,600,0,0),
  body('the region as demand grows.',220,100,1,1),
  body('New capacity is planned.',220,131,2,1),
  body('The debate over how to reverse warming',220,164,3,1,1)
 ],viewport);
 const passage=paragraphAtPoint(paragraphs,30,598,viewport);
 assert.equal(passage.id,'0,1,2');
 assert.equal(passage.text.includes('The debate'),false);
});
