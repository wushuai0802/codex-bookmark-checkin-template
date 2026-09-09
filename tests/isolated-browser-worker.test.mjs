import test from 'node:test';
import assert from 'node:assert/strict';
import {runIsolatedBrowserTask} from '../src/isolated-browser-worker.mjs';

const task={origin:'https://fixture.example',accountKey:'acct7',accountId:'7',businessDate:'2026-09-09',planHash:'a'.repeat(64)};
const adapter={id:'new-api.execute.v1',origin:task.origin,capabilities:['identity','read_status','submit_once','verify','classify_error'],identity:async()=>({userId:'7',origin:task.origin}),read_status:async()=>({state:'already_done',evidence:{authoritative:true}}),submit_once:async()=>{throw Error('must not submit')},verify:async()=>({state:'confirmed',evidence:{authoritative:true}}),classify_error(){}};

test('isolated browser worker binds only dedicated offscreen profile', async()=>{
  let launched=null,closed=false;
  const result=await runIsolatedBrowserTask({task,adapterDefinition:adapter,profileDir:'D:/worker-data/account-7/chrome-user-data',dedicatedRoot:'D:/worker-data',executablePath:'C:/Chrome/chrome.exe',launchPersistentContext:async(profile,options)=>{launched={profile,options};return {pages:()=>[{url:'about:blank'}],close:async()=>{closed=true}};}});
  assert.equal(result.task.phase,'status_read'); assert.equal(result.stage,'already_done'); assert.equal(result.worker.windowMode,'offscreen');
  assert.equal(launched.options.headless,false); assert.ok(launched.options.args.includes('--window-position=-32000,-32000')); assert.equal(closed,true);
});

test('worker rejects normal Chrome profile paths', async()=>{
  await assert.rejects(()=>runIsolatedBrowserTask({task,adapterDefinition:adapter,profileDir:'C:/Users/test/AppData/Local/Google/Chrome/User Data/Default',dedicatedRoot:'C:/Users/test',executablePath:'C:/Chrome/chrome.exe',launchPersistentContext:async()=>({close(){}})}),/forbidden/);
});
