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
test('speech cancels on closing and uses local browser voices',()=>{
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

test('Piper speech requests include the current session CSRF token',()=>{
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

test('Edge Neerja defaults with Piper fallback and buffered next segment',()=>{
 const server=readFileSync(new URL('../server.py',import.meta.url),'utf8');
 const docker=readFileSync(new URL('../Dockerfile',import.meta.url),'utf8');
 assert.match(app,/Neerja · Indian English \(Female\)/);
 assert.match(app,/en-IN-NeerjaNeural/);
 assert.match(speech,/voice='en-IN-NeerjaNeural'/);
 assert.match(speech,/\/api\/tts\/edge/);
 assert.doesNotMatch(speech,/\/api\/tts\/alba/);
 assert.match(speech,/prefetch=requestSpeech\(chunks\[index\],selectedVoice\)/);
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
