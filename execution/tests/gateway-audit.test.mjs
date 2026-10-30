import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync,execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const scripts=fileURLToPath(new URL('../scripts/',import.meta.url));
const q=s=>"'"+s.replaceAll("'","''")+"'";
function fixture(t){const root=fs.mkdtempSync(path.join(os.tmpdir(),'gateway-audit-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return root;}
test('a failure before controller log creation records only structured diagnostics',{skip:process.platform!=='win32'},t=>{
  const root=fixture(t);fs.mkdirSync(root+'/data');fs.mkdirSync(root+'/scripts');
  fs.writeFileSync(root+'/data/v2-integration.json',JSON.stringify({executionEngine:'v1',v2ProjectRoot:root,nodeExecutable:process.execPath}));
  fs.writeFileSync(root+'/scripts/run-v1-engine.mjs',"console.error(JSON.stringify({gatewayError:{code:'PT_CLEANUP_PENDING',stage:'pt_cleanup'},detail:'PRIVATE_FIXTURE_DETAIL'}));process.exitCode=1;");
  const command=`$ErrorActionPreference='Stop'; $root=${q(root)}; . ${q(path.join(scripts,'V2-EngineGateway.ps1'))}; Invoke-V2EngineGateway -Mode scheduled | Out-Null; exit $script:V2EngineExitCode`;
  const child=spawnSync('pwsh.exe',['-NoProfile','-NonInteractive','-Command',command],{encoding:'utf8',timeout:15000});
  assert.equal(child.status,1);const raw=fs.readFileSync(root+'/data/gateway-events.jsonl','utf8');
  const record=JSON.parse(raw.trim());assert.equal(record.errorCode,'PT_CLEANUP_PENDING');assert.equal(record.stage,'pt_cleanup');assert.equal(record.exitCode,1);
  assert.ok(Number.isFinite(Date.parse(record.time)));assert.doesNotMatch(raw,/PRIVATE_FIXTURE_DETAIL|v2-integration|run-v1-engine/);
  assert.match(child.stdout+child.stderr,/PRIVATE_FIXTURE_DETAIL/,'raw executor output still reaches the host');
});
test('local gateway exceptions are recorded and audit history rotates with bounded entries',{skip:process.platform!=='win32'},t=>{
  const root=fixture(t);fs.mkdirSync(root+'/data');fs.writeFileSync(root+'/data/v2-integration.json','invalid fixture');
  const code=`$ErrorActionPreference='Stop'; $root=${q(root)}; . ${q(path.join(scripts,'V2-EngineGateway.ps1'))}; try { Invoke-V2EngineGateway -Mode scheduled } catch { }; . ${q(path.join(scripts,'Gateway-Audit.ps1'))}; for($i=0;$i -lt 10;$i++){ Write-CheckinGatewayEvent -Root $root -Stage 'PRIVATE_FIXTURE_DETAIL' -Code 'PRIVATE_FIXTURE_DETAIL' -ExitCode 1 -MaxEntries 2 }`;
  execFileSync('pwsh.exe',['-NoProfile','-NonInteractive','-Command',code],{encoding:'utf8',timeout:15000});
  const files=fs.readdirSync(root+'/data').filter(v=>v.startsWith('gateway-events.jsonl'));assert.equal(files.length,4);
  for(const file of files){const raw=fs.readFileSync(root+'/data/'+file,'utf8');assert.ok(raw.trim().split('\n').length<=2);assert.doesNotMatch(raw,/PRIVATE_FIXTURE_DETAIL/);}
});
