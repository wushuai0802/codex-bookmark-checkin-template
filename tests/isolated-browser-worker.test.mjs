import test from 'node:test';
import assert from 'node:assert/strict';
import {runIsolatedBrowserTask} from '../src/isolated-browser-worker.mjs';
import {prepareV1ProfileHandoff} from '../src/profile-handoff.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const task={origin:'https://fixture.example',accountKey:'acct7',accountId:'7',businessDate:'2026-09-09',planHash:'a'.repeat(64)};
const adapter={id:'new-api.execute.v1',origin:task.origin,capabilities:['identity','read_status','submit_once','verify','classify_error'],identity:async()=>({userId:'7',origin:task.origin}),read_status:async()=>({state:'already_done',evidence:{authoritative:true}}),submit_once:async()=>{throw Error('must not submit')},verify:async()=>({state:'confirmed',evidence:{authoritative:true}}),classify_error(){}};

test('isolated browser worker binds only dedicated offscreen profile', async()=>{
  let launched=null,closed=false;
  const result=await runIsolatedBrowserTask({task,adapterDefinition:adapter,profileDir:'D:/worker-data/account-7/chrome-user-data',dedicatedRoot:'D:/worker-data',executablePath:'C:/Chrome/chrome.exe',launchPersistentContext:async(profile,options)=>{launched={profile,options};return {pages:()=>[{url:'about:blank',goto:async()=>{}}],close:async()=>{closed=true}};}});
  assert.equal(result.task.phase,'already_done'); assert.equal(result.stage,'already_done'); assert.equal(result.worker.windowMode,'offscreen');
  assert.equal(launched.options.headless,false); assert.ok(launched.options.args.includes('--window-position=-32000,-32000')); assert.equal(closed,true);
});

test('worker rejects normal Chrome profile paths', async()=>{
  await assert.rejects(()=>runIsolatedBrowserTask({task,adapterDefinition:adapter,profileDir:'C:/Users/test/AppData/Local/Google/Chrome/User Data/Default',dedicatedRoot:'C:/Users/test',executablePath:'C:/Chrome/chrome.exe',launchPersistentContext:async()=>({close(){}})}),/forbidden/);
});

test('worker accepts an explicitly drained V1 profile handoff', async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'v1-handoff-worker-')),profile=path.join(root,'data','accounts','acct7','chrome-user-data');
  fs.mkdirSync(profile,{recursive:true});
  const handoff=prepareV1ProfileHandoff({v1Root:root,profileDir:profile,accountKey:'acct7',origin:task.origin});
  let selected;
  const result=await runIsolatedBrowserTask({task,adapterDefinition:adapter,profileDir:profile,profileMode:'v1_handoff',profileHandoff:handoff,executablePath:'C:/Chrome/chrome.exe',launchPersistentContext:async(p)=>{selected=p;return {pages:()=>[{url:'about:blank',goto:async()=>{}}],close(){}};}});
  assert.equal(result.stage,'already_done'); assert.equal(selected,profile);
});
