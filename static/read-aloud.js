/* Local browser text-to-speech. No audio or document content is sent to PiShelf. */
export function createReadAloud({getText,next,onState}){
 const synth=window.speechSynthesis;
 let active=false,paused=false,token=0,voice='',rate=1,utterance=null;
 const notify=()=>onState?.({active,paused,rate,voice});
 function stop(){++token;active=false;paused=false;utterance=null;synth?.cancel();notify();}
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
  function say(){
   if(!active||t!==token)return;
   if(index>=chunks.length){Promise.resolve(next()).then(more=>{if(more&&active&&t===token)speakNext(t);else stop();}).catch(()=>stop());return;}
   const u=new SpeechSynthesisUtterance(chunks[index++]);
   utterance=u;u.rate=rate;
   const voices=synth.getVoices();const selected=voices.find(v=>v.voiceURI===voice)||(!voice?voices.find(v=>v.localService&&/premium|enhanced|natural|neural/i.test(v.name))||voices.find(v=>v.default)||null:null);if(selected){u.voice=selected;u.lang=selected.lang;}
   u.onend=()=>{if(active&&t===token)say();};
   u.onerror=e=>{if(e.error!=='interrupted'&&e.error!=='canceled')stop();};
   synth.speak(u);
  }
  say();
 }
 function play(){if(!synth){onState?.({error:'Speech synthesis is unavailable in this browser.'});return;}
  if(active&&paused){synth.resume();paused=false;notify();return;}
  if(active)return;
  active=true;paused=false;const t=++token;notify();void speakNext(t);
 }
 function pause(){if(!active||paused)return;synth.pause();paused=true;notify();}
 function setRate(value){rate=Math.max(.5,Math.min(2,Number(value)||1));if(active){stop();play();}else notify();}
 function setVoice(value){voice=value;if(active){stop();play();}else notify();}
 return {play,pause,stop,setRate,setVoice,get active(){return active;},get paused(){return paused;}};
}
