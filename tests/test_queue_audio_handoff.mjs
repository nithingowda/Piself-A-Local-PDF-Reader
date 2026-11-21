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
