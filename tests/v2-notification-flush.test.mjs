import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createDelivery} from '../src/notification-delivery.mjs';
import {flushV2Notifications} from '../src/v2-notification-flush.mjs';

function setup() {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'v2-notify-')),legacy=path.join(root,'legacy'),outputDir=path.join(root,'outputs');
  fs.mkdirSync(path.join(legacy,'config'),{recursive:true});fs.mkdirSync(outputDir,{recursive:true});
  fs.writeFileSync(path.join(legacy,'config','config.json'),JSON.stringify({notification:{mode:'command',executable:'fake-notifier'}}));
  return {root,legacy,outputDir};
}

test('V2 notification flush retries pending delivery without rerunning a check-in',async()=>{
  const {root,legacy,outputDir}=setup(),receipt={taskId:'task_123',businessDate:'2026-09-09',idempotencyKey:'idem_123',status:'signed',observedAt:'2026-09-09T00:00:00.000Z',evidence:{source:'v2_canary',summary:'V2 signed',redacted:true}},item=createDelivery(receipt,{now:'2026-09-09T00:00:00.000Z'});
  fs.writeFileSync(path.join(outputDir,`notification-${item.dedupeKey}.json`),JSON.stringify({...item,nextAttemptAt:'2026-09-09T00:00:00.000Z'}));let sent=0;
  const first=await flushV2Notifications({root,legacyRoot:legacy,now:new Date('2026-09-09T00:01:00.000Z'),sendCommand:async(_executable,args)=>{sent++;assert.equal(args[args.indexOf('--status')+1],'success');}});
  assert.equal(first.delivered,1);assert.equal(sent,1);assert.equal(JSON.parse(fs.readFileSync(path.join(outputDir,`notification-${item.dedupeKey}.json`),'utf8')).state,'delivered');
});

test('V2 notification flush leaves failed delivery pending with a bounded retry time',async()=>{
  const {root,legacy,outputDir}=setup(),receipt={taskId:'task_456',businessDate:'2026-09-09',idempotencyKey:'idem_456',status:'needs_attention',observedAt:'2026-09-09T00:00:00.000Z',evidence:{source:'v2_canary',summary:'V2 attention',redacted:true}},item=createDelivery(receipt,{now:'2026-09-09T00:00:00.000Z'});
  fs.writeFileSync(path.join(outputDir,`notification-${item.dedupeKey}.json`),JSON.stringify({...item,nextAttemptAt:'2026-09-09T00:00:00.000Z'}));
  const result=await flushV2Notifications({root,legacyRoot:legacy,now:new Date('2026-09-09T00:01:00.000Z'),sendCommand:async()=>{throw Error('offline');}}),saved=JSON.parse(fs.readFileSync(path.join(outputDir,`notification-${item.dedupeKey}.json`),'utf8'));
  assert.equal(result.pending,1);assert.equal(saved.state,'pending');assert.equal(saved.attempts,1);assert.equal(saved.nextAttemptAt,'2026-09-09T00:06:00.000Z');
});

test('delivered history cannot starve the oldest pending notification',async()=>{
  const {root,legacy,outputDir}=setup();
  for(let i=0;i<101;i++){
    const key=i.toString(16).padStart(24,'0');
    fs.writeFileSync(path.join(outputDir,`notification-notice_${key}.json`),JSON.stringify({state:'delivered',nextAttemptAt:'2026-09-08T00:00:00.000Z'}));
  }
  const item=createDelivery({taskId:'task_pending',businessDate:'2026-09-09',idempotencyKey:'idem_pending',status:'already_signed',observedAt:'2026-09-09T00:00:00.000Z',evidence:{summary:'pending delivery'}},{now:'2026-09-09T00:00:00.000Z'});
  fs.writeFileSync(path.join(outputDir,`notification-${item.dedupeKey}.json`),JSON.stringify(item));let calls=0;
  const result=await flushV2Notifications({root,legacyRoot:legacy,now:new Date('2026-09-09T00:01:00.000Z'),sendCommand:async(_exe,args)=>{calls++;assert.equal(args[args.indexOf('--status')+1],'already_done');}});
  assert.equal(calls,1);assert.equal(result.delivered,1);assert.equal(result.pending,0);
});
