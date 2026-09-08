import test from 'node:test';
import assert from 'node:assert/strict';
import { playMotion, stopMotion } from '../public/motion.mjs';

function surface() {
  const animations=[];
  return { animations, animate() {
    let resolve,reject;
    const finished=new Promise((yes,no)=>{resolve=yes;reject=no;});
    const animation={finished,complete:resolve,cancel:()=>reject(new Error('cancelled'))};
    animations.push(animation);return animation;
  }};
}
test('reopening cancels a pending exit and only the latest animation completes', async()=>{
  const node=surface(); const exit=playMotion(node,[]); const enter=playMotion(node,[]);
  node.animations[1].complete();
  assert.equal(await exit,false); assert.equal(await enter,true);
});
test('explicit cancellation prevents stale completion cleanup',async()=>{
  const node=surface(); const animation=playMotion(node,[]); stopMotion(node);
  assert.equal(await animation,false);
});
test('reduced motion finishes without creating an animation',async()=>{
  const original=globalThis.matchMedia; globalThis.matchMedia=()=>({matches:true});
  try{const node=surface();assert.equal(await playMotion(node,[]),true);assert.equal(node.animations.length,0);}
  finally{if(original)globalThis.matchMedia=original;else delete globalThis.matchMedia;}
});
