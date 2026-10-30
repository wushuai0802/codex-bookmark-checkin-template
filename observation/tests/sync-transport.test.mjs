import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const transport=fileURLToPath(new URL('../scripts/Sync-Transport.ps1',import.meta.url));
const quote=value=>"'"+value.replaceAll("'","''")+"'";
test('outer timeout delivers cooperative cancellation before its force-kill grace expires',{skip:process.platform!=='win32'},t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'sync-cooperative-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const child=path.join(root,'observer.cjs'),proof=path.join(root,'cleanup.json');
  fs.writeFileSync(child,"const fs=require('node:fs');let data='';process.stdin.on('data',v=>{data+=v; if(data.includes('pt_batch_cancel')){fs.writeFileSync(process.argv[2],JSON.stringify({cleanup:true}));process.exit(0);}});setTimeout(()=>{},20000);");
  const code=`. ${quote(transport)}; $result=Invoke-BoundedSyncProcess -Executable ${quote(process.execPath)} -Arguments @(${quote(child)},${quote(proof)}) -Phase 'batch' -TimeoutSeconds 1 -CooperativeStop -CleanupGraceSeconds 3; $result|ConvertTo-Json -Compress`;
  const result=JSON.parse(execFileSync('pwsh.exe',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(code,'utf16le').toString('base64')],{encoding:'utf8',timeout:15000}));
  assert.equal(result.timedOut,true);assert.equal(result.exitCode,124);assert.equal(JSON.parse(fs.readFileSync(proof)).cleanup,true);
});
for(const shell of process.platform==='win32'?['powershell.exe','pwsh.exe']:['pwsh'])test(`bounded transport closes stdin and kills a stalled writer (${shell})`,{skip:process.platform!=='win32'},t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'fabric-sync-transport-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const input=path.join(root,'input.bin');
  fs.writeFileSync(input,Buffer.alloc(8*1024*1024,0x61));
  const drain=path.join(root,'drain.cjs');
  fs.writeFileSync(drain,"let size=0;process.stdin.on('data',chunk=>size+=chunk.length);process.stdin.on('end',()=>{process.stdout.write('drained:'+size);process.stderr.write('diagnostic');});");
  const stall=path.join(root,'stall.cjs');
  fs.writeFileSync(stall,'setTimeout(()=>{},10000);');
  const code=String.raw`
$ErrorActionPreference='Stop'
. ${quote(transport)}
$ok=Invoke-BoundedSyncProcess -Executable ${quote(process.execPath)} -Arguments @(${quote(drain)}) -Phase 'drain' -InputFile ${quote(input)} -TimeoutSeconds 10
$stalled=Invoke-BoundedSyncProcess -Executable ${quote(process.execPath)} -Arguments @(${quote(stall)}) -Phase 'stall' -InputFile ${quote(input)} -TimeoutSeconds 1
[ordered]@{okExit=$ok.exitCode;okFailure=$ok.failure;okOutput=$ok.output;okError=$ok.error;stalledExit=$stalled.exitCode;stalledFailure=$stalled.failure;stalledTimedOut=$stalled.timedOut}|ConvertTo-Json -Compress
`;
  const output=execFileSync(shell,['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(code,'utf16le').toString('base64')],{encoding:'utf8',timeout:30000});
  const result=JSON.parse(output.trim());
  assert.equal(result.okExit,0);
  assert.equal(result.okFailure,null);
  assert.match(result.okOutput,/^drained:83886\d+$/);
  assert.ok(Number(result.okOutput.slice('drained:'.length))>=8*1024*1024);
  assert.equal(result.okError,'diagnostic');
  assert.equal(result.stalledExit,124);
  assert.equal(result.stalledTimedOut,true);
  assert.match(result.stalledFailure,/cause=connection_timeout/);
});
