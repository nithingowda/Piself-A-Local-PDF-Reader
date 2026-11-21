/* Piper TTS runs on the local PiShelf server; browser speech is a fallback. */
export function createReadAloud({getText,next,onState,getCsrfToken=()=>''}){
 const synth=window.speechSynthesis;
 let active=false,paused=false,token=0,voice='edge-neerja',rate=1,utterance=null,audio=null,abort=null,seekAudio=null;
 const notify=()=>onState?.({active,paused,rate,voice});
 function stop(){++token;active=false;paused=false;utterance=null;abort?.abort();abort=null;if(audio){audio.pause();audio.src='';audio=null;}seekAudio=null;synth?.cancel();notify();}
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
  async function requestSpeech(chunk){
   const request=new AbortController();abort=request;
   async function requestEndpoint(path){
    const response=await fetch(path,{method:'POST',headers:{'Content-Type':'application/json','X-PiShelf-CSRF':getCsrfToken()},credentials:'same-origin',body:JSON.stringify({text:chunk}),signal:request.signal});
    if(!response.ok)throw Error('Speech server HTTP '+response.status);
    return response.blob();
   }
   if(voice==='edge-neerja'){
    try{return await requestEndpoint('/api/tts/edge');}
    catch(error){
     if(request.signal.aborted)throw error;
     // Online provider may be blocked or offline. Preserve the same chunk with Piper.
     onState?.({notice:'Edge voice unavailable; using offline Piper Alba.'});
     return requestEndpoint('/api/tts/alba');
    }
   }
   return requestEndpoint('/api/tts/alba');
  }
  async function say(){
   if(!active||t!==token)return;
   if(index>=chunks.length){Promise.resolve(next()).then(more=>{if(more&&active&&t===token)void speakNext(t);else stop();}).catch(()=>stop());return;}
   const chunk=chunks[index];
   if(voice==='edge-neerja'||voice==='piper-alba'){
    try{
     const blob=(prefetch?await prefetch:null)||await requestSpeech(chunk);
     prefetch=null;
     if(!active||t!==token)return;
     index++;
     if(index<chunks.length)prefetch=requestSpeech(chunks[index]).catch(()=>null);
     onState?.({spokenText:chunk});
     const url=URL.createObjectURL(blob);const player=new Audio(url);audio=player;player.playbackRate=rate;
     player.onended=()=>{URL.revokeObjectURL(url);audio=null;if(active&&t===token)void say();};
     player.onerror=()=>{URL.revokeObjectURL(url);stop();onState?.({error:'Could not play speech audio.'});};
     await player.play();if(paused)player.pause();return;
    }catch(error){
     if(!active||t!==token)return;
     voice='';onState?.({notice:'Online and offline voices unavailable; using browser speech.'});
    }
   }
   index++;
   onState?.({spokenText:chunk});
   const u=new SpeechSynthesisUtterance(chunk);utterance=u;u.rate=rate;
   const voices=synth?.getVoices()||[];
   const selected=voices.find(v=>v.voiceURI===voice)||(!voice?voices.find(v=>v.default)||null:null);
   if(selected){u.voice=selected;u.lang=selected.lang;}
   u.onend=()=>{if(active&&t===token)void say();};
   u.onerror=e=>{if(e.error!=='interrupted'&&e.error!=='canceled')stop();};
   synth.speak(u);
  }
  void say();
 }
 function play(){if(!synth){onState?.({error:'Speech synthesis is unavailable in this browser.'});return;}
  if(active&&paused){if(audio)void audio.play();else synth.resume();paused=false;notify();return;}
  if(active)return;
  active=true;paused=false;const t=++token;notify();void speakNext(t);
 }
 function pause(){if(!active||paused)return;if(audio)audio.pause();else synth.pause();paused=true;notify();}
 function seek(seconds){
  if(!active)return;
  if(audio&&Number.isFinite(audio.duration)){
   const target=audio.currentTime+seconds;
   if(target>=0&&target<audio.duration){audio.currentTime=target;return;}
   if(target<0){audio.currentTime=0;return;}
   audio.currentTime=Math.max(0,audio.duration-.05);return;
  }
  // Browser SpeechSynthesis has no reliable time-based seek API.
  onState?.({error:'10-second seeking requires the Piper AI voice.'});
 }
 function setRate(value){rate=Math.max(.5,Math.min(2,Number(value)||1));if(active){stop();play();}else notify();}
 function setVoice(value){voice=value;if(active){stop();play();}else notify();}
 return {play,pause,stop,seek,setRate,setVoice,get active(){return active;},get paused(){return paused;}};
}
