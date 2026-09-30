import test from 'node:test';
import assert from 'node:assert/strict';
import {classifyVibeReadOnly,observePendingVibeClaim} from '../src/vibe-readonly.mjs';
const identity={code:1,data:{id:'123'}},now=new Date('2026-09-30T05:00:00Z');
test('expired and active Vibe subscriptions never become daily claim success',()=>{
  for(const isActive of [false,true]){
    const r=classifyVibeReadOnly(identity,{code:1,data:{codex:{subscriptions:{isActive,expireTime:'2026-09-19T00:00:00+08:00'}}}},now);
    assert.equal(r.evidence.authoritative,false);assert.equal(r.evidence.dailyRewardVerified,false);assert.equal(r.status,undefined);
    assert.equal(r.evidence.accountId,'123');
    if(!isActive)assert.match(r.reason,/2026-09-19.*过期/);
  }
  assert.equal(classifyVibeReadOnly({code:-1},null,now),null);
});
test('pending Vibe inspection blocks every write and strips quota secrets before leaving the page',async()=>{
  let route,closed=false;const actions=[];
  const result=await observePendingVibeClaim({}, {now:()=>now,launch:async config=>{
    assert.equal(config.ptPassiveReadOnly,true);
    return {route:async(_pattern,handler)=>{route=handler;},newPage:async()=>({goto:async()=>{},evaluate:async()=>({identity,
      quota:{code:1,data:{codex:{subscriptions:{isActive:false,expireTime:'2026-09-19T00:00:00+08:00'}}}}})}),close:async()=>{closed=true;}};
  }});
  for(const [method,url] of [['GET','https://new.sharedchat.cc/frontend-api/vibe-code/quota'],
    ['POST','https://new.sharedchat.cc/frontend-api/vibe-code/codex/claim'],['GET','https://new.sharedchat.cc/frontend-api/logout']])
    await route({request:()=>({method:()=>method,url:()=>url}),continue:()=>actions.push('read'),abort:()=>actions.push('blocked')});
  assert.deepEqual(actions,['read','blocked','blocked']);assert.equal(closed,true);assert.match(result.reason,/仍待核验/);
});
