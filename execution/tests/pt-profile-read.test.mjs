import assert from 'node:assert/strict';
import test from 'node:test';
import {readOurbitsProfile} from '../src/pt-profile-read.mjs';

for(const changedIdentity of [false,true])test(`Ourbits proof reads only the current user's profile (${changedIdentity})`,async()=>{
  const calls=[],now=new Date('2026-10-01T08:00:00Z');
  const context={route:async()=>{},request:{get:async(url,options)=>{
    calls.push({url,options});return {status:()=>200,url:()=>url,headers:()=>({date:now.toUTCString()}),text:async()=> 'fixture'};
  }}};
  const result=await readOurbitsProfile(context,{origin:'https://ourbits.club',now,
    extractHeader:async(_html,url)=>({logout:true,userIds:[url.includes('userdetails')&&changedIdentity?'2':'1'],
      text:url.includes('userdetails')?'Magic (签到已得140)':'Magic'})});
  assert.deepEqual(calls.map(c=>c.url),['https://ourbits.club/index.php','https://ourbits.club/userdetails.php?id=1']);
  assert.ok(calls.every(c=>c.options.maxRedirects===0));
  assert.equal(result.status,changedIdentity?'unknown':'already_signed');
  assert.equal(result.submissionAttempted,false);
  if(!changedIdentity)assert.equal(result.evidence.businessDate,'2026-10-01');
});

test('ambiguous, historical and previous-day headers cannot prove completion',async()=>{
  const now=new Date('2026-10-01T08:00:00Z');
  for(const {ids,text,date} of [
    {ids:['1','2'],text:'签到已得140',date:now},
    {ids:['1'],text:'昨日签到已得140',date:now},
    {ids:['1'],text:'(签到已得140)',date:new Date('2026-09-30T08:00:00Z')}
  ]){
    const context={route:async()=>{},request:{get:async url=>({status:()=>200,url:()=>url,headers:()=>({date:date.toUTCString()}),text:async()=> 'fixture'})}};
    const result=await readOurbitsProfile(context,{origin:'https://ourbits.club',now,extractHeader:async()=>({logout:true,userIds:ids,text})});
    assert.equal(result.status,'unknown');assert.equal(result.evidence,undefined);
  }
});
