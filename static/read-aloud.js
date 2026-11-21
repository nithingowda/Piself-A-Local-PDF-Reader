/* Edge Neural TTS: one active audio clip, one prefetched clip, no local synthesis. */
const MAX_CHUNK_LENGTH=440; // Server accepts up to 500 characters per request.
const DEFAULT_VOICE='en-IN-NeerjaNeural';

// Preserve paragraph and heading boundaries before normalizing whitespace.
export function splitSpeechChunks(text){
 const paragraphs=String(text||'').split(/\n+/).map(line=>line.replace(/[ \t]+/g,' ').trim()).filter(Boolean);
 const chunks=[];
 // Combine sentences in the same paragraph into one synthesis request.
 // Short requests for every line/sentence create audible network pauses.
 for(const paragraph of paragraphs){
  const sentences=paragraph.match(/[^.!?।！？]+[.!?।！？]*|[^.!?।！？]+$/g)||[];
  let chunk='';
  for(const sentence of sentences){
   const words=sentence.trim().split(/\s+/);
   for(const word of words){
    if(!word)continue;
    if(chunk&&chunk.length+1+word.length>MAX_CHUNK_LENGTH){
     chunks.push(chunk);chunk='';
    }
    if(word.length>MAX_CHUNK_LENGTH){
     if(chunk){chunks.push(chunk);chunk='';}
     for(let i=0;i<word.length;i+=MAX_CHUNK_LENGTH)chunks.push(word.slice(i,i+MAX_CHUNK_LENGTH));
    }else chunk+=(chunk?' ':'')+word;
   }
  }
  if(chunk)chunks.push(chunk);
 }
 return chunks;
}

export function createReadAloud({getText,next,onState,getCsrfToken=()=>''}){
 let active=false,paused=false,token=0,voice=DEFAULT_VOICE,rate=1,audio=null,audioUrl=null;
 const requests=new Set(),prepared=new Set();
 const notify=()=>onState?.({active,paused,rate,voice});
 const valid=session=>active&&session===token;

 // Cancel current and prefetched network work and release decoded audio.
 function stop(){
  token++;active=false;paused=false;
  for(const request of requests)request.abort();
  requests.clear();
  for(const ready of prepared){ready.player.pause();ready.player.removeAttribute('src');ready.player.load();URL.revokeObjectURL(ready.url);}
  prepared.clear();
  if(audio){audio.pause();audio.removeAttribute('src');audio.load();audio=null;}
  if(audioUrl){URL.revokeObjectURL(audioUrl);audioUrl=null;}
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
   return await response.blob();
  }finally{requests.delete(request);}
 }

 async function speakNext(session){
  if(!valid(session))return;
  let text;
  try{text=await getText();}
  catch(error){if(valid(session)){stop();onState?.({error:error.message});}return;}
  if(!valid(session))return;
  const chunks=splitSpeechChunks(text);
  if(!chunks.length){
   try{if(await next()&&valid(session))void speakNext(session);else if(valid(session))stop();}
   catch(error){if(valid(session)){stop();onState?.({error:error.message});}}
   return;
  }

  let index=0,prefetch=null;
  // Prepare the next audio clip while the current one plays. At most one
  // extra clip and one Edge request are retained: low CPU/RAM on Raspberry Pi.
  async function prepare(chunk){
   const blob=await requestSpeech(chunk,voice);
   if(!valid(session))return null;
   const url=URL.createObjectURL(blob);
   const player=new Audio(url);
   player.preload='auto';player.load();
   const ready={url,player};prepared.add(ready);
   return ready;
  }
  function release(ready){
   if(!ready)return;
   ready.player.pause();
   ready.player.removeAttribute('src');
   ready.player.load();
   URL.revokeObjectURL(ready.url);
   prepared.delete(ready);
  }
  async function say(){
   if(!valid(session))return;
   if(index>=chunks.length){
    try{if(await next()&&valid(session))void speakNext(session);else if(valid(session))stop();}
    catch(error){if(valid(session)){stop();onState?.({error:error.message});}}
    return;
   }
   const chunk=chunks[index];
   try{
    const ready=(prefetch?await prefetch:null)||await prepare(chunk);
    prefetch=null;
    if(!valid(session)){release(ready);return;}
    if(!ready)throw Error('Could not prepare speech audio.');
    index++;
    // Begin buffering the next paragraph before current playback.
    if(index<chunks.length)prefetch=prepare(chunks[index]).catch(()=>null);
    const {player,url}=ready;
    audio=player;audioUrl=url;player.playbackRate=rate;
    onState?.({spokenText:chunk,readingProgress:0});
    player.ontimeupdate=()=>{
     if(valid(session)&&Number.isFinite(player.duration)&&player.duration>0)
      onState?.({readingProgress:Math.min(1,player.currentTime/player.duration),spokenText:chunk});
    };
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
