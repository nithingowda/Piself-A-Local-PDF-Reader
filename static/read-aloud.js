/* Online Edge Neural TTS reader with bounded prefetch and progress reporting. */
export function createReadAloud({getText,next,onState,getCsrfToken=()=>''}){
 
 let active=false,paused=false,token=0,voice='en-IN-NeerjaNeural',rate=1,audio=null,abort=null,seekAudio=null;
 const notify=()=>onState?.({active,paused,rate,voice});
 function stop(){++token;active=false;paused=false;abort?.abort();abort=null;if(audio){audio.pause();audio.src='';audio=null;}seekAudio=null;notify();}
 async function speakNext(t){
  if(!active||t!==token)return;
  let text='';
  try{text=String(await getText()||'').replace(/\s+/g,' ').trim();}
  catch(error){stop();onState?.({error:error.message});return;}
  if(!active||t!==token)return;
  if(!text){let more=false;try{more=await next();}catch{}if(more&&active&&t===token)return speakNext(t);stop();return;}
  // Short utterances avoid browser speech synthesis silently stopping on long pages.
  const chunks=(text.match(/[^.!?।！？]+[.!?।！？]*|[^.!?।！？]+$/g)||[text]).flatMap(sentence=>{const words=sentence.trim().split(/\s+/),parts=[];let part='';for(const word of words){if(part.length+word.length+1>240&&part){parts.push(part);part='';}part+=(part?' ':'')+word;}if(part)parts.push(part);return parts;});
  let index=0,prefetch=null;
  async function requestSpeech(chunk,selectedVoice){
   const request=new AbortController();abort=request;
   const response=await fetch('/api/tts/edge',{method:'POST',headers:{'Content-Type':'application/json','X-PiShelf-CSRF':getCsrfToken()},credentials:'same-origin',body:JSON.stringify({text:chunk,voice:selectedVoice}),signal:request.signal});
   if(!response.ok)throw Error('Edge voice unavailable (HTTP '+response.status+').');
   return response.blob();
  }
  async function say(){
   if(!active||t!==token)return;
   if(index>=chunks.length){Promise.resolve(next()).then(more=>{if(more&&active&&t===token)void speakNext(t);else stop();}).catch(()=>stop());return;}
   const chunk=chunks[index],selectedVoice=voice;
   try{
    const blob=(prefetch?await prefetch:null)||await requestSpeech(chunk,selectedVoice);
    prefetch=null;
    if(!active||t!==token)return;
    index++;
    if(index<chunks.length)prefetch=requestSpeech(chunks[index],selectedVoice).catch(()=>null);
    onState?.({spokenText:chunk,readingProgress:0});
    const url=URL.createObjectURL(blob),player=new Audio(url);audio=player;player.playbackRate=rate;
    player.ontimeupdate=()=>{if(active&&t===token&&Number.isFinite(player.duration)&&player.duration>0)onState?.({readingProgress:Math.min(1,player.currentTime/player.duration),spokenText:chunk});};
    player.onended=()=>{URL.revokeObjectURL(url);audio=null;if(active&&t===token)void say();};
    player.onerror=()=>{URL.revokeObjectURL(url);stop();onState?.({error:'Could not play Edge audio.'});};
    await player.play();if(paused)player.pause();
   }catch(error){if(!active||t!==token)return;stop();onState?.({error:error.message});}
  }
  void say();
 }
 function play(){if(active&&paused){if(audio)void audio.play();paused=false;notify();return;}
  if(active)return;
  active=true;paused=false;const t=++token;notify();void speakNext(t);
 }
 function pause(){if(!active||paused)return;if(audio)audio.pause();paused=true;notify();}
 function seek(seconds){
  if(!active)return;
  if(audio&&Number.isFinite(audio.duration)){
   const target=audio.currentTime+seconds;
   if(target>=0&&target<audio.duration){audio.currentTime=target;return;}
   if(target<0){audio.currentTime=0;return;}
   audio.currentTime=Math.max(0,audio.duration-.05);return;
  }
  // Browser SpeechSynthesis has no reliable time-based seek API.
  onState?.({error:'Wait for Edge audio to load before seeking.'});
 }
 function setRate(value){rate=Math.max(.5,Math.min(2,Number(value)||1));if(active){stop();play();}else notify();}
 function setVoice(value){voice=value;if(active){stop();play();}else notify();}
 return {play,pause,stop,seek,setRate,setVoice,get active(){return active;},get paused(){return paused;}};
}
