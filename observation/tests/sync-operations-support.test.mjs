import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const support=fileURLToPath(new URL('../scripts/Sync-OperationsSupport.ps1',import.meta.url));
const quote=value=>"'"+value.replaceAll("'","''")+"'";
for(const shell of ['powershell.exe','pwsh.exe'])test(`sync recovery, acknowledgements and SSH diagnostics (${shell})`,
  {skip:process.platform!=='win32'},t=>{
    const root=fs.mkdtempSync(path.join(os.tmpdir(),'fabric-sync-support-'));
    t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
    fs.mkdirSync(path.join(root,'config'));
    const seen=path.join(root,'seen.json'),notifier=path.join(root,'notifier.cjs');
    fs.writeFileSync(notifier,`require('fs').writeFileSync(${JSON.stringify(seen)},JSON.stringify(process.argv.slice(2))); console.log(JSON.stringify({accepted:true},null,2));`);
    fs.writeFileSync(path.join(root,'config/config.json'),JSON.stringify({notification:{mode:'command',executable:process.execPath,
      arguments:[notifier,'{status}']}}));
    fs.writeFileSync(path.join(root,'config/config.local.json'),JSON.stringify({notification:{
      arguments:[notifier,'{status}','{name}','{source}','{eventKey}','{summary}']}}));
    const stderrCode=text=>`process.stderr.write(String.fromCharCode(${[...text].map(char=>char.charCodeAt(0)).join(',')}))`;
    const script=String.raw`
$ErrorActionPreference='Stop'
. ${quote(support)}
function Assert-Sync([bool]$Condition,[string]$Message) { if(-not $Condition){throw $Message} }
function Write-SchedulerLog([string]$Message) { $script:lastLog=$Message }
$key='fabric-sync-recovered-existing'
Assert-Sync (Send-SyncNotification ${quote(root)} 'completed' 'V2 影子同步已恢复；v1 签到执行正常。' $key) 'real command acknowledgement failed'
$sent=Get-Content -Raw -Encoding UTF8 ${quote(seen)} | ConvertFrom-Json
Assert-Sync ($sent[0] -eq 'success' -and $sent[1] -eq '签到面板数据同步' -and $sent[2] -eq 'checkin-fabric') 'invalid public notification fields'
Assert-Sync ($sent[3] -eq $key -and $sent[4] -notmatch '(?i)\bV[12]\b') 'event key or old labels changed incorrectly'
Assert-Sync (Test-SyncNotificationAcknowledgement @('log prefix','{"accepted":false,"duplicate":true}') 0) 'duplicate acknowledgement lost'
Assert-Sync (-not (Test-SyncNotificationAcknowledgement @('{"accepted":true}') 2)) 'nonzero exit accepted'
Assert-Sync (-not (Test-SyncNotificationAcknowledgement @('{"accepted":"true"}') 0)) 'nonboolean acknowledgement accepted'
Assert-Sync (-not (Test-SyncNotificationAcknowledgement @('not JSON') 0)) 'missing acknowledgement accepted'
$invalidRejected=$false
try { Get-SyncNotificationValues 'unknown' 'summary' $key | Out-Null } catch { $invalidRejected=$true }
Assert-Sync $invalidRejected 'unsupported status was accepted'
$script:calls=@();$script:accept=$false
function Send-SyncNotification([string]$LegacyRoot,[string]$Status,[string]$Summary,[string]$EventKey) {
    $script:calls+=@([pscustomobject]@{status=$Status;key=$EventKey});return $script:accept
}
$now=[datetime]'2026-09-30T21:15:00+08:00'
$state=[ordered]@{failureCount=0;nextRetryAt=$null;lastSuccessAt='preserved';pendingNotification=[pscustomobject]@{
    status='completed';summary='V2 影子同步已恢复';eventKey=$key;queuedAt=$now.ToString('o');attemptCount=8;nextAttemptAt=$now.AddHours(4).ToString('o')}}
Assert-Sync (Invoke-PendingNotification $state 'unused' $now) 'legacy queue was not retried'
Assert-Sync ($script:calls.Count -eq 1 -and $script:calls[0].status -eq 'success' -and $script:calls[0].key -eq $key) 'migration or dedup key failed'
Assert-Sync ($state.pendingNotification.attemptCount -eq 1 -and [datetime]$state.pendingNotification.nextAttemptAt -eq $now.AddMinutes(5)) 'failed notification lost backoff'
Assert-Sync ($state.failureCount -eq 0 -and $null -eq $state.nextRetryAt -and $state.lastSuccessAt -eq 'preserved') 'notification changed sync retry state'
Assert-Sync (-not (Invoke-PendingNotification $state 'unused' $now.AddMinutes(1))) 'notification ignored backoff'
$script:accept=$true
Assert-Sync (Invoke-PendingNotification $state 'unused' $now.AddMinutes(5)) 'recovered notification was not acknowledged'
Assert-Sync ($null -eq $state.pendingNotification -and $script:calls.Count -eq 2) 'acknowledged notification still queued'
Assert-Sync (-not (Invoke-PendingNotification $state 'unused' $now.AddMinutes(10))) 'empty queue sent a duplicate'
$new=New-PendingNotification 'success' '面板数据同步已恢复' 'fabric-sync-recovered-new' $now
Assert-Sync ($new.status -eq 'success' -and $new.attemptCount -eq 0) 'new recovery payload is invalid'
$child=${quote(process.execPath)}
$failure=Invoke-SyncRemoteCommand $child @('-e',${quote(stderrCode('Connection timed out token=private-example')+';process.exit(255)')}) 'nas_commit'
Assert-Sync ($failure.exitCode -eq 255 -and $failure.failure -match 'cause=connection_timeout' -and $failure.failure -notmatch 'private-example') ('SSH diagnostic classification or redaction failed: '+($failure|ConvertTo-Json -Compress))
$success=Invoke-SyncRemoteCommand $child @('-e',${quote(stderrCode('warning only')+';process.exit(0)')}) 'nas_commit'
Assert-Sync ($success.exitCode -eq 0 -and $null -eq $success.failure) 'successful remote command misclassified'
$missing=Invoke-SyncRemoteCommand ${quote(path.join(root,'missing.exe'))} @() 'nas_commit'
Assert-Sync ($missing.exitCode -eq -1 -and $missing.failure -match 'executable_missing') 'missing executable treated as success'
'verified'
`;
    const scriptFile=path.join(root,'verify.ps1');fs.writeFileSync(scriptFile,'\uFEFF'+script);
    const result=spawnSync(shell,['-NoProfile','-NonInteractive','-File',scriptFile],{encoding:'utf8',timeout:60_000});
    assert.equal(result.status,0,result.stderr||result.stdout||result.error?.message);
    assert.match(result.stdout,/verified/);
  });
