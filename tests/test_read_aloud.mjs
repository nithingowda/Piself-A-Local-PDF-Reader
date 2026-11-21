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
 assert.match(speech,/window.speechSynthesis/);
 assert.match(speech,/SpeechSynthesisUtterance/);
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
 for(const kind of ['pdf','epub'])assert.match(html,new RegExp('id="'+kind+'-spoken-text"'));
 assert.match(speech,/spokenText:chunk/);
 assert.match(app,/state\.spokenText/);
 assert.match(css,/#reader\.speech-immersive #page-area\{overflow:auto!important/);
 assert.doesNotMatch(css,/#reader\.speech-immersive,#epub-reader\.speech-immersive\{position:relative\}/);
});

test('Edge Neerja defaults with Piper fallback and buffered next segment',()=>{
 const server=readFileSync(new URL('../server.py',import.meta.url),'utf8');
 const docker=readFileSync(new URL('../Dockerfile',import.meta.url),'utf8');
 assert.match(app,/Neerja · Indian English \(Online AI\)/);
 assert.match(app,/select\.value=previous\|\|'edge-neerja'/);
 assert.match(speech,/voice='edge-neerja'/);
 assert.match(speech,/\/api\/tts\/edge/);
 assert.match(speech,/\/api\/tts\/alba/);
 assert.match(speech,/prefetch=requestSpeech\(chunks\[index\]\)/);
 assert.match(server,/en-IN-NeerjaNeural/);
 assert.match(server,/audio\/mpeg/);
 assert.match(docker,/edge-tts/);
});
