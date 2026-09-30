import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {runPtSite,projectPtSiteResult,spawnPtSiteChild} from '../src/pt-site-execution.mjs';

test('PT transport preserves evidence identity and rejects future or conflicting success',()=>{
  const origin='https://pt.example',value={origin,status:'already_signed',observedAt:'2026-09-30T01:00:00Z',
    startedAt:'2026-09-30T00:58:00Z',businessDate:'2026-09-30',accountKey:'site-default',profileBinding:'a'.repeat(64),
    operationMode:'safe_history_page',readSafety:'reviewed_passive',submissionAttempted:false,
    evidence:{source:'pt_page',authoritative:true,confirmedAt:'2026-09-30T01:00:00Z',businessDate:'2026-09-30',
      statusSignal:'open_cd_daily_record_entry',evidenceScope:'site_account_day',secret:'<must-drop>'}};
  const result=projectPtSiteResult(value,origin);
  assert.equal(result.status,'already_signed');assert.equal(result.submissionAttempted,false);
  assert.equal(result.profileBinding,value.profileBinding);assert.equal(Date.parse(result.evidence.confirmedAt),Date.parse(value.evidence.confirmedAt));
  assert.equal(result.evidence.secret,undefined);
  assert.equal(projectPtSiteResult({...value,submissionOutcomeUnknown:true},origin).status,'needs_attention');
  assert.equal(projectPtSiteResult({...value,evidence:{...value.evidence,confirmedAt:'2026-09-30T02:00:00Z'}},origin).status,'unknown');
  assert.equal(projectPtSiteResult({...value,operationMode:'private-value'},origin).operationMode,undefined);
});

test('site execution requires one unified lease and keeps the result redacted',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'pt-exec-gateway-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const legacyRoot=path.join(root,'execution');
  fs.mkdirSync(path.join(root,'config'));fs.mkdirSync(path.join(legacyRoot,'data'),{recursive:true});
  const catalogFile=path.join(root,'catalog.json');fs.writeFileSync(catalogFile,'{"sites":[]}');
  const catalogHash=crypto.createHash('sha256').update(fs.readFileSync(catalogFile)).digest('hex');
  fs.writeFileSync(path.join(root,'config/runtime.local.json'),JSON.stringify({executionEngine:'v1',legacyRoot,ptFallbackOnlyEnabled:true}));
  fs.writeFileSync(path.join(legacyRoot,'data/v2-integration.json'),JSON.stringify({executionEngine:'v1',v2ProjectRoot:root}));
  let acquired=0,released=0;
  const result=await runPtSite({root,origin:'https://pt.example',catalogFile:'catalog.json',catalogHash,
    acquire:()=>{acquired++;return {owner:{nonce:'synthetic'}};},release:()=>{released++;},
    execute:async options=>{assert.equal(options.origin,'https://pt.example');assert.equal(options.catalogFile,catalogFile);assert.equal(options.lease.owner.nonce,'synthetic');return {origin:options.origin,status:'signed',observedAt:'2026-09-20T01:00:00Z',evidence:{source:'page_text',authoritative:true,summary:'confirmed'},password:'TEST'};}});
  assert.equal(result.status,'signed');assert.equal(acquired,1);assert.equal(released,1);
  fs.writeFileSync(path.join(root,'config/runtime.local.json'),JSON.stringify({executionEngine:'v1',legacyRoot}));
  await assert.rejects(()=>runPtSite({root,origin:'https://pt.example',catalogFile:'catalog.json',catalogHash,
    acquire:()=>{throw Error('opt-out must prevent lock acquisition');}}),error=>error.code==='PT_PREFLIGHT');
  assert.doesNotMatch(JSON.stringify(result),/password|TEST/);
  assert.throws(()=>projectPtSiteResult({origin:'https://wrong.example',status:'signed',observedAt:new Date().toISOString()},'https://pt.example'),/invalid/);
  await assert.rejects(()=>runPtSite({root,origin:'https://pt.example',catalogFile:'missing.json',catalogHash,
    acquire:()=>{throw Error('no lock may be acquired');}}),error=>error.code==='PT_PREFLIGHT');
});

test('child receives the exact origin and lease; busy lock is retryable without a receipt',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'pt-child-protocol-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  fs.mkdirSync(path.join(root,'scripts'));fs.writeFileSync(path.join(root,'scripts/Run-PtSupplement.mjs'),'fixture');
  const args={legacyRoot:root,root,origin:'https://pt.example',catalogFile:path.join(root,'catalog.json'),catalogHash:'a'.repeat(64),lease:{owner:{nonce:'lease-fixture'}}};
  const spawnChild=(_node,argv,options)=>{
    assert.deepEqual(argv.slice(1),[args.origin,args.catalogFile,args.catalogHash]);
    assert.equal(options.env.CHECKIN_V2_ENGINE_LEASE,'lease-fixture');
    const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();child.kill=()=>{};
    setImmediate(()=>{child.stdout.write(JSON.stringify({origin:args.origin,status:'login_required',observedAt:'2026-09-20T01:00:00Z',evidence:{source:'none',authoritative:false}}));child.emit('exit',0,null);});
    return child;
  };
  assert.equal((await spawnPtSiteChild({...args,spawnChild})).status,'login_required');
  const readOnlyChild=(_node,argv,options)=>{
    assert.deepEqual(argv.slice(1),[args.origin,args.catalogFile,args.catalogHash,'--read-only']);
    assert.equal(options.env.CHECKIN_V2_ENGINE_LEASE,'lease-fixture');
    const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();child.kill=()=>{};
    setImmediate(()=>{child.stdout.write(JSON.stringify({origin:args.origin,status:'unknown',observedAt:'2026-09-20T01:00:00Z',evidence:{source:'none',authoritative:false}}));child.emit('exit',0,null);});
    return child;
  };
  assert.equal((await spawnPtSiteChild({...args,readOnly:true,spawnChild:readOnlyChild})).status,'unknown');
  const busy=()=>{const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();child.kill=()=>{};setImmediate(()=>child.emit('exit',3,null));return child;};
  await assert.rejects(()=>spawnPtSiteChild({...args,spawnChild:busy}),/already active/);
});
