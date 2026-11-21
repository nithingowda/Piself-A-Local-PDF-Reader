import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';

const root=new URL('../static/',import.meta.url);
const html=readFileSync(new URL('index.html',root),'utf8');
const app=readFileSync(new URL('app.js',root),'utf8');
const epub=readFileSync(new URL('epub-reader.js',root),'utf8');
const speech=readFileSync(new URL('read-aloud.js',root),'utf8');
const css=readFileSync(new URL('style.css',root),'utf8');
const server=readFileSync(new URL('../server.py',import.meta.url),'utf8');

test('existing PDF and EPUB player controls remain available',()=>{
 for(const kind of ['pdf','epub']){
  for(const action of ['play','pause','stop','rate','voice','back','main','forward','close','more'])
   assert.match(html,new RegExp('id="'+kind+'-read-'+action+'"'));
  assert.match(html,new RegExp('id="'+kind+'-speech-player"'));
 }
 assert.match(app,/function enableSpeechDrag\(kind\)/);
 assert.match(app,/preferredSpeechVoice\(\)/);
 assert.match(app,/localStorage\.setItem\(VOICE_STORAGE_KEY,selected\)/);
});

test('Read button opens the manual selection queue rather than starting audio',()=>{
 assert.match(app,/\$\('pdf-read-toggle'\)\.onclick=\(\)=>openSpeechQueue\('pdf'\)/);
 assert.match(app,/\$\('epub-read-toggle'\)\.onclick=\(\)=>openSpeechQueue\('epub'\)/);
 assert.match(app,/speechQueues=\{pdf:\[\],epub:\[\]\}/);
 assert.match(app,/speechQueueUI\(kind\)/);
 assert.match(app,/function renderSpeechQueue\(kind\)/);
 assert.match(app,/speech-queue-draft/);
 assert.match(app,/speech-queue-list/);
 assert.match(app,/speech-queue-add/);
 assert.match(app,/speech-queue-select/);
 assert.match(app,/speech-queue-play/);
 assert.match(app,/function rearrangeSpeechQueue\(kind,index,step\)/);
 assert.match(css,/\.speech-queue-panel/);
 assert.match(css,/\.speech-queue-entry/);
});

test('only explicitly queued selections are sent to Edge TTS',()=>{
 assert.match(app,/getText\(\)\{return speechQueues\[kind\]\[speechQueuePosition\[kind\]\]\?\.text\|\|'';\}/);
 assert.match(app,/peekNextText\(\)\{return speechQueues\[kind\]\[speechQueuePosition\[kind\]\+1\]\?\.text\|\|null;\}/);
 assert.match(app,/if\(speechQueuePosition\[kind\]\+1>=speechQueues\[kind\]\.length\)return false;/);
 assert.match(app,/async function playSpeechQueue\(kind\)/);
 assert.match(app,/controller\.stop\(\);speechQueuePosition\[kind\]=0;/);
 assert.match(app,/controller\.play\(\)/);
 assert.doesNotMatch(app,/pdf-reading-order\.js/);
 assert.doesNotMatch(app,/pdfSpeechCurrentPage/);
 assert.doesNotMatch(app,/async peekNextText\(\)/);
 assert.doesNotMatch(app,/speechSentenceRanges/);
 assert.doesNotMatch(speech,/X-PiShelf-Sentences/);
 assert.doesNotMatch(server,/SentenceBoundary/);
});

test('PDF/WebP source can be selected by a rectangle or two taps',()=>{
 assert.match(app,/async function finishPdfSelection\(slot,one,two\)/);
 assert.match(app,/pdfPage\.getTextContent\(\)/);
 assert.match(app,/import\('\.\/manual-read-queue\.js'\)/);
 assert.match(app,/extractPdfRegion\(content\.items,viewport,region\)/);
 assert.match(app,/showPdfSelection\(slot,drag\.start,point\)/);
 assert.match(app,/pdfSelectionAnchor\?\.slot===drag\.slot/);
 assert.match(app,/speechSelecting\.pdf/);
 assert.match(app,/setSpeechDraft\('pdf',chosen\.text\)/);
 assert.match(css,/\.speech-manual-selection/);
 assert.match(css,/speech-selecting-pdf/);
});

test('a PDF user region selects just intersecting text, not unrelated columns',async()=>{
 const {extractPdfRegion}=await import('../static/manual-read-queue.js');
 const viewport={width:700,height:900,convertToViewportPoint:(x,y)=>[x,y]};
 const item=(str,x,y,width=160)=>({str,transform:[1,0,0,1,x,y],width,height:12,hasEOL:true});
 const items=[
  item('Side headline',380,48,220),
  item('Physics article first line.',30,120),
  item('Health article below.',30,610),
  item('Physics article second line.',30,138),
  item('Other article next column.',210,120),
  item('Quantum clock headline',30,52,300),
  item('Footer 2 New Scientist',30,875)
 ];
 const headline=extractPdfRegion(items,viewport,{x1:25,y1:36,x2:340,y2:67});
 assert.equal(headline.text,'Quantum clock headline');
 const paragraph=extractPdfRegion(items,viewport,{x1:25,y1:110,x2:185,y2:148});
 assert.equal(paragraph.text,'Physics article first line. Physics article second line.');
 assert.ok(!paragraph.text.includes('Health'));
 assert.ok(!paragraph.text.includes('Other article'));
 assert.equal(extractPdfRegion(items,viewport,{x1:600,y1:250,x2:690,y2:290}).text,'');
});

test('multiple manual selections can be reordered or removed without changing text',async()=>{
 const {moveQueueItem,queuePreview}=await import('../static/manual-read-queue.js');
 const original=[{text:'Headline'},{text:'First column'},{text:'Second column'}];
 const moved=moveQueueItem(original,2,-1);
 assert.deepEqual(moved.map(x=>x.text),['Headline','Second column','First column']);
 assert.deepEqual(original.map(x=>x.text),['Headline','First column','Second column']);
 assert.deepEqual(moveQueueItem(moved,0,-1),moved);
 assert.equal(queuePreview('  Hello  \n world. '),'Hello world.');
 assert.match(app,/items\.splice\(index,1\)/);
 assert.match(app,/textarea\.onchange=/);
 assert.match(app,/entry\.text=textarea\.value\.trim\(\)/);
});

test('EPUB selection uses user-highlighted phrase and tap-to-preview only',()=>{
 assert.match(epub,/doc\.addEventListener\('selectionchange'/);
 assert.match(epub,/getSelection\(\)\?\.toString\(\)\?\.trim\(\)/);
 assert.match(epub,/onSelection\?\.\(selected\)/);
 assert.match(epub,/onTextTap\?\.\(block\.textContent\.trim\(\)\)/);
 assert.match(epub,/canSelectSpeechText\(\)/);
 assert.match(app,/onSelection:text=>/);
 assert.match(app,/setSpeechDraft\('epub',text\)/);
 assert.doesNotMatch(epub,/readAloudNext\(/);
 assert.doesNotMatch(epub,/readAloudText\(/);
});

test('Edge keeps punctuation and uses bounded audio preloading of queued items',async()=>{
 const {normalizeSpeechText,splitSpeechChunks}=await import('../static/read-aloud.js');
 assert.equal(normalizeSpeechText(' “ Hello , world ! ” '),'“Hello, world!”');
 const chunks=splitSpeechChunks('Dr. Rao measured 3.14 metres. '.repeat(30));
 assert.ok(chunks.every(chunk=>chunk.length<=440&&chunk.length>0));
 assert.match(speech,/prefetch=prepare\(chunks\[index\]\)/);
 assert.match(speech,/peekNextText\(\)/);
 assert.match(speech,/player\.preload='auto'/);
 assert.match(speech,/URL\.revokeObjectURL/);
 assert.match(speech,/getCsrfToken=\(\)=>''/);
 assert.match(speech,/X-PiShelf-CSRF/);
});

test('reader cleanup discards selections and does not keep old book queue',()=>{
 assert.match(app,/function resetSpeechQueue\(kind\)/);
 assert.match(app,/resetSpeechQueue\('pdf'\)/);
 assert.match(app,/resetSpeechQueue\('epub'\)/);
 assert.match(app,/speechPlayer\(kind,false\)/);
 assert.match(app,/speechQueues\[kind\]=\[\]/);
});

test('unsafe HTML from PDF and EPUB never becomes queue UI markup',()=>{
 assert.match(app,/textarea\.value=entry\.text/);
 assert.match(app,/title\.textContent=/);
 assert.match(app,/setSpeechDraft\(kind,text\)/);
 assert.doesNotMatch(app,/innerHTML\s*=\s*entry\.text/);
});

test('magazine text ordering intelligence and automatic page narration are gone',()=>{
 assert.doesNotMatch(app,/orderPdfSpeechItems/);
 assert.doesNotMatch(app,/pdfSpeechLayout/);
 assert.doesNotMatch(app,/showPdfSpeechPage/);
 assert.doesNotMatch(app,/speechPickNotice/);
 assert.doesNotMatch(app,/markPdfReading/);
 assert.doesNotMatch(app,/markEpubReading/);
});

test('selecting PDF or EPUB text immediately queues and plays the first selection',()=>{
 assert.match(app,/async function enqueueSelectedSpeech\(kind,text\)/);
 assert.match(app,/queue\.push\(entry\)/);
 assert.match(app,/if\(current\?\.active\|\|automaticQueueStartPending\[kind\]\)return/);
 assert.match(app,/speechQueuePosition\[kind\]=speechQueues\[kind\]\.indexOf\(entry\)/);
 assert.match(app,/speechPlayer\(kind,true\)/);
 assert.match(app,/controller\.play\(\)/);
 assert.match(app,/if\(chosen\.text\)void enqueueSelectedSpeech\('pdf',chosen\.text\)/);
 assert.match(app,/onTextTap:text=>\{if\(g===epubGeneration\)void enqueueSelectedSpeech\('epub',text\)/);
 assert.match(app,/onSelection:text=>\{if\(g===epubGeneration\)void enqueueSelectedSpeech\('epub',text\)/);
});
test('new selections append without interrupting the current selection',()=>{
 const start=app.indexOf('async function enqueueSelectedSpeech(kind,text)');
 const end=app.indexOf('function renderSpeechQueue(kind)',start);
 const block=app.slice(start,end);
 assert.match(block,/const current=kind==='pdf'\?pdfSpeech:epubSpeech/);
 assert.match(block,/if\(current\?\.active\|\|automaticQueueStartPending\[kind\]\)return/);
 assert.doesNotMatch(block,/controller\.stop\(\)/);
 assert.doesNotMatch(block,/clearSpeechSelection\(kind\)/);
 assert.doesNotMatch(app.slice(app.indexOf('async function playSpeechQueue(kind)'),app.indexOf('// Read a user-drawn region')),/clearSpeechSelection\(kind\)/);
});
test('EPUB drag selections wait until gesture completion and deduplicate events',()=>{
 assert.match(epub,/doc\.addEventListener\('pointerup',afterSelection\)/);
 assert.match(epub,/doc\.addEventListener\('touchend',afterSelection\)/);
 assert.match(epub,/selectionTimer=setTimeout\(finishSelection,550\)/);
 assert.match(epub,/selected===lastSelected&&now-lastSelectedAt<1500/);
});
