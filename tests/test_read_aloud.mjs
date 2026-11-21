import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
const root=new URL('../static/',import.meta.url);
const html=readFileSync(new URL('index.html',root),'utf8');
const app=readFileSync(new URL('app.js',root),'utf8');
const epub=readFileSync(new URL('epub-reader.js',root),'utf8');
const speech=readFileSync(new URL('read-aloud.js',root),'utf8');
test('PDF and EPUB have independent read aloud controls',()=>{
 for(const kind of ['pdf','epub'])for(const action of ['play','pause','stop','rate','voice'])assert.match(html,new RegExp('id="'+kind+'-read-'+action+'"'));
});
test('PDF text is extracted from PDF.js and EPUB text from the rendition',()=>{
 assert.match(app,/documentPDF.getPage\(page\)/);
 assert.match(app,/pdfPage.getTextContent\(\)/);
 assert.match(epub,/readAloudText\(\)/);
 assert.match(epub,/readAloudNext\(\)/);
});
test('speech cancels on closing without browser voice fallback',()=>{
 assert.match(app,/pdfSpeech\?\.stop\(\)/);
 assert.match(app,/epubSpeech\?\.stop\(\)/);
 assert.doesNotMatch(speech,/window.speechSynthesis/);
 assert.doesNotMatch(speech,/SpeechSynthesisUtterance/);
});

test('compact immersive player provides seek and playback controls for both formats',()=>{
 const css=readFileSync(new URL('style.css',root),'utf8');
 for(const kind of ['pdf','epub']){
  assert.match(html,new RegExp('id="'+kind+'-speech-player"'));
  for(const control of ['toggle','back','main','forward','close','more'])
   assert.match(html,new RegExp('id="'+kind+'-read-'+control+'"'));
  assert.match(app,new RegExp("speechPlayer\\('"+kind+"'"));
 }
 assert.match(css,/speech-immersive/);
 assert.match(speech,/function seek\(seconds\)/);
 assert.match(speech,/audio\.currentTime/);
});

test('Online Edge speech requests include the current session CSRF token',()=>{
 assert.match(speech,/getCsrfToken=\(\)=>''/);
 assert.match(speech,/'X-PiShelf-CSRF':getCsrfToken\(\)/);
 assert.match(app,/getCsrfToken:\(\)=>signedInUser\?\.csrf\|\|''/);
});

test('spoken sentence indicator and scrollable immersive reader',()=>{
 const css=readFileSync(new URL('style.css',root),'utf8');
 for(const kind of ['pdf','epub'])assert.doesNotMatch(html,new RegExp('id="'+kind+'-spoken-text"'));
 assert.match(speech,/spokenText:chunk/);
 assert.match(app,/state\.spokenText/);
 assert.match(css,/#reader\.speech-immersive #page-area\{overflow:auto!important/);
 assert.doesNotMatch(css,/#reader\.speech-immersive,#epub-reader\.speech-immersive\{position:relative\}/);
});

test('Edge Neerja defaults with bounded buffered next segment',()=>{
 const server=readFileSync(new URL('../server.py',import.meta.url),'utf8');
 const docker=readFileSync(new URL('../Dockerfile',import.meta.url),'utf8');
 assert.match(app,/Neerja · Indian English \(Female\)/);
 assert.match(app,/en-IN-NeerjaNeural/);
 assert.match(speech,/DEFAULT_VOICE='en-IN-NeerjaNeural'/);
 assert.match(speech,/\/api\/tts\/edge/);
 assert.doesNotMatch(speech,/\/api\/tts\/alba/);
 assert.match(speech,/prefetch=prepare\(chunks\[index\]\)/);
 assert.match(server,/en-IN-NeerjaNeural/);
 assert.match(server,/audio\/mpeg/);
 assert.match(docker,/edge-tts/);
});

test('Only Edge voices are offered and reading highlights track playback',()=>{
 assert.doesNotMatch(app,/new Option\('Alba/);
 assert.doesNotMatch(app,/Browser default voice/);
 assert.match(app,/markPdfReading/);
 assert.match(app,/markEpubReading/);
 assert.match(speech,/ontimeupdate/);
});

test('Glass player has no caption and online speech cancels pending requests',()=>{
 const css=readFileSync(new URL('style.css',root),'utf8');
 const server=readFileSync(new URL('../server.py',import.meta.url),'utf8');
 assert.doesNotMatch(html,/id="pdf-spoken-text"/);
 assert.doesNotMatch(html,/id="epub-spoken-text"/);
 assert.match(css,/prefers-reduced-transparency/);
 assert.match(speech,/requests\.clear\(\)/);
 assert.match(speech,/URL\.revokeObjectURL/);
 assert.match(server,/EDGE_TTS_SLOTS=threading\.BoundedSemaphore\(2\)/);
 assert.match(server,/raise APIError\(429/);
});

test('floating player can be dragged and Edge voice choice persists',()=>{
 for(const kind of ['pdf','epub'])assert.match(html,new RegExp('id="'+kind+'-speech-player"[^>]*>\\s*<div class="speech-drag-handle"'));
 assert.match(app,/enableSpeechDrag\(kind\)/);
 assert.match(app,/setPointerCapture/);
 assert.match(app,/localStorage\.setItem\(VOICE_STORAGE_KEY,selected\)/);
 assert.match(app,/preferredSpeechVoice\(\)/);
});
test('reading highlight updates by audio progress without a player transcript',()=>{
 assert.match(app,/readingMarkIndex===wordIndex/);
 assert.match(app,/pdfSpeechItemsPage/);
 assert.match(app,/markEpubReading\(state\.spokenText,state\.readingProgress\|\|0\)/);
 assert.match(speech,/ontimeupdate/);
});

test('speech chunker handles long text without oversized chunks',async()=>{
 const {splitSpeechChunks}=await import('../static/read-aloud.js');
 const chunks=splitSpeechChunks('First sentence. '+'long '.repeat(140)+'Final sentence!');
 assert.ok(chunks.length>2);
 assert.ok(chunks.every(chunk=>chunk.length<=440));
 assert.equal(chunks.join(' ').replace(/\s+/g,' '),('First sentence. '+'long '.repeat(140)+'Final sentence!').trim().replace(/\s+/g,' '));
});

test('headlines are preserved in speech extraction',async()=>{
 const {splitSpeechChunks}=await import('../static/read-aloud.js');
 assert.deepEqual(splitSpeechChunks('Breaking News\nThe story begins here.'),['Breaking News','The story begins here.']);
 assert.match(readFileSync(new URL('pdf-reading-order.js',root),'utf8'),/item\.hasEOL/);
 assert.match(epub,/h1,h2,h3,h4,h5,h6,p,blockquote,li/);
});

test('tap to read starts PDF at a selected text item',()=>{
 assert.match(app,/async function readPdfFromTap\(event\)/);
 assert.match(app,/pdfSpeechStart=\{page:targetPage,index:items\[index\]\.sourceIndex\}/);
 assert.match(app,/pdfSpeechText\(ordered\.slice\(start\)\)/);
 assert.match(app,/pdfSpeech\.play\(\)/);
});
test('EPUB text taps choose a heading or paragraph and preserve later content',()=>{
 assert.match(epub,/onTextTap/);
 assert.match(epub,/speechStartNode=block/);
 assert.match(epub,/visible\.slice\(Math\.max\(0,start\)\)/);
 assert.match(app,/onTextTap:async/);
});

test('tap selection is visible in PDF and EPUB while audio loads',()=>{
 const css=readFileSync(new URL('style.css',root),'utf8');
 assert.match(app,/speech-tap-selection/);
 assert.match(app,/slot\.append\(selection\)/);
 assert.match(css,/\.speech-tap-selection/);
 assert.match(epub,/pishelf-tap-selected/);
 assert.match(epub,/doc\.head\?\.append\(style\)/);
});

test('read aloud requires an explicit tap-to-start prompt',()=>{
 const css=readFileSync(new URL('style.css',root),'utf8');
 assert.match(app,/function beginSpeechPick\(kind\)/);
 assert.match(app,/speechPickMode!=='pdf'/);
 assert.match(app,/speechPickMode!=='epub'/);
 assert.match(app,/\$\(kind\+'-read-toggle'\)\.onclick=\(\)=>beginSpeechPick\(kind\)/);
 assert.match(app,/speech-pick-notice/);
 assert.match(css,/\.speech-pick-notice/);
 assert.match(epub,/canSelectSpeechText\(\)/);
 assert.match(readFileSync(new URL('pdf-reading-order.js',root),'utf8'),/sourceIndex/);
});

test('read aloud stays on tapped PDF page including right side of a book spread',()=>{
 assert.match(app,/pdfSpeechPage=targetPage/);
 assert.match(app,/const speechPage=pdfSpeechCurrentPage\(\)/);
 assert.match(app,/documentPDF\.getPage\(speechPage\)/);
 assert.match(app,/const start=pdfSpeechStart\?\.page===speechPage/);
 assert.match(app,/if\(target\)\{/);
 assert.match(app,/showPdfSpeechPage\(targetPage\)/);
 assert.match(app,/pdfSpeechPage=currentPage\+1/);
 assert.doesNotMatch(app,/if\(page!==targetPage\)move\(targetPage\)/);
});

test('tapped page stays the read-aloud source even in scroll and book views',()=>{
 assert.match(app,/function pdfSpeechCurrentPage\(\)\{return pdfSpeechPage\|\|page;\}/);
 assert.match(app,/pdfSpeechPage=targetPage/);
 assert.match(app,/showPdfSpeechPage\(targetPage\)/);
 assert.match(app,/const speechPage=pdfSpeechCurrentPage\(\)/);
 assert.match(app,/const currentPage=pdfSpeechCurrentPage\(\)/);
 assert.match(app,/pdfSpeechPage=currentPage\+1/);
 assert.match(app,/if\(target\)\{/);
});

test('a magazine headline continues into bottom article columns on the same page',async()=>{
 const {orderPdfSpeechItems,pdfSpeechText}=await import('../static/pdf-reading-order.js');
 const viewport={width:600,height:800,convertToViewportPoint:(x,y)=>[x,y]};
 const item=(str,x,y,width=160)=>({str,transform:[1,0,0,1,x,y],width,height:12,hasEOL:true});
 // Stream order deliberately differs from the visual reading order.
 const raw=[
  item('middle paragraph two',220,630),
  item('left paragraph two',20,630),
  item('right paragraph one',420,600),
  item('left paragraph one',20,600),
  item('middle paragraph one',220,600),
  item('right paragraph two',420,630),
  item('Happy 70th birthday',170,95,280),
  item('Join us as we look to the past and future',170,130,300)
 ];
 const ordered=orderPdfSpeechItems(raw,viewport);
 assert.deepEqual(ordered.map(item=>item.str),[
  'Happy 70th birthday','Join us as we look to the past and future',
  'left paragraph one','left paragraph two',
  'middle paragraph one','middle paragraph two',
  'right paragraph one','right paragraph two'
 ]);
 const start=ordered.findIndex(item=>item.sourceIndex===6);
 const remainder=pdfSpeechText(ordered.slice(start));
 assert.ok(remainder.includes('left paragraph one'));
 assert.ok(remainder.indexOf('Happy 70th birthday')<remainder.indexOf('left paragraph one'));
 assert.ok(remainder.indexOf('left paragraph two')<remainder.indexOf('middle paragraph one'));
});

test('magazine body reads down each column despite overlapping PDF text boxes',async()=>{
 const {orderPdfSpeechItems}=await import('../static/pdf-reading-order.js');
 const viewport={width:600,height:800,convertToViewportPoint:(x,y)=>[x,y]};
 const item=(str,x,y)=>({str,transform:[1,0,0,1,x,y],width:210,height:12,hasEOL:true});
 const source=[
  item('left top',25,585),item('middle top',225,585),item('right top',425,585),
  item('left middle',25,610),item('middle middle',225,610),item('right middle',425,610),
  item('left bottom',25,635),item('middle bottom',225,635),item('right bottom',425,635),
  item('Happy 70th birthday',170,90),
  item('Join us as we look to the past',170,120)
 ];
 const ordered=orderPdfSpeechItems(source,viewport).map(item=>item.str);
 assert.deepEqual(ordered,[
  'Happy 70th birthday','Join us as we look to the past',
  'left top','left middle','left bottom',
  'middle top','middle middle','middle bottom',
  'right top','right middle','right bottom'
 ]);
});

test('wrapped PDF lines merge into natural paragraphs before Edge synthesis',async()=>{
 const {pdfSpeechText}=await import('../static/pdf-reading-order.js');
 const line=(str,y,x=25)=>({str,x,y,boxHeight:12,boxWidth:180});
 const paragraphs=pdfSpeechText([
  line('BREAK open the bubbly, light',600),
  line('the candles and get ready to party.',615),
  line('New Scientist is 70 years old!',630),
  line('The second paragraph starts here.',675)
 ]);
 assert.equal(paragraphs,
  'BREAK open the bubbly, light the candles and get ready to party. New Scientist is 70 years old!\nThe second paragraph starts here.');
 const {splitSpeechChunks}=await import('../static/read-aloud.js');
 assert.deepEqual(splitSpeechChunks(paragraphs),[
  'BREAK open the bubbly, light the candles and get ready to party. New Scientist is 70 years old!',
  'The second paragraph starts here.'
 ]);
});
test('paragraph synthesis batches short sentences and preloads upcoming audio',async()=>{
 const {splitSpeechChunks}=await import('../static/read-aloud.js');
 const short=Array.from({length:10},(_,i)=>'Sentence '+(i+1)+'.').join(' ');
 assert.equal(splitSpeechChunks(short).length,1);
 const many=splitSpeechChunks('Long paragraph. '.repeat(80));
 assert.ok(many.every(part=>part.length<=440));
 assert.ok(many.length<8);
 assert.match(speech,/player\.preload='auto'/);
 assert.match(speech,/prefetch=prepare\(chunks\[index\]\)/);
 assert.match(speech,/prepared\.clear\(\)/);
});
test('PDF overlays highlight a complete spoken passage without per-word DOM updates',()=>{
 const css=readFileSync(new URL('style.css',root),'utf8');
 assert.match(app,/speech-paragraph-overlay/);
 assert.match(app,/overlay\.append\(highlight\)/);
 assert.match(app,/overlay\.childElementCount>=120/);
 assert.match(css,/\.speech-paragraph-overlay/);
});
