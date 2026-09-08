import test from 'node:test';
import assert from 'node:assert/strict';
import {observeAccount,validateReadRequest,readCapabilities} from '../src/readonly-adapters.mjs';
const now='2026-09-08T02:00:00Z',origin='https://fixture.example';
const self={status:200,body:{success:true,data:{id:7,username:'reader',access_token:'must-not-copy'}}};
async function run(statusResponse,extra={}){const calls=[];const r=await observeAccount({family:'new-api',origin,expectedId:'7',now,request:async(url,options)=>{calls.push({url,options});return url==='/api/user/self'?self:statusResponse;},...extra});return {r,calls};}
test('readonly capability denies writes, cross-origin redirects and submission endpoints',()=>{
 for(const endpoint of ['/api/user/checkin/captcha','/api/user/sign_in','https://other.example/api/user/self'])assert.throws(()=>validateReadRequest('new-api',origin,endpoint),/denied/);
 assert.throws(()=>validateReadRequest('new-api',origin,'/api/user/checkin','POST'),/denied/);
 assert.equal(readCapabilities('new-api').canSubmit,false);
});
test('exact identity and dated calendar yield sanitized success',async()=>{
 const {r,calls}=await run({status:200,body:{success:true,data:{stats:{checked_in_today:true,records:[{checkin_date:'2026-09-08',user_id:7,quota_awarded:0}]}}}});
 assert.equal(r.status,'signed');assert.equal(r.mutationCount,0);assert.equal(calls.length,2);assert.ok(calls.every(c=>c.options.method==='GET'));assert.doesNotMatch(JSON.stringify(r),/must-not-copy|access_token/);
});
test('missing identity stops before any request; mismatch stops before status endpoint',async()=>{
 assert.equal((await run(null,{expectedId:null})).calls.length,0);
 const {r,calls}=await run(null,{expectedId:'8'});assert.equal(r.cause,'identity_mismatch');assert.equal(calls.length,1);
});
test('calendar flag alone, wrong day, and wrong account never prove success',async()=>{
 for(const records of [[],[{checkin_date:'2026-09-07',quota_awarded:1}],[{checkin_date:'2026-09-08',user_id:8,quota_awarded:1}]]){
  const {r}=await run({status:200,body:{success:true,data:{stats:{checked_in_today:true,records}}}});assert.equal(r.status,'unknown');
 }
});
test('feature-disabled and explicit unsigned states stay separate',async()=>{
 assert.equal((await run({status:200,body:{success:true,data:{enabled:false}}})).r.status,'not_available');
 assert.equal((await run({status:200,body:{success:true,data:{stats:{checked_in_today:false,records:[]}}}})).r.status,'not_signed');
});
test('429, 401, 403 and 5xx have distinct causes without recovery loops',async()=>{
 for(const [status,cause]of [[429,'rate_limit'],[401,'login_required'],[403,'access_challenge'],[503,'upstream_unavailable']]){
  const {r,calls}=await run({status});assert.equal(r.cause,cause);assert.equal(calls.length,2);
 }
});
test('reward log requires amount, business day, expected user and matching event',async()=>{
 const items=[{created_at:Date.parse(now)/1000-5,type:1,user_id:7,content:'每日签到成功，增加额度 ＄25.000000 额度'}];
 const args={family:'reward-log',origin,expectedId:'7',rewardText:'每日签到成功',now,request:async url=>url==='/api/user/self'?self:{status:200,body:{success:true,data:{items}}}};
 assert.equal((await observeAccount(args)).status,'signed');items[0].user_id=8;assert.equal((await observeAccount(args)).status,'unknown');items[0].user_id=7;items[0].created_at-=86400;assert.equal((await observeAccount(args)).status,'unknown');
});
test('wheel cannot equate inability to spin with already signed',async()=>{
 const r=await observeAccount({family:'linuxdo-wheel',origin,expectedId:'7',now,request:async url=>({status:200,body:url.endsWith('/info')?{success:true,linux_do_id:7,username:'reader'}:{success:true,can_spin:false}})});
 assert.equal(r.status,'unknown');assert.equal(r.identity.idKind,'linuxdo');
});
test('wheel versioned spin_date proves the correct daily user record',async()=>{
 const args={family:'linuxdo-wheel',origin,expectedId:'7',now,request:async url=>({status:200,body:url.endsWith('/info')?{success:true,linux_do_id:7,username:'reader'}:{success:true,today_record:{spin_date:'2026-09-08',linux_do_id:7}}})};
 assert.equal((await observeAccount(args)).status,'signed');
});
test('active Vibe entitlement is not mislabeled as a newly performed sign-in',async()=>{
 const args={family:'vibe-entitlement',origin,expectedId:'7',now,request:async url=>({status:200,body:url.endsWith('getme')?{code:1,data:{id:7,name:'reader'}}:{code:1,data:{codex:{isAuth:true,subscriptions:{isActive:true,expireTime:'2026-09-09T00:00:00+08:00'}}}}})};
 const r=await observeAccount(args);assert.equal(r.status,'entitlement_active');assert.equal(r.evidence.dailyRewardVerified,false);
 assert.equal((await observeAccount({...args,now:'2026-09-10T00:00:00Z'})).cause,'entitlement_inactive_or_expired');
});
