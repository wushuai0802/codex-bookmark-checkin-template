import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {ptSupplementTarget,publicSupplementResult,runPtSupplement,ptRewardCounter} from '../src/pt-supplement.mjs';
import {ptPageEvidence} from '../src/browser.mjs';

function fixture(t){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'pt-site-fallback-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  for(const dir of ['config','data','browser'])fs.mkdirSync(path.join(root,dir));
  fs.writeFileSync(path.join(root,'browser/Local State'),'fixture');
  fs.writeFileSync(path.join(root,'config/config.json'),JSON.stringify({automationUserDataDir:path.join(root,'browser'),retryCount:3,failureScreenshots:true}));
  fs.writeFileSync(path.join(root,'config/qa-rules.json'),JSON.stringify({rules:[]}));
  fs.writeFileSync(path.join(root,'data/last-valid-bookmark-plan.json'),JSON.stringify({targets:[]}));
  const catalogFile=path.join(root,'catalog.json');
  fs.writeFileSync(catalogFile,JSON.stringify({sites:[{origin:'https://pt.example',entryUrl:'https://pt.example/attendance'}]}));
  const catalogHash=crypto.createHash('sha256').update(fs.readFileSync(catalogFile)).digest('hex');
  return {root,catalogFile,catalogHash,origin:'https://pt.example',now:new Date('2026-09-20T02:00:00Z')};
}

test('site target uses one exact HTTPS bookmark URL without account mapping',()=>{
  assert.deepEqual(ptSupplementTarget({sites:[{origin:'https://pt.example',entryUrl:'https://pt.example/attendance'}]},'https://pt.example').candidates,['https://pt.example/attendance']);
  for(const entryUrl of ['https://other.example/attendance','https://pt.example/attendance?passkey=x','http://pt.example/']){
    assert.throws(()=>ptSupplementTarget({sites:[{origin:'https://pt.example',entryUrl}]},'https://pt.example'),/unsafe/);
  }
});

test('PT page evidence needs explicit same-day completion, not cumulative rewards',()=>{
  const now=new Date('2026-09-20T02:00:00Z'),base={origin:'https://pt.example',url:'https://pt.example/attendance.php',status:'already_signed',now};
  assert.equal(ptPageEvidence({...base,bodyText:'鲸币 [使用] (签到已得350) 2026-09-20'}),null);
  assert.equal(ptPageEvidence({...base,bodyText:'2026-09-19 签到成功'}),null);
  assert.equal(ptPageEvidence({...base,bodyText:'2026-09-20\n昨日签到成功 2026-09-19'}),null);
  assert.equal(ptPageEvidence({...base,url:'https://other.example/',bodyText:'今日已签到'}),null);
  assert.equal(ptPageEvidence({...base,bodyText:'今日已签到'}).businessDate,'2026-09-20');
  assert.equal(ptPageEvidence({...base,bodyText:'2026-09-20 签到成功'}).source,'page_text');
  assert.equal(ptPageEvidence({...base,status:'signed',bodyText:'这是您的第159次签到，本次签到获得800个憨豆。'}).source,'page_text');
});

test('only a same-session increase in the PT reward counter verifies a supplement',async t=>{
  assert.equal(ptRewardCounter('鲸币 [使用]: 154,464.0 (签到已得350)'),350);
  assert.equal(ptRewardCounter('签到已得350 签到已得351'),null);
  const args=fixture(t),seen=[];
  const result=await runPtSupplement({...args,readReward:async()=>{const value=seen.length?360:350;seen.push(value);return value;},
    acquire:async()=>({owner:{nonce:'fixture'}}),release:async()=>{},
    launch:async()=>({close:async()=>{}}),runTarget:async()=>({status:'signed'})});
  assert.deepEqual(seen,[350,360]);assert.equal(result.status,'signed');assert.equal(result.evidence.authoritative,true);
  const noChange=await runPtSupplement({...args,readReward:async()=>350,
    acquire:async()=>({owner:{nonce:'fixture'}}),release:async()=>{},
    launch:async()=>({close:async()=>{}}),runTarget:async()=>({status:'already_signed'})});
  assert.equal(noChange.status,'unknown');
});

test('supplement holds the V1 lock and uses its browser flow once without altering daily plan',async t=>{
  const args=fixture(t),events=[];
  const result=await runPtSupplement({...args,
    acquire:async file=>{events.push('lock');assert.ok(file.endsWith(path.join('tmp','run.lock')));return {file};},
    release:async()=>{events.push('release');},
    launch:async config=>{events.push('launch');assert.equal(config.retryCount,0);assert.equal(config.failureScreenshots,false);assert.equal(config.capturePtEvidence,true);return {close:async()=>events.push('close')};},
    runTarget:async(_context,target)=>{events.push('execute');assert.deepEqual(target.candidates,['https://pt.example/attendance']);return {status:'already_signed',evidence:{source:'page_text',authoritative:true,confirmedAt:args.now.toISOString()}};}
  });
  assert.deepEqual(events,['lock','launch','execute','close','release']);
  assert.equal(result.status,'already_signed');assert.equal(result.evidence.authoritative,true);
  assert.equal(JSON.parse(fs.readFileSync(path.join(args.root,'data/last-valid-bookmark-plan.json'))).targets.length,0);
});

test('unverified completion and uncertain submission are never reported as success',()=>{
  const now=new Date('2026-09-20T02:00:00Z');
  assert.equal(publicSupplementResult('https://pt.example',{status:'signed'},now).status,'unknown');
  assert.equal(publicSupplementResult('https://pt.example',{status:'signed',evidence:{source:'page_text',authoritative:true,confirmedAt:'2026-09-19T02:00:00Z'}},now).status,'unknown');
  const uncertain=publicSupplementResult('https://pt.example',{status:'needs_attention',failureCode:'submission_outcome_unknown'},now);
  assert.equal(uncertain.status,'needs_attention');assert.equal(uncertain.submissionOutcomeUnknown,true);
});

test('catalog changes, daily owner and explicit disable stop before a browser launch',async t=>{
  const args=fixture(t),never=async()=>{throw Error('browser must not launch');};
  await assert.rejects(()=>runPtSupplement({...args,catalogHash:'0'.repeat(64),launch:never}),/changed/);
  fs.writeFileSync(path.join(args.root,'data/last-valid-bookmark-plan.json'),JSON.stringify({targets:[{origin:args.origin}]}));
  await assert.rejects(()=>runPtSupplement({...args,launch:never}),/daily plan/);
  fs.writeFileSync(path.join(args.root,'data/last-valid-bookmark-plan.json'),JSON.stringify({targets:[]}));
  const config=JSON.parse(fs.readFileSync(path.join(args.root,'config/config.json')));
  config.excludedOrigins=[args.origin];fs.writeFileSync(path.join(args.root,'config/config.json'),JSON.stringify(config));
  await assert.rejects(()=>runPtSupplement({...args,launch:never}),/disabled/);
});
