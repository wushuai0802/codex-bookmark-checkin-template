import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync,spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const publication=fileURLToPath(new URL('../scripts/Sync-ShadowPublication.ps1',import.meta.url));
const transport=fileURLToPath(new URL('../scripts/Sync-Transport.ps1',import.meta.url));
const quote=value=>"'"+value.replaceAll("'","''")+"'";
const hash=value=>createHash('sha256').update(value).digest('hex');
const shells=process.platform==='win32'?['powershell.exe','pwsh.exe']:['pwsh'];
const project='/volume3/docker/checkin-fixture',transaction='a'.repeat(32);
const stage=`${project}/.shadow-sync-stage-${transaction}`,data=`${project}/nas-data`;
const names=['shadow-ledger.jsonl','shadow-beta-snapshot.json','dashboard-generation.json'];
const ledger=Buffer.from('{"fixture":"旧记录"}\r\n{"fixture":"new"}\n');
const prefix=ledger.subarray(0,11);
const runPowerShell=(shell,code)=>JSON.parse(execFileSync(shell,['-NoProfile','-NonInteractive','-EncodedCommand',
  Buffer.from(`$ErrorActionPreference='Stop'\n$ProgressPreference='SilentlyContinue'\n. ${quote(publication)}\n${code}`,'utf16le').toString('base64')],
{encoding:'utf8',timeout:90000,maxBuffer:4*1024*1024}).trim());
function fixture(t){
  const temporary=fileURLToPath(new URL('../../tmp/',import.meta.url));
  fs.mkdirSync(temporary,{recursive:true});
  const root=fs.mkdtempSync(path.join(temporary,'shadow-publication-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  return root;
}

for(const shell of shells)test(`ledger prefix selection and real tar payloads (${shell})`,t=>{
  const root=fixture(t),file=path.join(root,'shadow-ledger.jsonl');
  const large=Buffer.alloc(131077,0x61),largePrefix=large.subarray(0,65537);
  fs.writeFileSync(file,ledger);
  fs.writeFileSync(path.join(root,'large.jsonl'),large);
  fs.writeFileSync(path.join(root,names[1]),'{"snapshot":"fixture"}');
  fs.writeFileSync(path.join(root,names[2]),'{"generation":"fixture"}');
  const result=runPowerShell(shell,`
$file=${quote(file)}
$prefix=Get-ShadowLedgerTransfer $file ([pscustomobject]@{exitCode=0;output='shadow-ledger-v1 ${prefix.length} ${hash(prefix)}'})
$same=Get-ShadowLedgerTransfer $file ([pscustomobject]@{exitCode=0;output='shadow-ledger-v1 ${ledger.length} ${hash(ledger)}'})
$empty=Get-ShadowLedgerTransfer $file ([pscustomobject]@{exitCode=0;output='shadow-ledger-v1 0 ${hash('')}'})
$missing=Get-ShadowLedgerTransfer $file ([pscustomobject]@{exitCode=0;output='shadow-ledger-v1 missing'})
$longer=Get-ShadowLedgerTransfer $file ([pscustomobject]@{exitCode=0;output='shadow-ledger-v1 ${ledger.length+1} ${hash(ledger)}'})
$mismatch=Get-ShadowLedgerTransfer $file ([pscustomobject]@{exitCode=0;output='shadow-ledger-v1 ${prefix.length} ${hash('different')}'})
$failed=Get-ShadowLedgerTransfer $file ([pscustomobject]@{exitCode=255;output=''})
$unreadable=Get-ShadowLedgerTransfer $file ([pscustomobject]@{exitCode=0;output='shadow-ledger-v1 read_failed'})
$invalid=Get-ShadowLedgerTransfer $file ([pscustomobject]@{exitCode=0;output='shadow-ledger-v1 0 unsafe; command'})
$overflow=Get-ShadowLedgerTransfer $file ([pscustomobject]@{exitCode=0;output='shadow-ledger-v1 9999999999999999999999 ${hash('')}'})
$large=Get-ShadowLedgerTransfer ${quote(path.join(root,'large.jsonl'))} ([pscustomobject]@{exitCode=0;output='shadow-ledger-v1 ${largePrefix.length} ${hash(largePrefix)}'})
$tar=(Get-Command tar.exe,tar -ErrorAction SilentlyContinue|Select-Object -First 1).Source
New-ShadowUploadArchive $tar ${quote(root)} ${quote(path.join(root,'delta.tar.gz'))} $prefix
New-ShadowUploadArchive $tar ${quote(root)} ${quote(path.join(root,'zero.tar.gz'))} $same
New-ShadowUploadArchive $tar ${quote(root)} ${quote(path.join(root,'full.tar.gz'))} $missing
[ordered]@{prefix=$prefix;same=$same;empty=$empty;missing=$missing;longer=$longer;mismatch=$mismatch;failed=$failed;unreadable=$unreadable;invalid=$invalid;overflow=$overflow;large=$large}|ConvertTo-Json -Compress -Depth 5
`);
  assert.deepEqual(result.prefix,{mode:'delta',offset:prefix.length,bytes:ledger.length-prefix.length,sha256:hash(ledger),reason:'none'});
  assert.equal(result.same.mode,'delta');assert.equal(result.same.bytes,0);
  assert.equal(result.empty.mode,'delta');assert.equal(result.empty.offset,0);
  assert.deepEqual(result.large,{mode:'delta',offset:largePrefix.length,bytes:large.length-largePrefix.length,sha256:hash(large),reason:'none'});
  for(const [key,reason] of Object.entries({missing:'remote_missing',longer:'remote_longer',mismatch:'prefix_mismatch',
    failed:'remote_read_failed',unreadable:'remote_read_failed',invalid:'remote_read_failed',overflow:'remote_read_failed'})){
    assert.equal(result[key].mode,'full');assert.equal(result[key].reason,reason);
  }
  for(const [archive,member,expected] of [['delta','shadow-ledger.delta',ledger.subarray(prefix.length)],
    ['zero','shadow-ledger.delta',Buffer.alloc(0)],['full','shadow-ledger.jsonl',ledger]]){
    const payload=path.join(root,`${archive}.tar.gz`);
    assert.deepEqual(execFileSync('tar',['-tzf',payload],{encoding:'utf8'}).trim().split(/\r?\n/).sort(),[names[1],names[2],member].sort());
    assert.deepEqual(execFileSync('tar',['-xOf',payload,member]),expected);
  }
});

// Captured from the pre-WO-05 command. Keep this literal independent of the
// command builder so changes to commit order or retry semantics are visible.
const baselineCommit=`set -eu; test -d '${stage}' && test ! -L '${stage}' && test ! -L '${data}'; test -f '${stage}/shadow-ledger.jsonl' && test ! -L '${stage}/shadow-ledger.jsonl' && sudo -n install -o 1000 -g 1000 -m 0644 '${stage}/shadow-ledger.jsonl' '${data}/shadow-ledger.jsonl.${transaction}.tmp'; test -f '${stage}/shadow-beta-snapshot.json' && test ! -L '${stage}/shadow-beta-snapshot.json' && sudo -n install -o 1000 -g 1000 -m 0644 '${stage}/shadow-beta-snapshot.json' '${data}/shadow-beta-snapshot.json.${transaction}.tmp'; test -f '${stage}/dashboard-generation.json' && test ! -L '${stage}/dashboard-generation.json' && sudo -n install -o 1000 -g 1000 -m 0644 '${stage}/dashboard-generation.json' '${data}/dashboard-generation.json.${transaction}.tmp'; if test -f '${data}/dashboard-generation.json' && ! cmp -s '${stage}/dashboard-generation.json' '${data}/dashboard-generation.json'; then sudo -n cp '${data}/dashboard-generation.json' '${data}/dashboard-generation.previous.json'; fi; sudo -n mv '${data}/shadow-ledger.jsonl.${transaction}.tmp' '${data}/shadow-ledger.jsonl'; sudo -n mv '${data}/shadow-beta-snapshot.json.${transaction}.tmp' '${data}/shadow-beta-snapshot.json'; sudo -n mv '${data}/dashboard-generation.json.${transaction}.tmp' '${data}/dashboard-generation.json'`;

for(const shell of shells)test(`remote commands reject unsafe input and preserve the exact commit (${shell})`,()=>{
  const result=runPowerShell(shell,`
$full=New-ShadowPublicationPlan '${project}/.shadow-sync-stage' '${data}' '${transaction}' 'full' '${hash(ledger)}'
$delta=New-ShadowPublicationPlan '${project}/.shadow-sync-stage' '${data}' '${transaction}' 'delta' '${hash(ledger)}'
$rejected=0
foreach($bad in @("${data}; command", "${data}'", "${data}/../other", "${data}\n")) {
  try { New-ShadowPublicationPlan '${project}/.shadow-sync-stage' $bad '${transaction}'|Out-Null } catch { $rejected++ }
}
try { New-ShadowPublicationPlan '${project}/../.shadow-sync-stage' '${data}' '${transaction}'|Out-Null } catch { $rejected++ }
try { New-ShadowPublicationPlan '${project}/.shadow-sync-stage' '${data}' 'unsafe; command'|Out-Null } catch { $rejected++ }
try { New-ShadowPublicationPlan '${project}/.shadow-sync-stage' '${data}' '${transaction}' 'delta' 'unsafe; command'|Out-Null } catch { $rejected++ }
[ordered]@{full=$full;delta=$delta;rejected=$rejected}|ConvertTo-Json -Compress -Depth 5
`);
  assert.equal(result.rejected,7);
  assert.equal(result.full.commit,baselineCommit);assert.equal(result.delta.commit,baselineCommit);
  assert.equal(result.full.preflight,result.delta.preflight);
  assert.match(result.full.preflight,/wc -c < '[^']+\/shadow-ledger\.jsonl'/);
  assert.match(result.full.preflight,/sha256sum < '[^']+\/shadow-ledger\.jsonl'/);
  assert.match(result.full.extract,/shadow-ledger\.jsonl > '[^']+\/expected-list'/);
  assert.match(result.delta.extract,/shadow-ledger\.delta > '[^']+\/expected-list'/);
  for(const plan of [result.full,result.delta]){
    for(const command of ['preflight','upload','extract','commit','cleanup']){
      for(const match of plan[command].matchAll(/'([^']*)'/g)){
        if(match[1].includes('/')) assert.ok(match[1]===project||match[1].startsWith(`${project}/`),match[1]);
      }
    }
  }
});

const bash=process.platform==='win32'?path.join(process.env.ProgramFiles??'','Git','usr','bin','bash.exe'):'bash';
const shellSetup=String.raw`export PATH=/usr/bin:/bin:$PATH
# Emulate Linux privileges/modes on Windows. Copies, tar and hashing are real.
sudo() { test "$1" = -n || return 90; shift; "$@"; }
install() {
  if test "$1" = -d; then
    test "$2" = -m && test "$3" = 0700 || return 92
    shift 3
    command mkdir -p -- "$@"
    return
  fi
  if test "$1" = -o; then
    test "$2" = 1000 && test "$3" = -g && test "$4" = 1000 || return 91
    shift 4
  fi
  test "$1" = -m && test "$2" = 0644 || return 93
  shift 2
  command cp -- "$@"
}
`;
const nativeAvailable=spawnSync(bash,['--noprofile','--norc','-c',
  `${shellSetup}for tool in tar sha256sum wc cat install cmp; do command -v "$tool" >/dev/null || exit 1; done`],
{encoding:'utf8',timeout:10000}).status===0;
const unix=value=>value.replaceAll('\\','/').replace(/^([A-Za-z]):\//,(_,drive)=>`/${drive.toLowerCase()}/`);

test('both runtimes preserve identical publication commands through native argv',t=>{
  const root=fixture(t),sink=path.join(root,'argv sink.cjs'),results=[];
  fs.writeFileSync(sink,'process.stdout.write(JSON.stringify(process.argv.slice(2)));');
  const edgeCases=['space value','"quoted"',String.raw`one\"quote`,String.raw`two\\"quote`,'trailing space\\','\\\\server\\share\\'];
  for(const shell of shells){
    const result=runPowerShell(shell,`
. ${quote(transport)}
$full=New-ShadowPublicationPlan '${project}/.shadow-sync-stage' '${data}' '${transaction}' 'full' '${hash(ledger)}'
$delta=New-ShadowPublicationPlan '${project}/.shadow-sync-stage' '${data}' '${transaction}' 'delta' '${hash(ledger)}'
$commands=@(foreach($plan in @($full,$delta)){foreach($phase in @('preflight','upload','extract','commit','cleanup')){$plan.$phase}})
$result=Invoke-BoundedSyncProcess ${quote(process.execPath)} (@(${quote(sink)})+$commands+@(${edgeCases.map(quote).join(',')})) 'argv' '' 10
if($result.exitCode -ne 0){throw $result.failure}
$received=ConvertFrom-Json -InputObject $result.output
[ordered]@{full=$full;delta=$delta;received=@(foreach($value in $received){[string]$value})}|ConvertTo-Json -Compress -Depth 5
`);
    const commands=[result.full,result.delta].flatMap(plan=>['preflight','upload','extract','commit','cleanup'].map(phase=>plan[phase]));
    assert.deepEqual(result.received,[...commands,...edgeCases],shell);
    results.push(result);
  }
  for(const result of results)assert.deepEqual(result,results[0]);
});

for(const shell of shells)for(const scenario of ['delta','zero','full-missing','read-failed','corrupt-delta','corrupt-both','full-corrupt','interrupted'])
  test(`local preflight/extract/commit simulation: ${scenario} (${shell})`,{skip:!nativeAvailable},t=>{
    const root=fixture(t),sync=path.join(root,'sync'),remote=path.join(root,'remote'),remoteData=path.join(remote,'nas-data');
    fs.mkdirSync(sync);fs.mkdirSync(remoteData,{recursive:true});
    const next=[ledger,Buffer.from('{"snapshot":"next"}'),Buffer.from('{"generation":"next"}')];
    const old=[scenario==='zero'?ledger:scenario==='full-corrupt'?Buffer.from('different'):prefix,
      Buffer.from('{"snapshot":"old"}'),Buffer.from('{"generation":"old"}')];
    for(let index=0;index<names.length;index++){
      fs.writeFileSync(path.join(sync,names[index]),next[index]);
      if(index!==0||scenario!=='full-missing')fs.writeFileSync(path.join(remoteData,names[index]),old[index]);
    }
    fs.writeFileSync(path.join(remoteData,'dashboard-generation.previous.json'),'older generation');
    const result=runPowerShell(shell,String.raw`
. ${quote(transport)}
# Reproduce the UTF-8 console that exposes .NET Framework's stdin BOM.
[Console]::InputEncoding=[Text.UTF8Encoding]::new($true)
$script:logs=@();$script:uploads=@();$script:extractCodes=@();$script:errors=@();$script:commitRuns=0;$script:untouched=$true
$script:original=@{}
foreach($name in @('shadow-ledger.jsonl','shadow-beta-snapshot.json','dashboard-generation.json','dashboard-generation.previous.json')) {
  $file=Join-Path ${quote(remoteData)} $name
  $script:original[$name]=if(Test-Path -LiteralPath $file){[Convert]::ToBase64String([IO.File]::ReadAllBytes($file))}else{'missing'}
}
function Test-InstalledUnchanged {
  foreach($name in $script:original.Keys) {
    $file=Join-Path ${quote(remoteData)} $name
    $current=if(Test-Path -LiteralPath $file){[Convert]::ToBase64String([IO.File]::ReadAllBytes($file))}else{'missing'}
    if($current -ne $script:original[$name]){$script:untouched=$false}
  }
}
function Write-Log([string]$Message){$script:logs+=@($Message)}
function Invoke-FixtureShell([string]$Command,[string]$InputFile=''){
  # A script file keeps this shell stub independent of Windows SSH/argv parsing.
  $text=(${quote(shellSetup)}+$Command.Replace('${project}',${quote(unix(remote))})+[char]10).Replace(([string][char]13+[char]10),[string][char]10).Replace([char]13,[char]10)
  [IO.File]::WriteAllText(${quote(path.join(root,'remote-command.sh'))},$text,[Text.UTF8Encoding]::new($false))
  return Invoke-BoundedSyncProcess ${quote(bash)} @('--noprofile','--norc',${quote(unix(path.join(root,'remote-command.sh')))}) 'fixture_shell' $InputFile 15
}
$script:tar=(Get-Command tar.exe,tar -ErrorAction SilentlyContinue|Select-Object -First 1).Source
function Invoke-ShadowPublicationCommand([string]$Executable,[string[]]$Arguments,[string]$Phase,
  [string]$InputFile='',[int]$TimeoutSeconds=45,[int]$MaxAttempts=2,[scriptblock]$Invoke,[scriptblock]$BeforeAttempt){
  if($BeforeAttempt){& $BeforeAttempt}
  $command=$Arguments[-1]
  if($Phase -eq 'nas_snapshot_upload'){
    $members=@(& $script:tar '-tzf' $InputFile)
    $script:uploads+=@([pscustomobject]@{members=$members;bytes=(Get-Item -LiteralPath $InputFile).Length;timeout=$TimeoutSeconds})
    $isDelta=$members -contains 'shadow-ledger.delta'
    if(('${scenario}' -in @('corrupt-delta','corrupt-both') -and $isDelta) -or
      ('${scenario}' -in @('corrupt-both','full-corrupt') -and -not $isDelta)){
      $tamper=Join-Path ${quote(root)} ('tamper-'+$script:uploads.Count)
      [void][IO.Directory]::CreateDirectory($tamper)
      & $script:tar '-xzf' $InputFile '-C' $tamper
      $member=if($isDelta){'shadow-ledger.delta'}else{'shadow-ledger.jsonl'}
      [IO.File]::AppendAllText((Join-Path $tamper $member),'corrupt fixture')
      & $script:tar '-czf' $InputFile '-C' $tamper @members
      if($LASTEXITCODE -ne 0){throw 'fixture archive failed'}
    }
    if('${scenario}' -eq 'interrupted'){
      $partial=Join-Path ${quote(root)} 'partial.bin'
      [IO.File]::WriteAllBytes($partial,[byte[]]@(1,2,3))
      $null=Invoke-FixtureShell $command $partial
      Test-InstalledUnchanged
      return [pscustomobject]@{exitCode=124;failure='nas_snapshot_upload failed (exit=124; cause=connection_timeout)'}
    }
  }
  if($Phase -eq 'nas_snapshot_preflight' -and '${scenario}' -eq 'read-failed'){$command='sha256sum() { return 1; }; '+$command}
  $result=Invoke-FixtureShell $command $InputFile
  if($result.exitCode -ne 0){$script:errors+=@([pscustomobject]@{phase=$Phase;error=$result.error})}
  if($Phase -eq 'nas_snapshot_extract'){$script:extractCodes+=@($result.exitCode);Test-InstalledUnchanged}
  if($Phase -eq 'nas_commit' -and $result.exitCode -eq 0){
    $script:commitRuns++
    # Repeat the exact successful commit to exercise previous-generation retention.
    $result=Invoke-FixtureShell $command
    $script:commitRuns++
  }
  return $result
}
$failed=$false;$failureText=''
try { Invoke-ShadowPublication $script:tar 'fixture-not-ssh' @() '${project}/.shadow-sync-stage' '${data}' ${quote(sync)} '${transaction}' }
catch {$failed=$true;$failureText=$_.Exception.Message}
[ordered]@{failed=$failed;failure=$failureText;logs=$script:logs;uploads=$script:uploads;extractCodes=$script:extractCodes;errors=$script:errors;commitRuns=$script:commitRuns;untouched=$script:untouched}|ConvertTo-Json -Compress -Depth 7
`);
    const failure=['corrupt-both','full-corrupt','interrupted'].includes(scenario);
    assert.equal(result.failed,failure,JSON.stringify(result));
    assert.equal(result.untouched,true,'an installed file changed before commit');
    assert.equal(result.commitRuns,failure?0:2);
    const fallback=['corrupt-delta','corrupt-both'].includes(scenario);
    assert.equal(result.uploads.length,fallback?2:1);
    const initialFull=['full-missing','read-failed','full-corrupt'].includes(scenario);
    const reasons={...{'full-missing':'remote_missing','read-failed':'remote_read_failed','full-corrupt':'prefix_mismatch'}};
    for(let index=0;index<result.uploads.length;index++){
      const full=initialFull||index>0,member=full?'shadow-ledger.jsonl':'shadow-ledger.delta';
      assert.deepEqual(result.uploads[index].members.sort(),[names[1],names[2],member].sort());
      assert.ok(result.uploads[index].timeout>=90);assert.ok(result.uploads[index].timeout<=(full?300:180));
      assert.equal(result.logs.filter(line=>line===`Shadow upload: mode=${full?'full':'delta'} bytes=${result.uploads[index].bytes} fallback=${index>0?'delta_validation_failed':reasons[scenario]??'none'}`).length,1);
    }
    if(fallback)assert.deepEqual(result.extractCodes,[65,scenario==='corrupt-both'?65:0]);
    for(let index=0;index<names.length;index++){
      const file=path.join(remoteData,names[index]);
      if(failure)assert.deepEqual(fs.readFileSync(file),old[index]);
      else assert.deepEqual(fs.readFileSync(file),next[index]);
      assert.deepEqual(fs.readFileSync(path.join(sync,names[index])),next[index]);
    }
    assert.equal(fs.readFileSync(path.join(remoteData,'dashboard-generation.previous.json'),'utf8'),
      failure?'older generation':old[2].toString());
    assert.equal(fs.existsSync(path.join(remote,`.shadow-sync-stage-${transaction}`)),false);
    for(const name of ['nas-upload.tar.gz','shadow-ledger.delta','shadow-ledger.delta.tmp'])assert.equal(fs.existsSync(path.join(sync,name)),false);
  });

for(const shell of shells)test(`both archive modes reject extra and missing files before extraction (${shell})`,{skip:!nativeAvailable},t=>{
  const root=fixture(t);
  const plans=runPowerShell(shell,`
[ordered]@{full=(New-ShadowPublicationPlan '${project}/.shadow-sync-stage' '${data}' '${transaction}' 'full' '${hash(ledger)}');delta=(New-ShadowPublicationPlan '${project}/.shadow-sync-stage' '${data}' '${transaction}' 'delta' '${hash(ledger)}')}|ConvertTo-Json -Compress -Depth 5
`);
  for(const mode of ['full','delta'])for(const defect of ['extra','missing']){
    const remote=path.join(root,`${mode}-${defect}`),remoteData=path.join(remote,'nas-data'),contents=path.join(remote,'contents');
    fs.mkdirSync(remoteData,{recursive:true});fs.mkdirSync(contents);
    const before=[prefix,Buffer.from('old snapshot'),Buffer.from('old generation')];
    for(let index=0;index<names.length;index++)fs.writeFileSync(path.join(remoteData,names[index]),before[index]);
    const run=command=>spawnSync(bash,['--noprofile','--norc','-c',shellSetup+command.replaceAll(project,unix(remote))],{encoding:'utf8',timeout:15000});
    const preflight=run(plans[mode].preflight);assert.equal(preflight.status,0,preflight.stderr);
    assert.equal(preflight.stdout.trim(),`shadow-ledger-v1 ${prefix.length} ${hash(prefix)}`);
    const member=mode==='delta'?'shadow-ledger.delta':'shadow-ledger.jsonl';
    const members=[member,names[1],names[2]];
    fs.writeFileSync(path.join(contents,member),mode==='delta'?ledger.subarray(prefix.length):ledger);
    fs.writeFileSync(path.join(contents,names[1]),'next snapshot');fs.writeFileSync(path.join(contents,names[2]),'next generation');
    if(defect==='extra'){members.push('extra.json');fs.writeFileSync(path.join(contents,'extra.json'),'extra');}
    else members.splice(1,1);
    execFileSync('tar',['-czf',path.join(remote,`.shadow-sync-stage-${transaction}`,'payload.tar.gz'),'-C',contents,...members]);
    assert.notEqual(run(plans[mode].extract).status,0,`${mode}/${defect} archive was accepted`);
    assert.deepEqual(fs.readFileSync(path.join(remote,`.shadow-sync-stage-${transaction}`,'archive-list'),'utf8').trim().split('\n'),members.sort());
    for(let index=0;index<names.length;index++)assert.deepEqual(fs.readFileSync(path.join(remoteData,names[index])),before[index]);
    assert.equal(fs.existsSync(path.join(remote,`.shadow-sync-stage-${transaction}`,member)),false,'invalid archive was extracted');
  }
});

test('shadow publication uses a unique staging transaction and bounded cleanup',()=>{
  const source=fs.readFileSync(new URL('../scripts/Sync-ShadowPublication.ps1',import.meta.url),'utf8');
  assert.match(source,/New-ShadowPublicationPlan/);
  assert.match(source,/TransactionId/);
  assert.match(source,/archive-list/);
  assert.match(source,/expected-list/);
  assert.match(source,/shadow-sync-stage-\*/);
  assert.match(source,/-mmin \+1440/);
  assert.match(source,/test -w '\$project'/);
  assert.match(source,/Invoke-BoundedSyncProcess/);
  assert.doesNotMatch(source,/rm -rf -- '\$NasStagingDir/);
});

test('local and passive evidence publication share a cross-process lease',()=>{
  const sync=fs.readFileSync(new URL('../scripts/Sync-NasShadow.ps1',import.meta.url),'utf8');
  const repair=fs.readFileSync(new URL('../src/pt-evidence-repair.mjs',import.meta.url),'utf8');
  assert.match(sync,/shadow-publication\.lock/);
  assert.match(sync,/Acquire-ShadowPublicationLease/);
  assert.match(repair,/name:'shadow-publication\.lock'/);
});

test('shadow scheduler runs a post-evidence observation-only publication',()=>{
  const source=fs.readFileSync(new URL('../scripts/Start-NasShadowScheduler.ps1',import.meta.url),'utf8');
  const sync=fs.readFileSync(new URL('../scripts/Sync-NasShadow.ps1',import.meta.url),'utf8');
  assert.match(source,/pt-evidence-repair-dirty-/);
  assert.match(source,/-SkipHarvestFallback/);
  assert.match(source,/evidence_dashboard_sync/);
  assert.match(sync,/SkipHarvestFallback/);
});

test('scheduler respects current retry state and scans dated evidence markers',()=>{
  const source=fs.readFileSync(new URL('../scripts/Start-NasShadowScheduler.ps1',import.meta.url),'utf8');
  assert.match(source,/normalSyncAttempted/);
  assert.match(source,/currentRetryAt/);
  assert.match(source,/Get-PendingEvidenceMarkers/);
  assert.match(source,/publishedEvidenceFingerprint/);
  assert.match(source,/taskkill\.exe/);
});

test('shadow sync bounds Harvest fallback and cleans only expired inactive inputs',()=>{
  const source=fs.readFileSync(new URL('../scripts/Sync-NasShadow.ps1',import.meta.url),'utf8');
  assert.match(source,/Remove-StaleHarvestFallbackPending/);
  assert.match(source,/Get-CimInstance Win32_Process/);
  assert.match(source,/harvest_fallback/);
  assert.match(source,/Invoke-BoundedSyncProcess \$NodePath/);
  assert.doesNotMatch(source,/Start-Process -FilePath \$NodePath/);
});
