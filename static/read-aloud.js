/* Edge Neural TTS: one active audio clip, one prefetched clip, no local synthesis. */
const MAX_CHUNK_LENGTH=440; // Server accepts up to 500 characters per request.
const DEFAULT_VOICE='en-IN-NeerjaNeural';

// Keep punctuation for the neural voice: it supplies cadence for commas,
// sentence endings, quotations and questions without inserting timed delays.
export function normalizeSpeechText(text){
 return String(text||'').normalize('NFC')
  .replace(/[\uFB00-\uFB06]/g,c=>({'ﬀ':'ff','ﬁ':'fi','ﬂ':'fl','ﬃ':'ffi','ﬄ':'ffl','ﬅ':'st','ﬆ':'st'}[c]))
  .replace(/[\u00ad\u200b\u2060\ufeff]/g,'') // PDF discretionary hyphens / invisible joins
  .replace(/\r\n?/g,'\n')
  .replace(/[\u00a0\u202f\u2007]/g,' ')
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
 let combined=false,clockTimer=null;
 let nativeUtterance=null;
 const isNative=()=>voice.startsWith('native:');
 async function nativeRead(session,passages=null){
  try{
   const synth=globalThis.speechSynthesis;
   if(!synth||!globalThis.SpeechSynthesisUtterance)throw Error('Native voices are unavailable in this browser.');
   let index=0;
   do{
    const text=passages?passages[index]:await getText();
    if(!valid(session))return;
    for(const chunk of splitSpeechChunks(text)){
     if(!valid(session))return;
     if(passages)onState?.({passage:index,remaining:Math.ceil(passages.slice(index).join(' ').split(/\s+/).length/2.5/rate),estimated:true});
     await new Promise((resolve,reject)=>{
      const u=new SpeechSynthesisUtterance(chunk);nativeUtterance=u;
      const selected=synth.getVoices().find(v=>'native:'+v.voiceURI===voice);
      if(selected){u.voice=selected;u.lang=selected.lang;}else u.lang='en-IN';
      u.rate=rate;u.onend=resolve;u.onerror=e=>reject(Error(e.error||'Native speech failed.'));
      synth.speak(u);if(paused)synth.pause();
     });
    }
    if(!valid(session))return;
    if(passages){if(++index>=passages.length)break;}else if(!await next())break;
   }while(valid(session));
   if(valid(session))stop();
  }catch(error){if(valid(session)){stop();onState?.({error:error.message});}}
 }
 function startNative(passages=null){active=true;paused=false;notify();void nativeRead(++token,passages);}

 const requests=new Set(),prepared=new Set();
 const notify=()=>onState?.({active,paused,rate,voice});
 const valid=session=>active&&session===token;

 // Cancel current and prefetched network work and release decoded audio.
 function stop(){
  if(combined){try{globalThis.navigator?.mediaSession?.setPositionState?.();}catch{}}
  clearInterval(clockTimer);clockTimer=null;
  token++;active=false;paused=false;combined=false;
  if(nativeUtterance){nativeUtterance=null;globalThis.speechSynthesis?.cancel();}
  for(const request of requests)request.abort();
  requests.clear();
  if(audio){
   audio.onloadedmetadata=audio.ondurationchange=audio.onended=audio.onerror=audio.ontimeupdate=audio.onseeked=null;
   audio.pause();audio.removeAttribute('src');audio.load();
  }
  for(const ready of prepared)URL.revokeObjectURL(ready.url);
  prepared.clear();audioUrl=null;
  notify();
 }

 async function requestSpeech(chunk,selectedVoice){
  const request=new AbortController();
  requests.add(request);
  try{
   const response=await fetch('/api/tts/edge',{
    method:'POST',credentials:'same-origin',signal:request.signal,
    headers:{'Content-Type':'application/json','X-PiShelf-CSRF':getCsrfToken()},
    body:JSON.stringify({text:chunk,voice:selectedVoice})
   });
   if(!response.ok)throw Error('Edge voice unavailable (HTTP '+response.status+').');
   let sentences=[];
   try{sentences=JSON.parse(response.headers.get('X-PiShelf-Sentences')||'[]');}
   catch{sentences=[];}
   return {blob:await response.blob(),sentences:Array.isArray(sentences)?sentences:[]};
  }finally{requests.delete(request);}
 }

 async function speakNext(session,preparedPage=null){
  if(!valid(session))return;
  let text;
  try{
   // Refresh page-specific PDF text/highlight mapping after navigation.
   text=await getText();
   if(preparedPage&&preparedPage.text!==text){
    release(preparedPage.ready);
    preparedPage=null;
   }
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
   const url=URL.createObjectURL(blob);
   const ready={url,sentences};prepared.add(ready);
   return ready;
  }
  function release(ready){
   if(!ready||!prepared.has(ready))return;
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
    if(!nextPagePrefetch&&index>=chunks.length-1)nextPagePrefetch=preloadNextPage();
    const {url}=ready;
    const player=audio;
    const sentences=speechSentenceRanges(chunk,ready.sentences);
    player.src=url;audioUrl=url;player.playbackRate=rate;
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
     if(!valid(session)||audioUrl!==url)return;
     player.onended=player.onerror=player.ontimeupdate=player.onseeked=null;
     audioUrl=null;
     release(ready);
     if(valid(session)){onState?.({clipEnded:true});void say();}
    };
    player.onerror=()=>{if(valid(session)){stop();onState?.({error:'Could not play Edge audio.'});}};
    if(!paused)await player.play();
   }catch(error){if(valid(session)){stop();onState?.({error:error.message});}}
  }
  void say();
 }

 async function playSelection(passages){
  if(active||!passages.length)return;
  if(isNative()){startNative(passages);return;}
  if(!audio){audio=new Audio();audio.preload='auto';}
  const session=++token,selectedVoice=voice;
  active=true;combined=true;paused=false;notify();
  onState?.({preparing:true});
  try{
   // Pack short paragraphs from the same passage into one synthesis request.
   const jobs=[],ends=[];
   for(const passage of passages){
    let phrase='';
    for(const chunk of splitSpeechChunks(passage)){
     if(phrase&&phrase.length+1+chunk.length>MAX_CHUNK_LENGTH){
      jobs.push(phrase);phrase='';
     }
     phrase=phrase?phrase+'\n'+chunk:chunk;
    }
    if(phrase)jobs.push(phrase);
    ends.push(jobs.length);
   }
   const clips=new Array(jobs.length);
   if(!jobs.length)throw Error('The selection has no speech audio.');
   const offsets=[0];
   const wordCounts=jobs.map(text=>text.trim().split(/\s+/).length);
   const totalWords=wordCounts.reduce((sum,n)=>sum+n,0);
   let cursor=0,nextClip=0,playing=false,scheduled=false,readyWords=0;
   function fail(error){
    if(valid(session)){stop();onState?.({error:error.message});}
   }
   async function playReady(){
    if(!valid(session)||playing||!clips[nextClip])return;
    playing=true;
    // Play each independently encoded MP3 from its beginning. Byte-based
    // seeking into concatenated MP3s can skip speech at clip boundaries.
    const first=nextClip++;
    const clip=clips[first];
    const bytes=clip.size;
    const url=URL.createObjectURL(clip);
    const ready={url};prepared.add(ready);audioUrl=url;
    const update=()=>{
     if(!valid(session)||audioUrl!==url)return;
     const measured=Number.isFinite(audio.duration)&&audio.duration>0;
     // Edge serves 48-kbit/s MP3. Use its byte rate while duration is unknown.
     const bytesPerSecond=measured?bytes/audio.duration:6000;
     const position=offsets[first]+bytesPerSecond*(audio.currentTime||0);
     const complete=offsets.length===jobs.length+1;
     const size=complete?offsets.at(-1):offsets.at(-1)*totalWords/readyWords;
     try{
      globalThis.navigator?.mediaSession?.setPositionState?.({
       duration:size/bytesPerSecond,position:Math.min(size,position)/bytesPerSecond,playbackRate:rate
      });
     }catch{/* Native position reporting is optional. */}
     const index=ends.findIndex(end=>offsets[end]===undefined||offsets[end]>position);
     onState?.({passage:index<0?ends.length-1:index,
      ...(!(complete&&measured)&&{estimated:true}),remaining:Math.ceil(Math.max(0,size-position)/bytesPerSecond/rate)});
    };
    audio.ondurationchange=audio.ontimeupdate=audio.onseeked=update;
    audio.onloadedmetadata=()=>{
     if(!valid(session)||audioUrl!==url)return;
     update();
    };
    audio.onended=()=>{
     if(!valid(session)||audioUrl!==url)return;
     clearInterval(clockTimer);clockTimer=null;
     audioUrl=null;playing=false;
     URL.revokeObjectURL(url);prepared.delete(ready);
     clips[first]=null;
     if(nextClip===jobs.length)stop();
     else void playReady().catch(fail);
    };
    audio.onerror=()=>fail(Error('Could not play the selected audio.'));
    audio.src=url;audio.playbackRate=rate;
    update();
    clockTimer=setInterval(()=>{if(!paused)update();},1000);
    if(!paused)await audio.play();
   }
   async function synthesize(){
    while(valid(session)&&cursor<jobs.length){
     const index=cursor++;
     const {blob}=await requestSpeech(jobs[index],selectedVoice);
     if(!valid(session))return;
     clips[index]=blob;
     while(clips[offsets.length-1]){
      const i=offsets.length-1;
      offsets.push(offsets[i]+clips[i].size);readyWords+=wordCounts[i];
     }
     if(!playing&&!scheduled&&clips[nextClip]){
      scheduled=true;
      setTimeout(()=>{scheduled=false;void playReady().catch(fail);},0);
     }
    }
   }
   await Promise.all([synthesize(),synthesize()]);
   await playReady();
  }catch(error){if(valid(session)){stop();onState?.({error:error.message});}}
 }
 function play(){
  if(isNative()){if(active&&paused){paused=false;globalThis.speechSynthesis?.resume();notify();}else if(!active)startNative();return;}
  if(active&&paused){if(audioUrl)void audio.play().catch(error=>onState?.({error:error.message}));paused=false;notify();return;}
  if(active)return;
  if(!audio){audio=new Audio();audio.preload='auto';}
  active=true;paused=false;notify();void speakNext(++token);
 }
 function pause(){if(!active||paused)return;if(isNative())globalThis.speechSynthesis?.pause();else audio?.pause();paused=true;notify();}
 function seek(seconds){
  if(!active)return;
  if(isNative()){onState?.({notice:'Native voices do not support time-based seeking.'});return;}
  if(audio&&Number.isFinite(audio.duration)){
   audio.currentTime=Math.max(0,Math.min(audio.duration-.05,audio.currentTime+seconds));
   return;
  }
  onState?.({error:'Wait for Edge audio to load before seeking.'});
 }
 function setRate(value){
  rate=Math.max(.5,Math.min(2,Number(value)||1));
  if(isNative()){notify();return;}
  if(combined){audio.playbackRate=rate;audio.ontimeupdate?.();}
  else if(active){stop();play();}else notify();
 }
 function setVoice(value){
  if(value!==voice&&active&&(isNative()||value.startsWith('native:')))stop();
  voice=value;
  if(combined)return;
  if(active){stop();play();}else notify();
 }
 return {play,playSelection,pause,stop,seek,setRate,setVoice,get active(){return active;},get paused(){return paused;}};
}
