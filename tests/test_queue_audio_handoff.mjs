import assert from 'node:assert/strict';
import test from 'node:test';
import {createReadAloud} from '../static/read-aloud.js';

test('queued passages reuse one player and consume prefetched audio',async t=>{
 const clips=[],requests=[],players=[];
 class Player{
  constructor(){players.push(this);}
  async play(){clips.push(this.src);}
  pause(){}
  load(){}
  removeAttribute(){}
 }
 t.mock.method(globalThis,'fetch',async(_url,options)=>{
  requests.push(JSON.parse(options.body).text);
  return {ok:true,headers:new Headers(),blob:async()=>new Blob(['audio'])};
 });
 const original=globalThis.Audio;
 globalThis.Audio=Player;
 t.after(()=>{if(original)globalThis.Audio=original;else delete globalThis.Audio;});
 const passages=['First passage.','Second passage.'];let i=0;
 const tick=()=>new Promise(resolve=>setImmediate(resolve));
 const controller=createReadAloud({getText:()=>passages[i],next:()=>++i<passages.length,
  peekNextText:()=>passages[i+1]});
 controller.play();await tick();
 assert.deepEqual(requests,passages);
 players[0].onended();await tick();
 assert.equal(players.length,1);assert.equal(clips.length,2);
 assert.deepEqual(requests,passages);
 players[0].onended();await tick();
 assert.equal(controller.active,false);
});

test('selected passages share one track and report time left at playback speed',async t=>{
 const states=[],played=[],requests=[];
 let player;
 class Player{
  constructor(){player=this;}
  async play(){played.push(this.src);}
  pause(){}
  load(){}
  removeAttribute(){}
 }
 const original=globalThis.Audio;
 globalThis.Audio=Player;
 t.after(()=>{if(original)globalThis.Audio=original;else delete globalThis.Audio;});
 t.mock.method(globalThis,'fetch',async(_url,options)=>{
  requests.push(JSON.parse(options.body).text);
  return {ok:true,headers:new Headers(),blob:async()=>new Blob(['frames'])};
 });
 const controller=createReadAloud({onState:s=>states.push(s)});
 await controller.playSelection(['Passage one.','Passage two.']);
 assert.deepEqual(requests,['Passage one.','Passage two.']);
 assert.equal(played.length,1);
 player.duration=60;player.currentTime=34;player.ontimeupdate();
 assert.deepEqual(states.at(-1),{passage:1,remaining:26});
 controller.setRate(2);
 assert.deepEqual(states.at(-1),{passage:1,remaining:13});
 player.onended();assert.equal(controller.active,false);
});

test('preparation packs short paragraphs and keeps out-of-order responses in reading order',async t=>{
 const pending=[],calls=[];
 const original=globalThis.Audio;
 globalThis.Audio=class{async play(){} pause(){} removeAttribute(){} load(){}};
 t.after(()=>{if(original)globalThis.Audio=original;else delete globalThis.Audio;});
 t.mock.method(globalThis,'fetch',(_url,options)=>new Promise(resolve=>{
  const text=JSON.parse(options.body).text;
  calls.push(text);
  pending.push(()=>resolve({ok:true,headers:new Headers(),blob:async()=>new Blob([text])}));
 }));
 let track;
 t.mock.method(URL,'createObjectURL',blob=>{track=blob;return 'blob:test';});
 const controller=createReadAloud({});
 const playing=controller.playSelection(['First.\nSecond.','Third.','Fourth.']);
 assert.deepEqual(calls,['First.\nSecond.','Third.']);
 pending[1]();await new Promise(resolve=>setImmediate(resolve));
 assert.equal(calls[2],'Fourth.');
 pending[2]();pending[0]();await playing;
 assert.equal(await track.text(),'First.\nSecond.Third.Fourth.');
 controller.stop();
});

test('playback starts while the next speech request is still pending',async t=>{
 const pending=[],played=[];
 let player,started;
 const firstPlay=new Promise(resolve=>{started=resolve;});
 const original=globalThis.Audio;
 globalThis.Audio=class{
  constructor(){player=this;}
  async play(){played.push(this.src);started();}
  pause(){} removeAttribute(){} load(){}
 };
 t.after(()=>{if(original)globalThis.Audio=original;else delete globalThis.Audio;});
 t.mock.method(globalThis,'fetch',()=>new Promise(resolve=>pending.push(()=>
  resolve({ok:true,headers:new Headers(),blob:async()=>new Blob(['frames'])}))));
 const controller=createReadAloud({});
 const preparing=controller.playSelection(['First passage.','Second passage.']);
 pending[0]();await firstPlay;
 assert.equal(played.length,1);
 player.onended();
 pending[1]();await preparing;
 assert.equal(played.length,2);
 player.onended();assert.equal(controller.active,false);
});

test('selected countdown follows the media clock without duration metadata or timeupdate',async t=>{
 let player,pulse;
 const states=[],original=globalThis.Audio;
 globalThis.Audio=class{constructor(){player=this;this.duration=Infinity;this.currentTime=0;} async play(){} pause(){} load(){} removeAttribute(){}};
 t.after(()=>{if(original)globalThis.Audio=original;else delete globalThis.Audio;});
 t.mock.method(globalThis,'setInterval',fn=>{pulse=fn;return 1;});
 t.mock.method(globalThis,'fetch',async()=>({ok:true,headers:new Headers(),blob:async()=>new Blob([new Uint8Array(60000)])}));
 const controller=createReadAloud({onState:s=>states.push(s)});
 await controller.playSelection(['First passage.']);
 assert.equal(states.at(-1).remaining,10);
 assert.equal(states.at(-1).estimated,true);
 player.currentTime=3;pulse();assert.equal(states.at(-1).remaining,7);
 player.duration=9;pulse();assert.equal(states.at(-1).remaining,6);
 controller.stop();
});
