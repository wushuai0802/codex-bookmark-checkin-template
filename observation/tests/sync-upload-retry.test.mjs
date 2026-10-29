import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

for(const shell of process.platform==='win32'?['powershell.exe','pwsh.exe']:['pwsh'])test(`publication budgets a slow growing archive while keeping failures bounded (${shell})`,()=>{
  const source=fileURLToPath(new URL('../scripts/Sync-ShadowPublication.ps1',import.meta.url)).replaceAll("'","''");
  const code=String.raw`
$ErrorActionPreference='Stop'
. '${source}'
$small=Get-ShadowUploadTimeoutSeconds 784773
$large=Get-ShadowUploadTimeoutSeconds 2097152
$maximum=Get-ShadowUploadTimeoutSeconds 1073741824
$script:calls=0
$script:budgets=@()
$result=Invoke-ShadowPublicationCommand 'fixture' @() 'nas_snapshot_upload' 'fixture.bin' $small 2 -Invoke {
 param($executable,$arguments,$phase,$inputFile,$timeout)
 $script:calls++;$script:budgets+=@($timeout)
 if($script:calls -eq 1){return [pscustomobject]@{exitCode=124;failure='nas_snapshot_upload failed (exit=124; cause=connection_timeout)'}}
 return [pscustomobject]@{exitCode=0;failure=$null}
}
[ordered]@{small=$small;large=$large;maximum=$maximum;calls=$script:calls;budgets=$script:budgets;exitCode=$result.exitCode}|ConvertTo-Json -Compress
`;
  const value=JSON.parse(execFileSync(shell,['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(code,'utf16le').toString('base64')],{encoding:'utf8',timeout:15000}).trim());
  assert.ok(value.small>=90);assert.ok(value.large>value.small);assert.equal(value.maximum,180);
  assert.equal(value.calls,2);assert.deepEqual(value.budgets,[value.small,value.small]);assert.equal(value.exitCode,0);
});

for(const shell of process.platform==='win32'?['powershell.exe','pwsh.exe']:['pwsh'])test(`upload retries only transient transport failures and stops after recovery (${shell})`,()=>{
  const support=fileURLToPath(new URL('../scripts/Sync-OperationsSupport.ps1',import.meta.url)).replaceAll("'","''");
  const code=String.raw`
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
. '${support}'
function Write-SchedulerLog([string]$Message){}
$script:calls=0
$recovered=Invoke-SyncUploadWithRetry 'fixture' @() -RetryDelaySeconds 0 -Invoke {
  $script:calls++
  if($script:calls -lt 3){return [pscustomobject]@{exitCode=255;failure='nas_upload failed (exit=255; cause=connection_interrupted)'}}
  return [pscustomobject]@{exitCode=0;failure=$null}
}
$recoveryCalls=$script:calls
$script:calls=0
$persistent=Invoke-SyncUploadWithRetry 'fixture' @() -RetryDelaySeconds 0 -Invoke {
  $script:calls++;return [pscustomobject]@{exitCode=255;failure='nas_upload failed (exit=255; cause=connection_timeout)'}
}
$persistentCalls=$script:calls
$script:calls=0
$denied=Invoke-SyncUploadWithRetry 'fixture' @() -RetryDelaySeconds 0 -Invoke {
  $script:calls++;return [pscustomobject]@{exitCode=255;failure='nas_upload failed (exit=255; cause=authentication_failed)'}
}
[ordered]@{recovered=$recovered.exitCode;recoveryCalls=$recoveryCalls;persistent=$persistent.exitCode;persistentCalls=$persistentCalls;deniedCalls=$script:calls}|ConvertTo-Json -Compress
`;
  const output=execFileSync(shell,['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(code,'utf16le').toString('base64')],{encoding:'utf8',timeout:60000});
  assert.deepEqual(JSON.parse(output.trim()),{recovered:0,recoveryCalls:3,persistent:255,persistentCalls:3,deniedCalls:1});
});
