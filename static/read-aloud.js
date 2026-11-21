/* Local browser text-to-speech. No audio or document content is sent to PiShelf. */
export function createReadAloud({getText,next,onState}){
 const synth=window.speechSynthesis;
 let active=false,paused=false,token=0,voice='piper-alba',rate=1,utterance=null,audio=null,abort=null;
 const notify=()=>onState?.({active,paused,rate,voice});
 function stop(){++token;active=false;paused=false;utterance=null;abort?.abort();abort=null;if(audio){audio.pause();audio.src='';audio=null;}synth?.cancel();notify();}
 async function speakNext(t){
  if(!active||t!==token)return;
  let text='';
  try{text=String(await getText()||'').replace(/\s+/g,' ').trim();}
  catch(error){stop();onState?.({error:error.message});return;}
  if(!active||t!==token)return;
  if(!text){let more=false;try{more=await next();}catch{}if(more&&active&&t===token)return speakNext(t);stop();return;}
  // Short utterances avoid browser speech synthesis silently stopping on long pages.
  const chunks=(text.match(/[^.!?।！？]+[.!?।！？]*|[^.!?।！？]+$/g)||[text]).flatMap(sentence=>{const words=sentence.trim().split(/\s+/),parts=[];let part='';for(const word of words){if(part.length+word.length+1>240&&part){parts.push(part);part='';}part+=(part?' ':'')+word;}if(part)parts.push(part);return parts;});
  let index=0;
  async function say(){
   if(!active||t!==token)return;
   if(index>=chunks.length){Promise.resolve(next()).then(more=>{if(more&&active&&t===token)speakNext(t);else stop();}).catch(()=>stop());return;}
   const chunk=chunks[index++];
   if(voice==='piper-alba'){
    const request=new AbortController();abort=request;
    try{
     const response=await fetch('/api/tts/alba',{method:'POST',headers:{'Content-Type':'application/json'},credentials:'same-origin',body:JSON.stringify({text:chunk}),signal:request.signal});
     if(!response.ok)throw Error('Piper Alba unavailable');
     const blob=await response.blob();if(!active||t!==token)return;
     const url=URL.createObjectURL(blob);const player=new Audio(url);audio=player;player.playbackRate=rate;
     player.onended=()=>{URL.revokeObjectURL(url);audio=null;if(active&&t===token)void say();};
     player.onerror=()=>{URL.revokeObjectURL(url);stop();onState?.({error:'Could not play Piper audio.'});};
     await player.play();return;
    }catch(error){if(!active||t!==token)return;voice='';onState?.({error:'Piper Alba is not configured; using browser voice.'});}
   }
   const u=new SpeechSynthesisUtterance(chunk);
   utterance=u;u.rate=rate;
   const voices=synth.getVoices();const selected=voices.find(v=>v.voiceURI===voice)||(!voice?voices.find(v=>v.localService&&/premium|enhanced|natural|neural/i.test(v.name))||voices.find(v=>v.default)||null:null);if(selected){u.voice=selected;u.lang=selected.lang;}
   u.onend=()=>{if(active&&t===token)say();};
   u.onerror=e=>{if(e.error!=='interrupted'&&e.error!=='canceled')stop();};
   synth.speak(u);
  }
  say();
 }
 function play(){if(!synth){onState?.({error:'Speech synthesis is unavailable in this browser.'});return;}
  if(active&&paused){if(audio)void audio.play();else synth.resume();paused=false;notify();return;}
  if(active)return;
  active=true;paused=false;const t=++token;notify();void speakNext(t);
 }
 function pause(){if(!active||paused)return;if(audio)audio.pause();else synth.pause();paused=true;notify();}
 function setRate(value){rate=Math.max(.5,Math.min(2,Number(value)||1));if(active){stop();play();}else notify();}
 function setVoice(value){voice=value;if(active){stop();play();}else notify();}
 return {play,pause,stop,setRate,setVoice,get active(){return active;},get paused(){return paused;}};
}
