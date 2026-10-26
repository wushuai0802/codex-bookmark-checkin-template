import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {fileURLToPath} from 'node:url';
import {spawnPtSiteChild} from '../src/pt-site-execution.mjs';
import {beginPtWorker,reconcilePtWorker,cleanupPtWorker} from '../src/pt-worker-lifecycle.mjs';

function fixture(t){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'pt-worker-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true,maxRetries:50,retryDelay:100}));
  fs.mkdirSync(path.join(root,'scripts'));fs.writeFileSync(path.join(root,'scripts/Run-PtSupplement.mjs'),'fixture');
  return {root,legacyRoot:root,origin:'https://fixture.example',catalogFile:path.join(root,'catalog.json'),catalogHash:'a'.repeat(64),
    lease:{owner:{nonce:'fixture'}},resolveScope:async()=>({profileBinding:'a'.repeat(64),privateProfile:null,shell:'pwsh.exe'})};
}
function fake(){const child=new EventEmitter();child.pid=12345;child.stdout=new PassThrough();child.stderr=new PassThrough();return child;}

test('normal worker completion waits for stdout close rather than the earlier exit event',async t=>{
  const args=fixture(t);let finished=false;
  const promise=spawnPtSiteChild({...args,spawnChild:()=>{const child=fake();
    setImmediate(()=>{child.emit('exit',0,null);setTimeout(()=>{child.stdout.write(JSON.stringify({origin:args.origin,status:'unknown',
      observedAt:new Date().toISOString(),evidence:{source:'none',authoritative:false}}));child.emit('close',0,null);},30);});return child;
  }}).then(value=>{finished=true;return value;});
  await new Promise(resolve=>setTimeout(resolve,15));assert.equal(finished,false);
  assert.equal((await promise).status,'unknown');assert.equal(fs.existsSync(path.join(args.root,'data/pt-worker-lifecycle.json')),false);
});

test('timeout waits for owned cleanup and pipe closure before rejecting',async t=>{
  const args=fixture(t);let cleanupFinished=false,closed=false;
  const child=fake();child.kill=()=>{};
  await assert.rejects(spawnPtSiteChild({...args,spawnChild:()=>child,timeoutMs:10,cleanupWaitMs:200,
    cleanup:async()=>{await new Promise(resolve=>setTimeout(resolve,30));cleanupFinished=true;
      setTimeout(()=>{closed=true;child.emit('exit',1,null);child.emit('close',1,null);},20);return true;}}),error=>{
    assert.match(error.message,/timed out/);assert.equal(cleanupFinished,true);assert.equal(closed,true);return true;
  });
  assert.equal(fs.existsSync(path.join(args.root,'data/pt-worker-lifecycle.json')),false);
});

test('unconfirmed cleanup survives controller restart and blocks another execution until reconciled',async t=>{
  const args=fixture(t),child=fake();child.kill=()=>{};
  await assert.rejects(spawnPtSiteChild({...args,spawnChild:()=>child,timeoutMs:10,cleanup:async()=>false}),error=>error.code==='PT_CLEANUP_PENDING');
  const file=path.join(args.root,'data/pt-worker-lifecycle.json');assert.equal(JSON.parse(fs.readFileSync(file)).state,'cleanup_pending');
  await assert.rejects(reconcilePtWorker(args.root,{legacyRoot:args.legacyRoot,cleanup:async()=>false}),error=>error.code==='PT_CLEANUP_PENDING');
  await reconcilePtWorker(args.root,{legacyRoot:args.legacyRoot,cleanup:async()=>true});assert.equal(fs.existsSync(file),false);
});

test('an unresponsive cleanup callback is bounded and leaves its durable execution barrier',async t=>{
  const args=fixture(t),child=fake();child.kill=()=>{};
  await assert.rejects(spawnPtSiteChild({...args,spawnChild:()=>child,timeoutMs:5,cleanupTimeoutMs:15,
    cleanup:()=>new Promise(()=>{})}),error=>error.code==='PT_CLEANUP_PENDING');
  assert.equal(fs.existsSync(path.join(args.root,'data/pt-worker-lifecycle.json')),true);
  await assert.rejects(reconcilePtWorker(args.root,{legacyRoot:args.legacyRoot,cleanupTimeoutMs:10,cleanup:()=>new Promise(()=>{})}),
    error=>error.code==='PT_CLEANUP_PENDING');
});

test('a prepared lifecycle cannot be overwritten or reconciled against another runtime',async t=>{
  const args=fixture(t);beginPtWorker(args.root,{ownerId:crypto.randomUUID(),legacyRoot:args.legacyRoot,startedAt:new Date().toISOString()});
  assert.throws(()=>beginPtWorker(args.root,{}),error=>error.code==='PT_CLEANUP_PENDING');
  await assert.rejects(reconcilePtWorker(args.root,{legacyRoot:path.join(args.root,'other'),cleanup:async()=>true}),error=>error.code==='PT_CLEANUP_PENDING');
});

test('a failed PID publication still cleans the spawned worker and keeps its durable barrier until closure',async t=>{
  const args=fixture(t),file=path.join(args.root,'data/pt-worker-lifecycle.json'),rename=fs.renameSync,child=fake();
  let writes=0,cleaned=false;child.kill=()=>{};
  fs.renameSync=(from,to)=>{if(to===file&&++writes===2)throw Object.assign(Error('synthetic file occupancy'),{code:'EPERM'});return rename(from,to);};
  try{
    await assert.rejects(spawnPtSiteChild({...args,spawnChild:()=>child,cleanupWaitMs:100,
      cleanup:async record=>{cleaned=true;assert.equal(record.workerPid,child.pid);assert.equal(fs.existsSync(file),true);
        setTimeout(()=>child.emit('close',1,null),10);return true;}}),error=>error.code==='EPERM');
    assert.equal(cleaned,true);assert.equal(fs.existsSync(file),false);
  }finally{fs.renameSync=rename;}
});

test('Windows cleanup terminates only the owned project process tree and preserves another child application',
  {skip:process.platform!=='win32',timeout:20_000},async t=>{
    const args=fixture(t),outside=fs.mkdtempSync(path.join(os.tmpdir(),'pt-unrelated-'));t.after(()=>fs.rmSync(outside,{recursive:true,force:true,maxRetries:50,retryDelay:100}));
    fs.copyFileSync(fileURLToPath(new URL('../../execution/scripts/Cleanup-PtWorker.ps1',import.meta.url)),path.join(args.root,'scripts/Cleanup-PtWorker.ps1'));
    const ownedFile=path.join(args.root,'scripts/owned.mjs'),otherFile=path.join(outside,'other.mjs'),browserFile=path.join(args.root,'scripts/chrome.exe');
    const privateProfile=path.join(args.root,'data/private'),sharedProfile=path.join(outside,'shared');
    fs.mkdirSync(privateProfile,{recursive:true});fs.mkdirSync(sharedProfile,{recursive:true});fs.copyFileSync(process.execPath,browserFile);
    fs.writeFileSync(ownedFile,'setInterval(()=>{},1000);');
    fs.writeFileSync(otherFile,'setTimeout(()=>process.exit(0),7000);');
    fs.writeFileSync(path.join(args.root,'scripts/Run-PtSupplement.mjs'),
      'import {spawn} from "node:child_process";'+
      'const owned=spawn(process.execPath,[process.argv[2]],{stdio:"ignore"});'+
      'const other=spawn(process.execPath,[process.argv[3]],{stdio:"ignore",detached:true});'+
      'const privateBrowser=spawn(process.argv[4],[process.argv[2],"--user-data-dir="+process.argv[5]],{stdio:"ignore"});'+
      'const sharedBrowser=spawn(process.argv[4],[process.argv[3],"--user-data-dir="+process.argv[6]],{stdio:"ignore",detached:true});'+
      'console.log(JSON.stringify({owned:owned.pid,other:other.pid,privateBrowser:privateBrowser.pid,sharedBrowser:sharedBrowser.pid}));setInterval(()=>{},1000);');
    const ownerId=crypto.randomUUID(),startedAt=new Date().toISOString();
    const worker=spawn(process.execPath,[path.join(args.root,'scripts/Run-PtSupplement.mjs'),ownedFile,otherFile,browserFile,privateProfile,sharedProfile,'--worker-owner='+ownerId],{stdio:['ignore','pipe','pipe'],windowsHide:true});
    t.after(()=>{try{worker.kill();}catch{}});
    const ids=await new Promise((resolve,reject)=>{let data='';worker.once('error',reject);worker.stdout.on('data',chunk=>{
      data+=chunk;try{resolve(JSON.parse(data.trim()));}catch{}
    });});
    let detail;
    const completed=await cleanupPtWorker({workerPid:worker.pid,observerPid:process.pid,ownerId,startedAt,legacyRoot:args.root,privateProfile,shell:'pwsh.exe'},
      {executeFile:async(...options)=>{const value=await promisify(execFile)(...options);detail=JSON.parse(value.stdout);return value;}});
    assert.equal(completed,true,JSON.stringify(detail));
    const alive=pid=>{try{process.kill(pid,0);return true;}catch{return false;}};
    assert.equal(alive(ids.owned),false);assert.equal(alive(ids.privateBrowser),false);
    assert.equal(alive(ids.other),true);assert.equal(alive(ids.sharedBrowser),true);assert.equal(detail.sharedBrowserPreserved,true);
    const deadline=Date.now()+9000;while((alive(ids.other)||alive(ids.sharedBrowser))&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,100));
    assert.equal(alive(ids.other),false);assert.equal(alive(ids.sharedBrowser),false);
  });
