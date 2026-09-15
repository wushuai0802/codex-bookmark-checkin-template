import test from 'node:test';
import assert from 'node:assert/strict';
import {dismissKnownAnnouncements,runIsolatedBrowserTask} from '../src/isolated-browser-worker.mjs';
import {prepareV1ProfileHandoff} from '../src/profile-handoff.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const task={origin:'https://fixture.example',accountKey:'acct7',accountId:'7',businessDate:'2026-09-09',planHash:'a'.repeat(64)};
const adapter={id:'new-api.execute.v1',origin:task.origin,capabilities:['identity','read_status','submit_once','verify','classify_error'],identity:async()=>({userId:'7',origin:task.origin}),read_status:async()=>({state:'already_done',evidence:{authoritative:true}}),submit_once:async()=>{throw Error('must not submit')},verify:async()=>({state:'confirmed',evidence:{authoritative:true}}),classify_error(){}};

test('worker dismisses only exact announcement actions',async()=>{
  const clicked=[];let visible=true;
  const buttons=new Map([['今日关闭',{count:async()=>visible?1:0,isVisible:async()=>visible,click:async()=>{clicked.push('今日关闭');visible=false}}],['今天关闭',{count:async()=>0}],['关闭公告',{count:async()=>0}]]);
  const result=await dismissKnownAnnouncements({getByRole:(_role,options)=>buttons.get(options.name)||{count:async()=>0}});
  assert.deepEqual(result,['今日关闭']);assert.deepEqual(clicked,['今日关闭']);
});

test('isolated browser worker binds only dedicated offscreen profile', async()=>{
  let launched=null,closed=false;
  const root='D:/worker-data', result=await runIsolatedBrowserTask({task,adapterDefinition:adapter,profileDir:'D:/worker-data/data/v2-profiles/acct7/chrome-user-data',dedicatedRoot:root,executablePath:'C:/Chrome/chrome.exe',launchPersistentContext:async(profile,options)=>{launched={profile,options};return {pages:()=>[{url:'about:blank',goto:async()=>{}}],close:async()=>{closed=true}};}});
  assert.equal(result.task.phase,'already_done'); assert.equal(result.stage,'already_done'); assert.equal(result.worker.windowMode,'offscreen');
  assert.equal(launched.options.headless,false); assert.ok(launched.options.args.includes('--window-position=-32000,-32000')); assert.equal(closed,true);
});

test('worker rejects normal Chrome profile paths', async()=>{
  await assert.rejects(()=>runIsolatedBrowserTask({task,adapterDefinition:adapter,profileDir:'C:/Users/test/AppData/Local/Google/Chrome/User Data/Default',dedicatedRoot:'C:/Users/test',executablePath:'C:/Chrome/chrome.exe',launchPersistentContext:async()=>({close(){}})}),/forbidden/);
});

test('worker rejects a profile bound to another V2 account', async()=>{
  await assert.rejects(()=>runIsolatedBrowserTask({task,adapterDefinition:adapter,profileDir:'D:/worker-data/data/v2-profiles/acct8/chrome-user-data',dedicatedRoot:'D:/worker-data',executablePath:'C:/Chrome/chrome.exe',launchPersistentContext:async()=>({close(){}})}),/not bound to its V2 account/);
});

test('worker accepts an explicitly drained V1 profile handoff', async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'v1-handoff-worker-')),profile=path.join(root,'data','accounts','acct7','chrome-user-data');
  fs.mkdirSync(profile,{recursive:true});
  const handoff=prepareV1ProfileHandoff({v1Root:root,profileDir:profile,accountKey:'acct7',origin:task.origin});
  let selected;
  const result=await runIsolatedBrowserTask({task,adapterDefinition:adapter,profileDir:profile,profileMode:'v1_handoff',profileHandoff:handoff,executablePath:'C:/Chrome/chrome.exe',launchPersistentContext:async(p)=>{selected=p;return {pages:()=>[{url:'about:blank',goto:async()=>{}}],close(){}};}});
  assert.equal(result.stage,'already_done'); assert.equal(selected,profile);
});

test('worker passes an explicitly configured captcha solver only to the isolated task',async()=>{
  let received=null;const localAdapter={...adapter,read_status:async({context})=>{received=typeof context.solveCaptcha;return {state:'already_done',evidence:{authoritative:true}};}};
  const solver=async()=>['KPT2C'];
  await runIsolatedBrowserTask({task,adapterDefinition:localAdapter,profileDir:'D:/worker-data/data/v2-profiles/acct7/solver-profile',dedicatedRoot:'D:/worker-data',executablePath:'C:/Chrome/chrome.exe',captchaSolver:solver,launchPersistentContext:async()=>({pages:()=>[{url:'about:blank',goto:async()=>{}}],close(){}})});
  assert.equal(received,'function');
});

test('worker prefers an existing page on the task origin over a stale popup page',async()=>{
  let selected=null;const pageAwareAdapter={...adapter,identity:async({context})=>{selected=context.page;return {userId:'7',origin:task.origin};}};
  const stale={url:()=> 'https://connect.linux.do/authorize',goto:async()=>{}};
  const target={url:()=> 'https://fixture.example/console',goto:async()=>{}};
  await runIsolatedBrowserTask({task,adapterDefinition:pageAwareAdapter,profileDir:'D:/worker-data/data/v2-profiles/acct7/multi-page',dedicatedRoot:'D:/worker-data',executablePath:'C:/Chrome/chrome.exe',launchPersistentContext:async()=>({pages:()=>[stale,target],close(){}})});
  assert.equal(selected,target);
});
