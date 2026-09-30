import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {enqueueOperation,claimOperation,finishOperation,operationView,operationTargets} from '../src/dashboard-operations.mjs';
import {validateDashboardOperation,executeDashboardOperation} from '../src/dashboard-operation-executor.mjs';
import {createDashboardServer} from '../src/dashboard-server.mjs';
import {buildSnapshot,writeSnapshot} from '../src/bridge.mjs';
import {fileURLToPath} from 'node:url';
import {createLedgerRecord,appendLedgerRecord} from '../src/shadow-ledger.mjs';
const now=new Date('2026-09-30T06:00:00Z'),origin='https://cspt.top';
const fixture=()=>({businessDate:'2026-09-30',generatedAt:now.toISOString(),planHash:'a'.repeat(64),tasks:[],ptStatus:{sites:[{
  origin,accountRef:null,inLegacyPlan:false,fallbackEnabled:true,effective:{status:'not_signed',authoritative:true,fresh:true}}]}});
function workspace(t){const root=fs.mkdtempSync(path.join(os.tmpdir(),'dashboard-ops-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return root;}
test('dashboard requests are exact-scoped, idempotent and never submit from the server',t=>{
  const root=workspace(t),snapshot=fixture(),input={origin,accountRef:null,action:'verify'};
  const first=enqueueOperation(root,input,snapshot,now),second=enqueueOperation(root,input,snapshot,now);
  assert.equal(second.duplicate,true);assert.equal(first.request.id,second.request.id);
  for(const invalid of [{...input,origin:'https://foreign.example'},{...input,action:'shell'},{...input,accountRef:'acct_'+('b'.repeat(16))}])
    assert.throws(()=>enqueueOperation(root,invalid,snapshot,now));
  assert.equal(operationView(root,now).requests.length,1);
  const claimed=claimOperation(root,now);assert.equal(claimed.id,first.request.id);assert.equal(claimOperation(root,now),null);
  assert.doesNotMatch(JSON.stringify(operationView(root,now)),/claimToken/);
  assert.throws(()=>finishOperation(root,{id:claimed.id,claimToken:'wrong',status:'completed',message:'done'},now),/lease/);
  const completed=finishOperation(root,{id:claimed.id,claimToken:claimed.claimToken,status:'completed',message:'今日已确认',resultStatus:'already_signed'},now);
  assert.equal(completed.status,'completed');
});
test('uncertain submissions and completed work cannot authorize a retry or login',()=>{
  for(const status of ['signed','already_signed','unknown','needs_attention']){
    const snapshot=fixture();snapshot.ptStatus.sites[0].effective.status=status;
    const actions=operationTargets(snapshot)[0].actions;assert.equal(actions.retry,false);assert.equal(actions.login,false);assert.equal(actions.verify,true);
  }
  const snapshot=fixture();snapshot.tasks=[{origin:'https://api.example',accountRef:'acct_'+('a'.repeat(16)),accountKey:'named',observedStatus:'needs_attention',failureCode:'submission_outcome_unknown'}];
  assert.equal(operationTargets(snapshot)[0].actions.resume,false);
});
test('expired requests and changed account plans never reach execution',t=>{
  const root=workspace(t),snapshot=fixture();enqueueOperation(root,{origin,action:'retry'},snapshot,now);
  assert.equal(claimOperation(root,new Date('2026-09-30T09:00:00Z')),null);
  assert.equal(operationView(root,new Date('2026-09-30T09:00:00Z')).requests[0].status,'expired');
  const request={id:'op_'+('a'.repeat(32)),origin,action:'retry',businessDate:snapshot.businessDate,planHash:snapshot.planHash,expiresAt:'2026-09-30T07:00:00Z'};
  assert.equal(validateDashboardOperation(request,snapshot,now).kind,'pt');
  assert.throws(()=>validateDashboardOperation({...request,planHash:'b'.repeat(64)},snapshot,now));
  assert.throws(()=>validateDashboardOperation({...request,accountRef:'acct_'+('b'.repeat(16))},snapshot,now));
  snapshot.ptStatus.sites[0].effective.status='already_signed';assert.equal(validateDashboardOperation(request,snapshot,now).skip,true);
});

test('operation API requires authentication, same-origin JSON and only queues a bounded request',async t=>{
  const root=workspace(t),legacyRoot=fileURLToPath(new URL('./fixtures/legacy/',import.meta.url));
  const snapshot=buildSnapshot({legacyRoot,generatedAt:new Date().toISOString()});
  snapshot.businessDate=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai'}).format(new Date());
  snapshot.ptStatus={sites:fixture().ptStatus.sites};
  writeSnapshot(snapshot,path.join(root,'shadow-beta-snapshot.json'),legacyRoot);
  appendLedgerRecord(path.join(root,'shadow-ledger.jsonl'),createLedgerRecord(snapshot),{legacyRoot});
  const {server}=createDashboardServer({dataDir:root,adminToken:'<fixture>',bind:'127.0.0.1',port:0});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
  const base='http://127.0.0.1:'+server.address().port;
  const request={method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({origin,action:'verify'})};
  assert.equal((await fetch(base+'/api/operations',request)).status,401);
  const authenticated={...request,headers:{...request.headers,'X-Fabric-Token':'<fixture>'}};
  assert.equal((await fetch(base+'/api/operations',{...authenticated,headers:{...authenticated.headers,Origin:'https://foreign.example'}})).status,409);
  const accepted=await fetch(base+'/api/operations',authenticated);assert.equal(accepted.status,202);
  assert.equal((await accepted.json()).request.status,'queued');assert.equal(operationView(root).requests.length,1);
});

test('Windows verification dispatch stays read-only and records the exact account-day receipt',async t=>{
  const root=workspace(t),current=new Date(),day=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai'}).format(current);
  const legacy=path.join(root,'legacy'),snapshot={...fixture(),businessDate:day,generatedAt:current.toISOString()};
  for(const dir of ['config','outputs','legacy/config','legacy/data'])fs.mkdirSync(path.join(root,dir),{recursive:true});
  const catalogFile=path.join(root,'catalog.json');fs.writeFileSync(catalogFile,JSON.stringify({sites:[{origin,entryUrl:origin+'/attendance.php'}]}));
  fs.writeFileSync(root+'/config/runtime.local.json',JSON.stringify({executionEngine:'v1',legacyRoot:legacy}));
  fs.writeFileSync(legacy+'/config/config.json','{}');fs.writeFileSync(legacy+'/data/v2-integration.json',JSON.stringify({harvestPtGate:{catalogFile}}));
  fs.writeFileSync(root+'/outputs/shadow-beta-snapshot.json',JSON.stringify(snapshot));
  let calls=0;
  const request={id:'op_'+('b'.repeat(32)),origin,action:'verify',businessDate:day,planHash:snapshot.planHash,expiresAt:new Date(current.getTime()+600000).toISOString()};
  const result=await executeDashboardOperation(root,request,{runSite:async options=>{
    calls++;assert.equal(options.readOnly,true);assert.equal(options.origin,origin);
    return {origin,status:'already_signed',accountKey:'site-default',profileBinding:'a'.repeat(64),businessDate:day,observedAt:current.toISOString(),
      operationMode:'safe_history_page',readSafety:'reviewed_passive',submissionAttempted:false,
      evidence:{source:'pt_page',authoritative:true,businessDate:day,confirmedAt:current.toISOString(),evidenceScope:'site_account_day',summary:'今日已签到'}};
  },runEngine:async()=>{throw Error('verification must never execute the regular runner');}});
  assert.equal(result.status,'completed');assert.equal(calls,1);
  assert.equal(JSON.parse(fs.readFileSync(root+'/outputs/pt-fallback-results-'+day+'.json')).sites[0].status,'already_signed');
});
