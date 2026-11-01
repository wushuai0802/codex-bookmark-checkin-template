import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {parseSyncPhaseLine,summarizeSyncPhases} from '../../tools/sync-phase-summary.mjs';

const scripts=fileURLToPath(new URL('../scripts/',import.meta.url));
const shells=process.platform==='win32'?['powershell.exe','pwsh.exe']:['pwsh'];
const quote=value=>"'"+value.replaceAll("'","''")+"'";
const marker='PRIVATE_HOST PRIVATE_USER PRIVATE_STDERR /private/path';
function fixture(t,mode='success'){
  const temporary=fileURLToPath(new URL('../../tmp/',import.meta.url));
  fs.mkdirSync(temporary,{recursive:true});
  const root=fs.mkdtempSync(path.join(temporary,'sync-timing-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  fs.mkdirSync(path.join(root,'scripts'));fs.mkdirSync(path.join(root,'outputs'));
  for(const file of ['sync-v2-status.ps1','Sync-PhaseTiming.ps1'])fs.copyFileSync(path.join(scripts,file),path.join(root,'scripts',file));
  fs.writeFileSync(path.join(root,'scripts/export-dashboard-status.mjs'),mode==='export-fail'?'process.exit(17);':
    `import fs from 'node:fs';fs.writeFileSync(${JSON.stringify(path.join(root,'outputs/dashboard-runtime.json'))},'{}');`);
  // Only this child's SSH boundary is faked. The parent's process/deadline and
  // the product status script, retry loop, journal and finally blocks are real.
  fs.writeFileSync(path.join(root,'scripts/Sync-Transport.ps1'),`
$script:fixtureUpload=0
function Invoke-BoundedSyncProcess([string]$Executable,[string[]]$Arguments,[string]$Phase,[string]$InputFile='',[int]$TimeoutSeconds=30){
  [IO.File]::AppendAllText(${quote(path.join(root,'calls.jsonl'))},(([ordered]@{phase=$Phase;timeout=$TimeoutSeconds;arguments=$Arguments}|ConvertTo-Json -Compress)+[Environment]::NewLine))
  if($Phase -eq 'status_upload'){
    $script:fixtureUpload++
    # Keep the fixture bounded if process-tree termination is unavailable.
    if('${mode}' -eq 'stall'){Start-Sleep -Seconds 8;[Environment]::Exit(0)}
    if('${mode}' -eq 'timeout'){return [pscustomobject]@{exitCode=124;failure='status_upload failed (exit=124; cause=connection_timeout)';timedOut=$true;error='${marker}'}}
    if('${mode}' -eq 'denied'){return [pscustomobject]@{exitCode=255;failure='status_upload failed (exit=255; cause=authentication_failed)';timedOut=$false;error='${marker}'}}
    if('${mode}' -eq 'retry' -and $script:fixtureUpload -eq 1){return [pscustomobject]@{exitCode=255;failure='status_upload failed (exit=255; cause=connection_interrupted)';timedOut=$false;error='${marker}'}}
  }
  return [pscustomobject]@{exitCode=0;failure=$null;timedOut=$false;output='${marker}';error='${marker}'}
}
`);
  return {root,status:path.join(root,'scripts/sync-v2-status.ps1'),record:path.join(root,'phases.log')};
}
function runCode(shell,code){
  const run=spawnSync(shell,['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(`$ErrorActionPreference='Stop'\n$ProgressPreference='SilentlyContinue'\n${code}`,'utf16le').toString('base64')],
    {encoding:'utf8',windowsHide:true,timeout:30000,maxBuffer:2*1024*1024});
  assert.equal(run.status,0,run.stderr||run.error?.message||run.stdout);
  return JSON.parse(run.stdout.trim().split(/\r?\n/).at(-1));
}
function phases(lines){
  for(const line of lines)assert.doesNotMatch(line,/PRIVATE_|\/private\/|fixture-host|volume3|\.ps1|\.json|[A-Z]:\\/);
  return lines.map(line=>{
    const parsed=parseSyncPhaseLine(/^\d{4}-/.test(line)?line:`2026-11-01 12:00:00 ${line}`);
    assert.ok(parsed,line);return parsed;
  });
}
function runParent(shell,f,{deadline=90,logFails=false}={}){
  return runCode(shell,`
. ${quote(path.join(scripts,'Sync-Transport.ps1'))}
. ${quote(path.join(scripts,'Sync-PhaseTiming.ps1'))}
$tokens=$null;$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile(${quote(path.join(scripts,'Sync-NasShadow.ps1'))},[ref]$tokens,[ref]$errors)
foreach($name in @('Write-Log','Invoke-BoundedDashboardStatusSync')){
  $definition=$ast.Find({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name},$true)
  . ([scriptblock]::Create($definition.Extent.Text))
}
$script:LogPath=${quote(path.join(f.root,'shadow-sync.log'))}
$script:fixtureShell=(Get-Command '${shell}').Source
function Get-Command { return [pscustomobject]@{Source=$script:fixtureShell} }
$script:realTransport=(Get-Item 'Function:Invoke-BoundedSyncProcess').ScriptBlock
$script:outerBudget=0
function Invoke-BoundedSyncProcess([string]$Executable,[string[]]$Arguments,[string]$Phase,[string]$InputFile,[int]$TimeoutSeconds){
  $script:outerBudget=$TimeoutSeconds
  & $script:realTransport $Executable $Arguments $Phase $InputFile ${deadline}
}
${logFails?"function Write-Log { throw 'fixture log write denied' }":''}
$failed=$false;$failure=''
try { Invoke-BoundedDashboardStatusSync ${quote(f.status)} 'fixture-host' '/volume3/docker/checkin-fixture/nas-data' ${quote(f.root)} ${quote(process.execPath)} }
catch { $failed=$true;$failure=$_.Exception.Message }
$logs=@();if(Test-Path -LiteralPath $script:LogPath){$logs=@([IO.File]::ReadAllLines($script:LogPath))}
[ordered]@{failed=$failed;failure=$failure;logs=$logs;outerBudget=$script:outerBudget;remaining=@(Get-ChildItem -LiteralPath ${quote(f.root)} -Filter 'status-phases-*.log').Count}|ConvertTo-Json -Compress -Depth 5
`);
}

for(const shell of shells){
  test(`status success journals each step and parent preserves SSH parameters (${shell})`,t=>{
    const f=fixture(t),result=runParent(shell,f),records=phases(result.logs);
    assert.equal(result.failed,false);assert.equal(result.remaining,0);assert.equal(result.outerBudget,90);
    assert.deepEqual(records.map(v=>v.name),['export','status_preflight','status_upload','status_install','cleanup','dashboard_status_sync']);
    assert.ok(records.every(v=>v.attempt===1&&v.exit===0&&!v.timedOut&&v.cause==='none'));
    const calls=fs.readFileSync(path.join(f.root,'calls.jsonl'),'utf8').trim().split(/\r?\n/).map(JSON.parse);
    assert.deepEqual(calls.map(v=>[v.phase,v.timeout]),[['status_preflight',15],['status_upload',15],['status_install',15],['status_cleanup',10]]);
    for(const call of calls)assert.deepEqual(call.arguments.slice(0,-1),['-T','-o','BatchMode=yes','-o','ConnectTimeout=15','-o','ServerAliveInterval=10','-o','ServerAliveCountMax=2','fixture-host']);
  });
  for(const mode of ['retry','timeout','denied','export-fail'])test(`parent retains completed status phases on ${mode} (${shell})`,t=>{
    const f=fixture(t,mode),result=runParent(shell,f),records=phases(result.logs);
    assert.equal(result.failed,mode!=='retry');assert.equal(result.remaining,0);assert.equal(result.outerBudget,90);
    if(mode==='export-fail'){
      assert.deepEqual(records.map(v=>v.name),['export','dashboard_status_sync']);assert.equal(records[0].exit,17);
      assert.equal(result.failure,'dashboard_status_sync failed (exit=1; cause=remote_command_failed)');return;
    }
    const uploads=records.filter(v=>v.name==='status_upload');
    assert.deepEqual(uploads.map(v=>v.attempt),mode==='denied'?[1]:[1,2]);
    assert.equal(records.at(-2).name,'cleanup');
    if(mode==='retry')assert.equal(uploads[1].exit,0);
    else {
      assert.equal(records.some(v=>v.name==='status_install'),false);
      assert.equal(result.failure,`dashboard_status_sync failed (exit=1; cause=${mode==='timeout'?'connection_timeout':'remote_command_failed'})`);
      assert.equal(uploads[0].cause,mode==='timeout'?'connection_timeout':'authentication_failed');
      assert.ok(uploads.every(v=>v.timedOut===(mode==='timeout')));
    }
  });
  test(`forced parent deadline retains the child's flushed records (${shell})`,t=>{
    const f=fixture(t,'stall'),result=runParent(shell,f,{deadline:3}),records=phases(result.logs);
    assert.equal(result.failed,true);assert.equal(result.failure,'dashboard_status_sync failed (exit=124; cause=connection_timeout)');
    assert.equal(result.outerBudget,90);assert.equal(result.remaining,0);
    assert.deepEqual(records.map(v=>v.name),['export','status_preflight','dashboard_status_sync']);
    assert.equal(records.at(-1).timedOut,true);assert.ok(records.at(-1).ms>=3000);
  });
  test(`journal and parent log write failures leave status success unchanged (${shell})`,t=>{
    const f=fixture(t);
    const run=spawnSync(shell,['-NoProfile','-NonInteractive','-File',f.status,'-SshTarget','fixture-host','-NasDataDir','/volume3/docker/checkin-fixture/nas-data','-NodePath',process.execPath,'-PhaseRecordFile',f.root],{encoding:'utf8',windowsHide:true,timeout:15000});
    assert.equal(run.status,0,run.stderr);assert.equal(fs.statSync(f.root).isDirectory(),true);
    assert.deepEqual(phases(run.stdout.trim().split(/\r?\n/).filter(v=>v.startsWith('Status sync phase:'))).map(v=>v.name),['export','status_preflight','status_upload','status_install','cleanup']);
    const result=runParent(shell,f,{logFails:true});assert.equal(result.failed,false);assert.equal(result.remaining,0);
  });
  test(`telemetry rejects private text and broken records without affecting the caller (${shell})`,t=>{
    const f=fixture(t),result=runCode(shell,`
. ${quote(path.join(scripts,'Sync-PhaseTiming.ps1'))}
$script:lines=@()
$result=[pscustomobject]@{exitCode=255;timedOut=$false;failure='status_upload failed (exit=255; cause=ssh_transport_failed) ${marker}';error='${marker}';output='${marker}'}
Write-SyncPhaseTiming 'Status sync phase' 'status_upload' 2 123 $result ${quote(f.record)} -Log {param($line) $script:lines+=@($line)}
Write-SyncPhaseTiming 'Status sync phase' '${marker}' 1 123 $result ${quote(f.record)}
[IO.File]::AppendAllText(${quote(f.record)},'${marker}'+[Environment]::NewLine+'Status sync phase: name=status_upload attempt=')
Receive-SyncPhaseTiming ${quote(f.record)} -Log {param($line) $script:lines+=@($line)}
ConvertTo-Json -InputObject $script:lines -Compress
`);
    assert.equal(result.length,2);assert.equal(result[0],result[1]);
    assert.equal(phases(result)[0].cause,'ssh_transport_failed');
  });
  test(`shadow attempts retain results, causes and retries when phase logging fails (${shell})`,()=>{
    const result=runCode(shell,`
. ${quote(path.join(scripts,'Sync-ShadowPublication.ps1'))}
$script:lines=@();$script:calls=0
function Write-Log([string]$Message){$script:lines+=@($Message)}
$results=@(foreach($phase in @('nas_snapshot_preflight','nas_snapshot_upload','nas_snapshot_extract','nas_commit','nas_snapshot_cleanup')){
  Invoke-ShadowPublicationCommand 'fixture' @() $phase '' 20 2 -Invoke {
    param($executable,$arguments,$name)
    if($name -eq 'nas_snapshot_upload'){$script:calls++;if($script:calls -eq 1){return [pscustomobject]@{exitCode=124;failure='nas_snapshot_upload failed (exit=124; cause=connection_timeout)';timedOut=$true;error='${marker}'}}}
    return [pscustomobject]@{exitCode=0;failure=$null;timedOut=$false;error='${marker}'}
  }
})
$lines=$script:lines
function Write-Log { throw 'fixture telemetry write failed' }
$denied=Invoke-ShadowPublicationCommand 'fixture' @() 'nas_commit' '' 30 2 -Invoke {return [pscustomobject]@{exitCode=255;failure='nas_commit failed (exit=255; cause=authentication_failed)';timedOut=$false}}
[ordered]@{lines=$lines;codes=@($results|ForEach-Object{$_.exitCode});denied=$denied}|ConvertTo-Json -Compress -Depth 5
`);
    const records=phases(result.lines);assert.deepEqual(result.codes,[0,0,0,0,0]);
    assert.deepEqual(records.map(v=>[v.name,v.attempt]),[['nas_snapshot_preflight',1],['nas_snapshot_upload',1],['nas_snapshot_upload',2],['nas_snapshot_extract',1],['nas_commit',1],['nas_snapshot_cleanup',1]]);
    assert.equal(records[1].timedOut,true);assert.equal(records[1].cause,'connection_timeout');
    assert.equal(result.denied.exitCode,255);assert.equal(result.denied.failure,'nas_commit failed (exit=255; cause=authentication_failed)');
  });
  test(`transport exposes elapsed time for all outcomes and distinguishes timeout text (${shell})`,t=>{
    const f=fixture(t),child=path.join(f.root,'child.cjs');
    fs.writeFileSync(child,"if(process.argv[2]==='stall')setTimeout(()=>{},4000);else if(process.argv[2]==='text'){process.stderr.write('timeout PRIVATE_STDERR');process.exit(255);}else process.exit(0);");
    const result=runCode(shell,`
. ${quote(path.join(scripts,'Sync-Transport.ps1'))}
$ok=Invoke-BoundedSyncProcess ${quote(process.execPath)} @(${quote(child)}) 'fixture' '' 10
$text=Invoke-BoundedSyncProcess ${quote(process.execPath)} @(${quote(child)},'text') 'fixture' '' 10
$killed=Invoke-BoundedSyncProcess ${quote(process.execPath)} @(${quote(child)},'stall') 'fixture' '' 1
$missing=Invoke-BoundedSyncProcess ${quote(path.join(f.root,'absent.exe'))} @() 'fixture' '' 10
$inputMissing=Invoke-BoundedSyncProcess ${quote(process.execPath)} @() 'fixture' ${quote(path.join(f.root,'absent.bin'))} 10
ConvertTo-Json -InputObject @($ok,$text,$killed,$missing,$inputMissing) -Compress
`);
    assert.deepEqual(result.map(v=>v.exitCode),[0,255,124,-1,-1]);
    assert.ok(result.every(v=>Number.isSafeInteger(v.elapsedMs)&&v.elapsedMs>=0));
    assert.ok(result[2].elapsedMs>=1000);assert.equal(result[1].timedOut,false);assert.equal(result[2].timedOut,true);
    for(const index of [1,2])assert.match(result[index].failure,/cause=connection_timeout\)/);
    assert.match(result[3].failure,/cause=executable_missing\)/);assert.match(result[4].failure,/cause=input_missing\)/);
  });
}

test('summary tolerates mixed formats and computes retry-inclusive statistics within N days',async()=>{
  const line=(stamp,ms,exit=0,timedOut='False')=>`${stamp} Status sync phase: name=status_upload attempt=1 ms=${ms} exit=${exit} timedOut=${timedOut} cause=${exit?'connection_timeout':'none'}`;
  const rows=[line('2026-11-01 10:00:00',100),line('2026-11-01 11:00:00',300,124,'True'),line('2026-11-01 11:30:00',200),
    line('2026-10-30 11:59:59',900),line('2026-11-01 12:00:01',900),'old dashboard_status_sync_timeout',
    line('2026-11-01 10:00:00',100).replace(' ms=100',''),line('2026-11-99 10:00:00',100),line('2026-11-01 10:00:00','99999999999999999'),
    '2026-11-01 10:00:00 Shadow phase: name=nas_commit attempt=1 ms=40 exit=0 timedOut=False cause=none',
    '2026-11-01 10:00:00 Shadow phase: name=nas_commit attempt=2 ms=80 exit=1 timedOut=False cause=remote_command_failed'];
  assert.deepEqual(await summarizeSyncPhases(rows,{days:2,now:new Date(2026,10,1,12)}),[
    {family:'Shadow phase',name:'nas_commit',failures:1,count:2,medianMs:60,maxMs:80},
    {family:'Status sync phase',name:'status_upload',failures:1,count:3,medianMs:200,maxMs:300}
  ]);
  assert.deepEqual(await summarizeSyncPhases(['old line','Status sync phase: name=export']),[]);
});

test('summary CLI reads only the named local log and handles invalid input without paths',t=>{
  const f=fixture(t),log=path.join(f.root,'shadow-sync.log'),cli=fileURLToPath(new URL('../../tools/sync-phase-summary.mjs',import.meta.url));
  const now=new Date(),stamp=[now.getFullYear(),String(now.getMonth()+1).padStart(2,'0'),String(now.getDate()).padStart(2,'0')].join('-')+' 00:00:00';
  fs.writeFileSync(log,`\uFEFF${stamp} Status sync phase: name=export attempt=1 ms=7 exit=0 timedOut=False cause=none\nold line\n`);
  const run=args=>spawnSync(process.execPath,[cli,...args],{encoding:'utf8',timeout:10000});
  const ok=run(['--log',log,'--days','1']);assert.equal(ok.status,0,ok.stderr);assert.equal(JSON.parse(ok.stdout).phases[0].count,1);
  assert.ok(fs.readFileSync(log,'utf8').endsWith('old line\n'));
  for(const args of [['--log',path.join(f.root,'PRIVATE_PATH')],['--log',log,'--days','0'],['--unknown']]){
    const bad=run(args);assert.equal(bad.status,1);assert.doesNotMatch(bad.stderr,/PRIVATE_PATH|sync-timing-|Error:|node:/);
  }
});
