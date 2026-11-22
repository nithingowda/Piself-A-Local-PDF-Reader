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
