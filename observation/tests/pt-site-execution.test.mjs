import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {runPtSite,projectPtSiteResult,spawnPtSiteChild} from '../src/pt-site-execution.mjs';

test('U2 pre-submit diagnoses cross the PT transport without becoming an authentication failure',()=>{
  const origin='https://u2.dmhy.org';
  for(const failureCode of ['u2_reference_unavailable','u2_reference_timeout','u2_visual_ambiguous','u2_image_unavailable',
    'u2_challenge_changed','u2_question_expired','u2_solver_failed']){
    const value={origin,status:'needs_attention',failureCode,observedAt:new Date().toISOString(),
      submissionAttempted:false,evidence:{source:'none',authoritative:false,summary:'U2 未提交'}};
    const projected=projectPtSiteResult(value,origin);
    assert.equal(projected.failureCode,failureCode);assert.equal(projected.submissionAttempted,false);
    assert.equal(projected.status,'needs_attention');assert.equal(projected.evidence.authoritative,false);
  }
});

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
  const failure=projectPtSiteResult({...value,status:'needs_attention',failureCode:'site_maintenance',retryCause:'upstream_unavailable',siteCondition:'site_maintenance',evidence:{source:'none',authoritative:false}},origin);
  assert.equal(failure.failureCode,'site_maintenance');assert.equal(failure.retryCause,'upstream_unavailable');
  assert.equal(projectPtSiteResult({...failure,failureCode:'secret-value'},origin).failureCode,undefined);
  assert.equal(projectPtSiteResult({...value,status:'not_signed'},origin).status,'not_signed');
  assert.equal(projectPtSiteResult({...value,status:'not_signed',evidence:{source:'none',authoritative:false}},origin).status,'unknown');
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
  const fallbackAttemptId=crypto.randomUUID();
  const result=await runPtSite({root,origin:'https://pt.example',catalogFile:'catalog.json',catalogHash,fallbackAttemptId,
    acquire:()=>{acquired++;return {owner:{nonce:'synthetic'}};},release:()=>{released++;},
    execute:async options=>{assert.equal(options.origin,'https://pt.example');assert.equal(options.catalogFile,catalogFile);assert.equal(options.lease.owner.nonce,'synthetic');assert.equal(options.fallbackAttemptId,fallbackAttemptId);return {origin:options.origin,status:'signed',observedAt:'2026-09-20T01:00:00Z',evidence:{source:'page_text',authoritative:true,summary:'confirmed'},password:'TEST'};}});
  assert.equal(result.status,'signed');assert.equal(acquired,1);assert.equal(released,1);
  fs.writeFileSync(path.join(root,'config/runtime.local.json'),JSON.stringify({executionEngine:'v1',legacyRoot}));
  await assert.rejects(()=>runPtSite({root,origin:'https://pt.example',catalogFile:'catalog.json',catalogHash,
    acquire:()=>{throw Error('opt-out must prevent lock acquisition');}}),error=>error.code==='PT_PREFLIGHT');
  assert.doesNotMatch(JSON.stringify(result),/password|TEST/);
  assert.throws(()=>projectPtSiteResult({origin:'https://wrong.example',status:'signed',observedAt:new Date().toISOString()},'https://pt.example'),/invalid/);
  await assert.rejects(()=>runPtSite({root,origin:'https://pt.example',catalogFile:'missing.json',catalogHash,
    acquire:()=>{throw Error('no lock may be acquired');}}),error=>error.code==='PT_PREFLIGHT');
  await assert.rejects(()=>runPtSite({root,origin:'https://pt.example',catalogFile:'catalog.json',catalogHash,fallbackAttemptId:'wrong',
    acquire:()=>{throw Error('no lock may be acquired');}}),error=>error.code==='PT_PREFLIGHT');
});

test('child receives the exact origin and lease; busy lock is retryable without a receipt',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'pt-child-protocol-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  fs.mkdirSync(path.join(root,'scripts'));fs.writeFileSync(path.join(root,'scripts/Run-PtSupplement.mjs'),'fixture');
  const args={legacyRoot:root,root,origin:'https://pt.example',catalogFile:path.join(root,'catalog.json'),catalogHash:'a'.repeat(64),lease:{owner:{nonce:'lease-fixture'}},
    resolveScope:async()=>({profileBinding:'a'.repeat(64),privateProfile:null,shell:'pwsh.exe'})};
  const inheritedId=process.env.CHECKIN_PT_FALLBACK_ATTEMPT_ID;
  process.env.CHECKIN_PT_FALLBACK_ATTEMPT_ID=crypto.randomUUID();
  t.after(()=>{if(inheritedId===undefined)delete process.env.CHECKIN_PT_FALLBACK_ATTEMPT_ID;else process.env.CHECKIN_PT_FALLBACK_ATTEMPT_ID=inheritedId;});
  const spawnChild=(_node,argv,options)=>{
    assert.deepEqual(argv.slice(1,5),[args.origin,args.catalogFile,args.catalogHash,'--execute']);
    assert.match(argv[5],/^--worker-owner=[a-f0-9-]{36}$/);
    assert.equal(options.env.CHECKIN_V2_ENGINE_LEASE,'lease-fixture');
    assert.equal(options.env.CHECKIN_PT_FALLBACK_ATTEMPT_ID,undefined);
    const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();child.kill=()=>{};
    setImmediate(()=>{child.stdout.write(JSON.stringify({origin:args.origin,status:'login_required',observedAt:'2026-09-20T01:00:00Z',evidence:{source:'none',authoritative:false}}));child.emit('exit',0,null);child.emit('close',0,null);});
    return child;
  };
  assert.equal((await spawnPtSiteChild({...args,spawnChild})).status,'login_required');
  const fallbackAttemptId=crypto.randomUUID();
  const ownAttemptChild=(_node,argv,options)=>{
    assert.deepEqual(argv.slice(1,5),[args.origin,args.catalogFile,args.catalogHash,'--execute']);
    assert.equal(options.env.CHECKIN_PT_FALLBACK_ATTEMPT_ID,fallbackAttemptId);
    const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();child.kill=()=>{};
    setImmediate(()=>{child.stdout.write(JSON.stringify({origin:args.origin,status:'unknown',observedAt:'2026-09-20T01:00:00Z',evidence:{source:'none',authoritative:false}}));child.emit('exit',0,null);child.emit('close',0,null);});
    return child;
  };
  assert.equal((await spawnPtSiteChild({...args,fallbackAttemptId,spawnChild:ownAttemptChild})).status,'unknown');
  const readOnlyChild=(_node,argv,options)=>{
    assert.deepEqual(argv.slice(1,5),[args.origin,args.catalogFile,args.catalogHash,'--read-only']);
    assert.equal(options.env.CHECKIN_V2_ENGINE_LEASE,'lease-fixture');
    assert.equal(options.env.CHECKIN_PT_FALLBACK_ATTEMPT_ID,undefined);
    const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();child.kill=()=>{};
    setImmediate(()=>{child.stdout.write(JSON.stringify({origin:args.origin,status:'unknown',observedAt:'2026-09-20T01:00:00Z',evidence:{source:'none',authoritative:false}}));child.emit('exit',0,null);child.emit('close',0,null);});
    return child;
  };
  assert.equal((await spawnPtSiteChild({...args,readOnly:true,fallbackAttemptId,spawnChild:readOnlyChild})).status,'unknown');
  const guardedChild=(_node,argv,options)=>{
    assert.deepEqual(argv.slice(1,5),[args.origin,args.catalogFile,args.catalogHash,'--verify-before-submit']);
    assert.equal(options.env.CHECKIN_PT_FALLBACK_RECHECK,'1');
    const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();child.kill=()=>{};
    setImmediate(()=>{child.stdout.write(JSON.stringify({origin:args.origin,status:'already_signed',observedAt:'2026-09-20T01:00:00Z',submissionAttempted:true,evidence:{source:'page_text',authoritative:true}}));child.emit('exit',0,null);child.emit('close',0,null);});
    return child;
  };
  assert.equal((await spawnPtSiteChild({...args,verifyBeforeSubmit:true,spawnChild:guardedChild})).status,'already_signed');
  const busy=()=>{const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();child.kill=()=>{};setImmediate(()=>{child.emit('exit',3,null);child.emit('close',3,null);});return child;};
  await assert.rejects(()=>spawnPtSiteChild({...args,spawnChild:busy}),/already active/);
  for(const diagnostic of [{error:'PT_PREFLIGHT',reason:'catalog_hash_changed'},
    {error:'PT_PREFLIGHT',reason:'arbitrary-private-output'},null]){
    const preflight=()=>{
      const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();child.kill=()=>{};
      setImmediate(()=>{child.stderr.write(diagnostic?JSON.stringify(diagnostic):'unstructured private output');child.emit('exit',4,null);child.emit('close',4,null);});
      return child;
    };
    await assert.rejects(()=>spawnPtSiteChild({...args,spawnChild:preflight}),error=>{
      assert.equal(error.code,'PT_PREFLIGHT');
      assert.equal(error.preflightReason,diagnostic?.reason==='catalog_hash_changed'?'catalog_hash_changed':undefined);
      assert.doesNotMatch(error.message,/private|arbitrary/);return true;
    });
  }
});
