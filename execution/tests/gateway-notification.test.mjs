import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync,spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const scripts=fileURLToPath(new URL('../scripts/',import.meta.url)),q=s=>"'"+s.replaceAll("'","''")+"'";
function fixture(t,mode='command'){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'gateway-notice-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  fs.mkdirSync(root+'/config');
  const adapter=root+'/adapter.cjs';fs.writeFileSync(adapter,"console.log(JSON.stringify({accepted:true}));");
  fs.writeFileSync(root+'/config/config.json',JSON.stringify({notification:{mode,taskId:'public_test',source:'test-suite',
    executable:process.execPath,arguments:[adapter],outboxMutexName:'Local\\GatewayFixture'+crypto.randomUUID()}}));
  return root;
}
function outcome(root,code,at,success=false){
  const script=`$ErrorActionPreference='Stop'; . ${q(path.join(scripts,'Gateway-Audit.ps1'))}; Update-CheckinGatewayHealth -Root ${q(root)} -Code ${q(code)} -Success $${success} -At ${q(at)} | ConvertTo-Json -Compress`;
  return JSON.parse(execFileSync('pwsh.exe',['-NoProfile','-NonInteractive','-Command',script],{encoding:'utf8',timeout:15000}));
}
function items(root){return fs.existsSync(root+'/data/notification-outbox')?fs.readdirSync(root+'/data/notification-outbox').filter(f=>f.endsWith('.json')).map(f=>JSON.parse(fs.readFileSync(root+'/data/notification-outbox/'+f))):[];}
test('scheduled blockage threshold, duplicate suppression and one recovery use the existing outbox',{skip:process.platform!=='win32'},t=>{
  const root=fixture(t),code='PT_CLEANUP_PENDING';
  outcome(root,code,'2026-10-30T00:05:00Z');assert.equal(items(root).length,0);
  outcome(root,code,'2026-10-30T00:35:00Z');assert.equal(items(root).length,1);
  const alert=items(root)[0];assert.equal(alert.status,'failed');assert.match(alert.summary,/PT_CLEANUP_PENDING/);assert.match(alert.summary,/08:05:00/);
  outcome(root,code,'2026-10-30T01:05:00Z');assert.equal(items(root).length,1);
  outcome(root,'GATEWAY_UNAVAILABLE','2026-10-30T01:35:00Z');assert.equal(items(root).length,1);
  outcome(root,'','2026-10-30T02:05:00Z',true);assert.equal(items(root).length,2);
  outcome(root,'','2026-10-30T02:35:00Z',true);assert.equal(items(root).length,2);
  const recovery=items(root).find(i=>i.status==='success');assert.match(recovery.summary,/PT_CLEANUP_PENDING/);assert.notEqual(alert.eventKey,recovery.eventKey);
  for(const item of items(root)){
    const material=[item.eventKey,item.taskId,item.name,item.source,item.status,item.summary].join('\n');
    assert.equal(item.payloadHash,crypto.createHash('sha256').update(material).digest('hex'));
    assert.doesNotMatch(item.summary,/https?:|[A-Z]:\\|Profile|PRIVATE_FIXTURE_DETAIL/);
  }
  const delivered=JSON.parse(execFileSync('pwsh.exe',['-NoProfile','-NonInteractive','-File',path.join(scripts,'Invoke-CheckinNotificationOutbox.ps1'),
    '-ConfigPath',root+'/config/config.json','-OutboxPath',root+'/data/notification-outbox','-ForceDue'],{encoding:'utf8',timeout:15000}));
  assert.equal(delivered.delivered,2);assert.equal(delivered.invalid,0);
  assert.ok(items(root).every(i=>i.delivered===true));
});
test('different codes reset the consecutive threshold and disabled notification stays disabled',{skip:process.platform!=='win32'},t=>{
  const root=fixture(t);
  outcome(root,'PT_CLEANUP_PENDING','2026-10-30T00:05:00Z');
  outcome(root,'GATEWAY_UNAVAILABLE','2026-10-30T00:35:00Z');assert.equal(items(root).length,0);
  outcome(root,'GATEWAY_UNAVAILABLE','2026-10-30T01:05:00Z');assert.equal(items(root).length,1);
  assert.match(items(root)[0].summary,/08:35:00/);
  const disabled=fixture(t,'none');
  outcome(disabled,'PT_CLEANUP_PENDING','2026-10-30T00:05:00Z');
  outcome(disabled,'PT_CLEANUP_PENDING','2026-10-30T00:35:00Z');
  outcome(disabled,'','2026-10-30T01:05:00Z',true);assert.equal(items(disabled).length,0);
});
test('only outer scheduled failures count; manual calls, lease re-entry and busy skips cannot announce recovery',{skip:process.platform!=='win32'},t=>{
  const root=fixture(t);fs.mkdirSync(root+'/data');fs.mkdirSync(root+'/scripts');
  fs.writeFileSync(root+'/data/v2-integration.json',JSON.stringify({executionEngine:'v1',v2ProjectRoot:root,nodeExecutable:process.execPath}));
  const cli=root+'/scripts/run-v1-engine.mjs';
  const failure=()=>fs.writeFileSync(cli,"console.error(JSON.stringify({gatewayError:{code:'PT_CLEANUP_PENDING',stage:'pt_cleanup'}}));process.exitCode=1;");
  const success=busy=>fs.writeFileSync(cli,`console.log(JSON.stringify({mode:'v2_v1_engine',exitCode:0,reason:${JSON.stringify(busy?'executor_busy':'no_new_final_report')}}));`);
  const invoke=(mode='scheduled',lease=false)=>{
    const command=`$ErrorActionPreference='Stop'; $root=${q(root)}; $env:CHECKIN_V2_ENGINE_LEASE=${lease?"'fixture'":"''"}; . ${q(path.join(scripts,'V2-EngineGateway.ps1'))}; try { Invoke-V2EngineGateway -Mode ${mode}|Out-Null; exit $script:V2EngineExitCode } catch { exit 1 }`;
    return spawnSync('pwsh.exe',['-NoProfile','-NonInteractive','-Command',command],{encoding:'utf8',timeout:15000}).status;
  };
  failure();assert.equal(invoke('execute'),1);assert.equal(fs.existsSync(root+'/data/gateway-health.json'),false);
  assert.equal(invoke(),1);assert.equal(items(root).length,0);
  assert.equal(invoke('scheduled',true),1);assert.equal(JSON.parse(fs.readFileSync(root+'/data/gateway-health.json')).streakCount,1);
  success(true);assert.equal(invoke(),0);assert.equal(JSON.parse(fs.readFileSync(root+'/data/gateway-health.json')).streakCount,1);
  failure();assert.equal(invoke(),1);assert.equal(items(root).length,1);
  success(true);assert.equal(invoke(),0);assert.equal(items(root).length,1);
  success(false);assert.equal(invoke(),0);assert.equal(items(root).length,2);
});
