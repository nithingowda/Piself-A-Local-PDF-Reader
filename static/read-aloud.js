/* Edge Neural TTS: one active audio clip, one prefetched clip, no local synthesis. */
const MAX_CHUNK_LENGTH=440; // Server accepts up to 500 characters per request.
const DEFAULT_VOICE='en-IN-NeerjaNeural';

// Keep punctuation for the neural voice: it supplies cadence for commas,
// sentence endings, quotations and questions without inserting timed delays.
export function normalizeSpeechText(text){
 return String(text||'').normalize('NFC')
  .replace(/[\u00ad\u200b\u2060]/g,'') // PDF discretionary hyphens / invisible joins
  .replace(/\r\n?/g,'\n')
  .replace(/\u00a0/g,' ')
  .replace(/[ \t\f\v]+/g,' ')
  .replace(/ *\n */g,'\n')
  .replace(/ +([,;:.!?…%°)\]}”’])/g,'$1')
  .replace(/([(\[{“‘]) +/g,'$1')
  .replace(/(^|[\s([{])" +/g,'$1"') // ASCII opening quotation
  .replace(/ +(["”’])(?=[,.;:!?]|\s|$)/g,'$1') // quoted closing punctuation
  .replace(/(\d)\. +(\d)/g,'$1.$2')
  .replace(/ *([—–]) */g,' $1 ')
  .replace(/ {2,}/g,' ')
  .trim();
}

// If a paragraph exceeds Edge's safe limit, prefer a sentence boundary,
// then a clause (comma/semicolon/em dash), and only then a word boundary.
// Unlike sentence-regex splitting, decimals, initials and closing quotation
// marks stay attached to their original text.
function speechBreakAt(paragraph,maxLength){
 const minimum=Math.floor(maxLength*.55);
 let selected=0,bestScore=-1,lastSpace=0;
 for(let i=1;i<=maxLength&&i<paragraph.length;i++){
  if(paragraph[i]!==' ')continue;
  lastSpace=i;
  if(i<minimum)continue;
  const before=paragraph.slice(0,i).trimEnd().replace(/["”’)\]]+$/u,'');
  const end=before.slice(-1);
  let weight=0;
  if(/[!?。！？]/u.test(end))weight=5;
  else if(/[.…]/u.test(end)){
   // Treat abbreviations as ordinary words rather than ending a sentence.
   if(!/(?:\b(?:Mr|Mrs|Ms|Dr|Prof|Sr|Jr|St|vs|etc|e\.g|i\.e)|\b(?:[A-Z]\.){2,})\.$/i.test(before))
    weight=4;
  }else if(/[;:]/.test(end))weight=3;
  else if(/[,—–]/.test(end))weight=2;
  const score=weight*1000+i;
  if(score>bestScore){bestScore=score;selected=i;}
 }
 return selected||lastSpace||maxLength;
}

// One clip per short paragraph; long paragraphs are split at natural points.
// Do not split each sentence: pre-buffered clips avoid network gaps this way.
export function splitSpeechChunks(text){
 const chunks=[];
 for(const paragraph of normalizeSpeechText(text).split(/\n+/)){
  if(!paragraph)continue;
  let remaining=paragraph;
  while(remaining.length>MAX_CHUNK_LENGTH){
   const at=speechBreakAt(remaining,MAX_CHUNK_LENGTH);
   chunks.push(remaining.slice(0,at).trimEnd());
   remaining=remaining.slice(at).trimStart();
  }
  if(remaining)chunks.push(remaining);
 }
 return chunks;
}


// Preserve long audio clips but expose individual sentence ranges to the UI.
// Prefer timestamps supplied by Edge; fall back to approximate timing only if
// the service does not provide sentence metadata.
export function speechSentenceRanges(chunk,marks=[]){
 const segments=[];
 if(typeof Intl.Segmenter==='function'){
  const segmenter=new Intl.Segmenter(undefined,{granularity:'sentence'});
  for(const part of segmenter.segment(chunk)){
   const text=part.segment.trim();
   if(text)segments.push({start:part.index+part.segment.indexOf(text),end:part.index+part.segment.indexOf(text)+text.length,text});
  }
 }
 if(!segments.length)segments.push({start:0,end:chunk.length,text:chunk});
 const timed=[];
 let cursor=0;
 for(const mark of marks){
  if(!Array.isArray(mark)||mark.length<3||!Number.isFinite(mark[0])||!Number.isFinite(mark[1]))continue;
  const needle=normalizeSpeechText(mark[2]).trim();
  if(!needle)continue;
  let start=chunk.indexOf(needle,cursor);
  let length=needle.length;
  if(start<0){
   // Edge can omit terminal quotes/punctuation from boundary text.
   const prefix=needle.replace(/[.!?…””"'’)\]]+$/u,'').trim().slice(0,40);
   if(prefix.length>=3){start=chunk.indexOf(prefix,cursor);length=prefix.length;}
  }
  if(start<0)continue;
  const segment=segments.find(part=>part.start<=start&&part.end>=start+Math.min(length,3));
  timed.push({
   start:segment?.start??start,end:segment?.end??Math.min(chunk.length,start+length),
   text:segment?.text??chunk.slice(start,start+length),
   time:Math.max(0,Number(mark[0])),duration:Math.max(0,Number(mark[1]))
  });
  cursor=start+length;
 }
 if(timed.length){
  // SentenceBoundary event timings are authoritative; if multiple items map
  // to one sentence, keep a single highlight for that full sentence.
  return timed.filter((part,i)=>!i||part.start!==timed[i-1].start);
 }
 return segments.map(part=>({...part,time:null,duration:null}));
}

export function createReadAloud({getText,next,peekNextText=()=>null,onState,getCsrfToken=()=>''}){
 let active=false,paused=false,token=0,voice=DEFAULT_VOICE,rate=1,audio=null,audioUrl=null;
 const requests=new Set(),prepared=new Set();
 const notify=()=>onState?.({active,paused,rate,voice});
 const valid=session=>active&&session===token;

 // Cancel current and prefetched network work and release decoded audio.
 function stop(){
  token++;active=false;paused=false;
  for(const request of requests)request.abort();
  requests.clear();
  if(audio&&!Array.from(prepared).some(ready=>ready.player===audio)){
   audio.pause();audio.removeAttribute('src');audio.load();
   if(audioUrl)URL.revokeObjectURL(audioUrl);
  }
  for(const ready of prepared){ready.player.pause();ready.player.removeAttribute('src');ready.player.load();URL.revokeObjectURL(ready.url);}
  prepared.clear();audio=null;audioUrl=null;
  notify();
 }

 // Short, abortable backoff for transient online TTS overloads. No retry is
 // attempted for authentication, CSRF or invalid input errors.
 function speechRetryDelay(milliseconds,signal){
  return new Promise((resolve,reject)=>{
   if(signal.aborted){reject(Error('Speech request cancelled.'));return;}
   const onAbort=()=>{
    clearTimeout(timer);signal.removeEventListener('abort',onAbort);
    reject(Error('Speech request cancelled.'));
   };
   const timer=setTimeout(()=>{
    signal.removeEventListener('abort',onAbort);resolve();
   },milliseconds);
   signal.addEventListener('abort',onAbort,{once:true});
  });
 }
 async function requestSpeech(chunk,selectedVoice){
  const request=new AbortController();
  requests.add(request);
  try{
   for(let attempt=0;attempt<3;attempt++){
    let response;
    try{
     response=await fetch('/api/tts/edge',{
      method:'POST',credentials:'same-origin',signal:request.signal,
      headers:{'Content-Type':'application/json','X-PiShelf-CSRF':getCsrfToken()},
      body:JSON.stringify({text:chunk,voice:selectedVoice})
     });
    }catch(error){
     if(request.signal.aborted||attempt===2)throw error;
     await speechRetryDelay(200*(attempt+1),request.signal);
     continue;
    }
    if(response.ok){
     let sentences=[];
     try{sentences=JSON.parse(response.headers.get('X-PiShelf-Sentences')||'[]');}
     catch{sentences=[];}
     return {blob:await response.blob(),sentences:Array.isArray(sentences)?sentences:[]};
    }
    if(![429,502,503,504].includes(response.status)||attempt===2)
     throw Error('Edge voice unavailable (HTTP '+response.status+').');
    await speechRetryDelay(200*(attempt+1),request.signal);
   }
   throw Error('Edge voice unavailable.');
  }finally{requests.delete(request);}
 }

 async function speakNext(session,preparedPage=null){
  if(!valid(session))return;
  let text;
  try{
   // Refresh page-specific PDF text/highlight mapping after navigation.
   text=await getText();
   if(preparedPage)text=preparedPage.text;
  }catch(error){if(valid(session)){stop();onState?.({error:error.message});}return;}
  if(!valid(session))return;
  const chunks=preparedPage?.chunks||splitSpeechChunks(text);
  if(!chunks.length){
   try{if(await next()&&valid(session))void speakNext(session);else if(valid(session))stop();}
   catch(error){if(valid(session)){stop();onState?.({error:error.message});}}
   return;
  }
  const normalized=normalizeSpeechText(text);
  let searchFrom=0;
  const offsets=chunks.map(chunk=>{
   const at=normalized.indexOf(chunk,searchFrom);
   if(at>=0)searchFrom=at+chunk.length;
   return Math.max(0,at);
  });
  let index=0,prefetch=preparedPage?.ready?Promise.resolve(preparedPage.ready):null,nextPagePrefetch=null;
  // Prepare at most one extra Edge clip at a time.
  async function prepare(chunk){
   if(!valid(session))return null;
   const {blob,sentences}=await requestSpeech(chunk,voice);
   if(!valid(session))return null;
   const url=URL.createObjectURL(blob),player=new Audio(url);
   player.preload='auto';player.load();
   const ready={url,player,sentences};prepared.add(ready);
   return ready;
  }
  function release(ready){
   if(!ready||!prepared.has(ready))return;
   ready.player.pause();ready.player.removeAttribute('src');ready.player.load();
   URL.revokeObjectURL(ready.url);prepared.delete(ready);
  }
  function preloadNextPage(){
   return Promise.resolve().then(()=>peekNextText()).then(async text=>{
    if(!valid(session)||typeof text!=='string'||!text.trim())return null;
    const chunks=splitSpeechChunks(text);
    if(!chunks.length)return null;
    const ready=await prepare(chunks[0]);
    return ready?{text,chunks,ready}:null;
   }).catch(()=>null);
  }
  async function say(){
   if(!valid(session))return;
   if(index>=chunks.length){
    try{
     if(await next()&&valid(session)){
      const nextReady=nextPagePrefetch?await nextPagePrefetch:null;
      if(valid(session))void speakNext(session,nextReady);
     }else if(valid(session))stop();
    }catch(error){if(valid(session)){stop();onState?.({error:error.message});}}
    return;
   }
   const chunk=chunks[index],chunkOffset=offsets[index];
   try{
    const ready=(prefetch?await prefetch:null)||await prepare(chunk);
    prefetch=null;
    if(!valid(session)){release(ready);return;}
    if(!ready)throw Error('Could not prepare speech audio.');
    index++;
    if(index<chunks.length)prefetch=prepare(chunks[index]).catch(()=>null);
    else nextPagePrefetch=preloadNextPage();
    const {player,url}=ready;
    const sentences=speechSentenceRanges(chunk,ready.sentences);
    audio=player;audioUrl=url;player.playbackRate=rate;
    let shown=-1;
    function updateSentence(){
     if(!valid(session))return;
     let which=0;
     if(sentences[0]?.time!=null){
      for(let i=1;i<sentences.length;i++){
       if(player.currentTime+0.04>=sentences[i].time)which=i;else break;
      }
     }else if(Number.isFinite(player.duration)&&player.duration>0){
      const position=Math.min(1,player.currentTime/player.duration)*chunk.length;
      for(let i=1;i<sentences.length;i++){
       if(position>=sentences[i].start)which=i;else break;
      }
     }
     if(which===shown)return;
     shown=which;
     const sentence=sentences[which];
     onState?.({
      spokenText:chunk,readingSentence:sentence.text,
      readingOffset:chunkOffset+sentence.start,readingLength:sentence.end-sentence.start,
      readingProgress:Number.isFinite(player.duration)&&player.duration>0?player.currentTime/player.duration:0
     });
    }
    updateSentence();
    player.ontimeupdate=updateSentence;
    player.onseeked=updateSentence;
    player.onended=()=>{
     if(audio===player){audio=null;audioUrl=null;}
     release(ready);
     if(valid(session))void say();
    };
    player.onerror=()=>{if(valid(session)){stop();onState?.({error:'Could not play Edge audio.'});}};
    await player.play();
    if(paused)player.pause();
   }catch(error){if(valid(session)){stop();onState?.({error:error.message});}}
  }
  void say();
 }

 function play(){
  if(active&&paused){if(audio)void audio.play();paused=false;notify();return;}
  if(active)return;
  active=true;paused=false;notify();void speakNext(++token);
 }
 function pause(){if(!active||paused)return;audio?.pause();paused=true;notify();}
 function seek(seconds){
  if(!active)return;
  if(audio&&Number.isFinite(audio.duration)){
   audio.currentTime=Math.max(0,Math.min(audio.duration-.05,audio.currentTime+seconds));
   return;
  }
  onState?.({error:'Wait for Edge audio to load before seeking.'});
 }
 function setRate(value){
  rate=Math.max(.5,Math.min(2,Number(value)||1));
  if(active){stop();play();}else notify();
 }
 function setVoice(value){
  voice=value;
  if(active){stop();play();}else notify();
 }
 return {play,pause,stop,seek,setRate,setVoice,get active(){return active;},get paused(){return paused;}};
}
