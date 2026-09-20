import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');

test('one production gateway wraps both manual and scheduled execution',()=>{
  const manual=fs.readFileSync(path.join(root,'scripts/Run-Checkin.ps1'),'utf8');
  const scheduled=fs.readFileSync(path.join(root,'scripts/Start-UserScheduler.ps1'),'utf8');
  assert.match(manual,/Invoke-V2EngineGateway -Mode 'execute'/);
  assert.match(scheduled,/Invoke-V2EngineGateway -Mode 'scheduled'/);
  assert.doesNotMatch(scheduled,/Invoke-V2CanaryIfDue|StandaloneV2Canary/);
});

test('gateway rejects alternate execution configuration without a valid lease',t=>{
  if(process.platform!=='win32')return t.skip('Windows PowerShell gateway');
  const fixture=fs.mkdtempSync(path.join(os.tmpdir(),'fabric-gateway-'));
  t.after(()=>fs.rmSync(fixture,{recursive:true,force:true}));
  fs.mkdirSync(path.join(fixture,'data'));
  fs.writeFileSync(path.join(fixture,'data/v2-integration.json'),JSON.stringify({executionEngine:'v1',v2ProjectRoot:fixture,nodeExecutable:process.execPath}));
  const gateway=path.join(root,'scripts/V2-EngineGateway.ps1');
  const psPath=value=>value.replaceAll("'","''");
  const command=`$root='${psPath(fixture)}'; . '${psPath(gateway)}'; Invoke-V2EngineGateway -Mode execute -Parameters @{ConfigPath='${psPath(path.join(fixture,'other.json'))}'}`;
  const result=spawnSync('pwsh.exe',['-NoProfile','-NonInteractive','-Command',command],{encoding:'utf8',windowsHide:true,timeout:10000});
  assert.notEqual(result.status,0);
  assert.match(result.stderr,/Alternate configuration cannot execute outside the V2 controller/);
});
