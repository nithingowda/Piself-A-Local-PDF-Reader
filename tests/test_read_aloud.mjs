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
 assert.match(app,/readingMarkIndex=offset/);
 assert.match(app,/pdfSpeechItemsPage/);
 assert.match(app,/markEpubReading\(state\.readingSentence\|\|state\.spokenText,0\)/);
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

test('punctuation cleanup preserves quotes, commas, stops and decimal numbers',async()=>{
 const {normalizeSpeechText,splitSpeechChunks}=await import('../static/read-aloud.js');
 const original='  “ Hello , world ! ”  Dr. Rao said , “ The value is 3 . 14 . ” \n\n Next paragraph , really ?  ';
 const expected='“Hello, world!” Dr. Rao said, “The value is 3.14.”\nNext paragraph, really?';
 assert.equal(normalizeSpeechText(original),expected);
 assert.deepEqual(splitSpeechChunks(original),[
  '“Hello, world!” Dr. Rao said, “The value is 3.14.”',
  'Next paragraph, really?'
 ]);
});
test('punctuation-aware chunks never insert spaces inside abbreviations or decimals',async()=>{
 const {normalizeSpeechText,splitSpeechChunks}=await import('../static/read-aloud.js');
 const paragraph=('Dr. Rao measured 3.14 metres, then said, “It is correct.” ').repeat(12).trim();
 const chunks=splitSpeechChunks(paragraph);
 assert.ok(chunks.length>1);
 assert.ok(chunks.every(chunk=>chunk.length<=440&&chunk.length>0));
 assert.equal(chunks.join(' '),normalizeSpeechText(paragraph));
 assert.ok(chunks.every(chunk=>!chunk.endsWith('Dr.')));
 assert.ok(chunks.some(chunk=>chunk.endsWith('.”')));
});
test('full paragraphs group several sentences into a single naturally paced clip',async()=>{
 const {splitSpeechChunks}=await import('../static/read-aloud.js');
 const speech='The headline is here.\nBREAK open the bubbly, light the candles, and get ready to party. “New Scientist is 70 years old!” This is its first issue in 1956.\nThe next paragraph starts now.';
 assert.deepEqual(splitSpeechChunks(speech),[
  'The headline is here.',
  'BREAK open the bubbly, light the candles, and get ready to party. “New Scientist is 70 years old!” This is its first issue in 1956.',
  'The next paragraph starts now.'
 ]);
});

test('New Scientist footer is skipped and an unfinished sentence continues into the next column',async()=>{
 const {orderPdfSpeechItems,pdfSpeechText}=await import('../static/pdf-reading-order.js');
 const viewport={width:700,height:890,convertToViewportPoint:(x,y)=>[x,y]};
 const fragment=(str,x,y,width=165)=>({
  str,transform:[1,0,0,1,x,y],width,height:12,hasEOL:true
 });
 // Simulate the magazine's PDF stream: its bottom-page footer and article
 // fragments are interleaved rather than stored in visual reading order.
 const source=[
  fragment('video channels. That said, we also speculated',251,550),
  fragment('that it might be possible to manipulate models.',251,569),
  fragment('The anniversary continues in our magazine.',251,588),
  fragment('A clear demonstration, if one were needed,',471,550),
  fragment('is how far our predictions have come.',471,569),
  fragment('You can read the full story here.',471,588),
  fragment('BREAK open the bubbly, light the candles',35,550),
  fragment('and get ready to party. New Scientist is 70!',35,569),
  fragment('Our digital offering has expanded greatly',35,811),
  fragment('with interviews available across our podcast and',35,830),
  fragment('Happy 70th birthday',173,93,280),
  fragment('Join us as we look to the past and future',173,126,310),
  fragment('2 |',35,877,20),
  fragment('New Scientist',61,877,90),
  fragment('| 21 November 2026',157,877,135)
 ];
 const ordered=orderPdfSpeechItems(source,viewport);
 const spoken=pdfSpeechText(ordered);
 assert.equal(ordered.some(item=>item.str.includes('21 November 2026')),false);
 assert.equal(spoken.includes('2 | New Scientist'),false);
 assert.match(spoken,/across our podcast and video channels\. That said/);
 assert.ok(spoken.indexOf('BREAK open the bubbly')<spoken.indexOf('across our podcast and'));
 assert.ok(spoken.indexOf('video channels')<spoken.indexOf('A clear demonstration'));
 assert.equal(spoken.includes('Happy 70th birthday'),true);
});
test('a dated sentence at the foot of a PDF page remains readable',async()=>{
 const {orderPdfSpeechItems}=await import('../static/pdf-reading-order.js');
 const viewport={width:700,height:890,convertToViewportPoint:(x,y)=>[x,y]};
 const item=(str,x,y)=>({str,transform:[1,0,0,1,x,y],width:180,height:12});
 const ordered=orderPdfSpeechItems([
  item('Our 21 November 2026 report explains the result.',40,872),
  item('The experiment continues.',40,840)
 ],viewport);
 assert.equal(ordered.length,2);
});


test('Edge synthesis sends true sentence timings without changing the MP3 payload',()=>{
 const server=readFileSync(new URL('../server.py',import.meta.url),'utf8');
 assert.match(server,/boundary='SentenceBoundary'/);
 assert.match(server,/part\['type'\]==='SentenceBoundary'/);
 assert.match(server,/X-PiShelf-Sentences/);
 assert.match(speech,/response\.headers\.get\('X-PiShelf-Sentences'\)/);
});
test('sentence highlights follow punctuation and exact Edge timestamp boundaries',async()=>{
 const {speechSentenceRanges}=await import('../static/read-aloud.js');
 const chunk='Happy 70th birthday. BREAK open the bubbly, light the candles. “Video channels,” she said. Now the story continues!';
 const words=speechSentenceRanges(chunk,[
  [0.1,2,'Happy 70th birthday.'],
  [2.15,4,'BREAK open the bubbly, light the candles.'],
  [6.3,3,'“Video channels,” she said.'],
  [9.4,4,'Now the story continues!']
 ]);
 assert.equal(words.length,4);
 assert.deepEqual(words.map(x=>x.text),[
  'Happy 70th birthday.',
  'BREAK open the bubbly, light the candles.',
  '“Video channels,” she said.',
  'Now the story continues!'
 ]);
 assert.deepEqual(words.map(x=>x.time),[0.1,2.15,6.3,9.4]);
 assert.ok(words.every(x=>chunk.slice(x.start,x.end)===x.text));
});
test('sentence fallback remains usable without online boundary metadata',async()=>{
 const {speechSentenceRanges}=await import('../static/read-aloud.js');
 const chunk='First sentence. Second sentence! Third sentence?';
 const ranges=speechSentenceRanges(chunk);
 assert.deepEqual(ranges.map(x=>x.text),['First sentence.','Second sentence!','Third sentence?']);
 assert.ok(ranges.every(x=>x.time===null));
});
test('next PDF page gets prefetched before the current audio ends',()=>{
 assert.match(speech,/nextPagePrefetch=preloadNextPage\(\)/);
 assert.match(speech,/peekNextText=\\(\\)=>null/);
 assert.match(speech,/await next\(\)/);
 assert.match(speech,/speakNext\(session,nextReady\)/);
 assert.match(app,/async peekNextText\(\)/);
 assert.match(app,/pdfSpeechCurrentPage\(\)\+1/);
 assert.match(speech,/player\.preload='auto'/);
});
test('PDF highlighting uses contiguous sentence character spans rather than word counting',()=>{
 const pdfOrder=readFileSync(new URL('pdf-reading-order.js',root),'utf8');
 assert.match(app,/async function markPdfReading\(text,offset=0,length=0\)/);
 assert.match(app,/const end=offset\+length/);
 assert.match(app,/Math\.min\(to,end\)/);
 assert.match(app,/readingMarkIndex=offset/);
 assert.match(pdfOrder,/export function pdfSpeechLayout/);
});


test('stacked Physics and Health articles read separately before advancing down-page',async()=>{
 const {orderPdfSpeechItems,pdfSpeechText,splitPdfArticleBands}=await import('../static/pdf-reading-order.js');
 const viewport={width:700,height:890,convertToViewportPoint:(x,y)=>[x,y]};
 const item=(str,x,y,height=12,width=155)=>({
  str,transform:[1,0,0,1,x,y],width,height,hasEOL:true
 });
 const top=[
  item('Physics',25,38,9),
  item('First quantum clock that',25,63,23,300),
  item('ticks using sunlight',25,88,23,300),
  item('Karmela Padavic-Callaghan',25,119,10)
 ];
 // Dense top-article text in all columns; no artificial gap inside Physics.
 for(let n=0;n<25;n++){
  const y=155+n*16;
  for(const [index,x] of [25,190,355,520].entries())
   top.push(item('Physics column '+(index+1)+' line '+(n+1)+'.',x,y));
 }
 const health=[
  item('Health',25,584,9),
  item('Pink noise may ease',25,608,23,210),
  item('Alzheimer’s disease',25,633,23,210),
  item('memory loss',25,658,23,210)
 ];
 for(let n=0;n<9;n++){
  const y=683+n*16;
  for(const [index,x] of [25,190,355,520].entries())
   health.push(item('Health column '+(index+1)+' line '+(n+1)+'.',x,y));
 }
 // Deliberately interleave content streams, as in magazine PDFs.
 const raw=[...health.reverse(),...top.reverse()];
 const ordered=orderPdfSpeechItems(raw,viewport);
 const body=pdfSpeechText(ordered);
 const physicsStart=body.indexOf('First quantum clock');
 const physicsLast=body.indexOf('Physics column 4 line 25.');
 const healthStart=body.indexOf('Health');
 const healthBody=body.indexOf('Health column 1 line 1.');
 assert.ok(physicsStart>=0&&physicsStart<physicsLast);
 assert.ok(physicsLast<healthStart,'finish all four Physics columns before starting Health');
 assert.ok(healthStart<healthBody);
 assert.ok(body.indexOf('Physics column 1 line 25.')<body.indexOf('Physics column 2 line 1.'));
 assert.ok(body.indexOf('Health column 1 line 9.')<body.indexOf('Health column 2 line 1.'));
 const distinct=new Set(ordered.map(part=>part.readingRegion));
 assert.ok(distinct.size>=2,'stacked stories must have separate reading regions');
 const measured=raw.map((fragment,sourceIndex)=>({
  ...fragment,sourceIndex,x:fragment.transform[4],y:fragment.transform[5],
  boxHeight:fragment.height,boxWidth:fragment.width
 }));
 assert.ok(splitPdfArticleBands(measured,viewport).length>=2);
});

test('multiple magazine sections on one page keep a headline from jumping to another article',async()=>{
 const {orderPdfSpeechItems}=await import('../static/pdf-reading-order.js');
 const viewport={width:700,height:890,convertToViewportPoint:(x,y)=>[x,y]};
 const line=(str,x,y,height=12)=>({str,transform:[1,0,0,1,x,y],width:130,height});
 const raw=[
  line('Physics',25,35,9),line('Quantum clock powered by sunlight',25,65,24),
  line('First physics line',25,160),line('Last physics line',25,550),
  line('Second physics column',195,160),line('Second physics ending',195,550),
  line('Third physics column',365,160),line('Third physics ending',365,550),
  line('Health',25,585,9),line('Pink noise may ease memory loss',25,612,24),
  line('Health details one',25,670),line('Health details two',25,685),
  line('More health details',195,670),line('Final health details',195,685)
 ];
 const ordered=orderPdfSpeechItems(raw,viewport);
 const physicsEnd=ordered.findIndex(part=>part.str==='Third physics ending');
 const healthStart=ordered.findIndex(part=>part.str==='Health');
 assert.ok(physicsEnd>=0&&healthStart>physicsEnd);
});
