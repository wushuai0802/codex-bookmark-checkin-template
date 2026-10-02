import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {ptExecutionBinding} from '../src/pt-read-policy.mjs';
import {verifiedPtObservation} from '../src/pt-observation-receipt.mjs';
import {nativePtReadBinding} from '../src/native-pt-read.mjs';
import {updateSiteState} from '../src/site-state.mjs';
import {accountKeyForSelection,resultIdentity} from '../src/result-identity.mjs';
test('default account selection preserves legacy identity and excludes named accounts',()=>{
  const target={origin:'https://pt.example'};
  assert.equal(accountKeyForSelection(target),'site-default');
  assert.equal(resultIdentity(target),'https://pt.example');
  assert.notEqual(accountKeyForSelection({...target,accountKey:'secondary'}),'site-default');
});

test('a reviewed main Chrome receipt binds its configured source profile and cannot certify the robot or another account',t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'native-pt-receipt-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const observation=path.join(root,'observation'),sourceRoot=path.join(root,'main-chrome');
  for(const directory of ['data','observation/config','observation/outputs','main-chrome/Default'])fs.mkdirSync(path.join(root,directory),{recursive:true});
  fs.writeFileSync(path.join(sourceRoot,'Local State'),'fixture');
  fs.writeFileSync(path.join(root,'data/v2-integration.json'),JSON.stringify({executionEngine:'v1',v2ProjectRoot:observation}));
  fs.writeFileSync(path.join(observation,'config/runtime.local.json'),JSON.stringify({executionEngine:'v1',legacyRoot:root}));
  const target={origin:'https://ptsbao.club',accountKey:'site-default'},now=new Date('2026-10-02T02:00:00Z');
  const config={sourceUserDataDir:sourceRoot,bookmarksPath:path.join(sourceRoot,'Default/Bookmarks'),automationUserDataDir:path.join(root,'data/automation'),
    ptReadOnlyPolicies:{[target.origin]:{reviewed:true,mode:'safe_history_page',url:target.origin+'/index.php',selector:'#info_block',nativeMainChrome:true}}};
  const binding=nativePtReadBinding(config,target),receipt={...target,profileBinding:binding.profileBinding,status:'already_signed',businessDate:'2026-10-02',
    observedAt:now.toISOString(),submissionAttempted:false,operationMode:'safe_history_page',readSafety:'reviewed_passive',
    evidence:{source:'page_text',authoritative:true,businessDate:'2026-10-02',confirmedAt:now.toISOString(),pagePath:'/index.php',
      statusSignal:'nexus_daily_header_signed',evidenceScope:'site_account_day'}};
  const file=path.join(observation,'outputs/pt-fallback-results-2026-10-02.json');
  const write=value=>fs.writeFileSync(file,JSON.stringify({source:'execution-supplement',businessDate:'2026-10-02',sites:[value]}));
  write(receipt);
  assert.equal(verifiedPtObservation(root,target,config,now).status,'already_signed');
  assert.equal(verifiedPtObservation(root,{origin:target.origin},config,now).status,'already_signed');
  assert.equal(verifiedPtObservation(root,{...target,accountKey:'secondary'},config,now),null);
  write({...receipt,profileBinding:ptExecutionBinding(config,root,target).profileBinding});
  assert.equal(verifiedPtObservation(root,target,config,now),null);
  write(receipt);assert.equal(verifiedPtObservation(root,target,{...config,ptReadOnlyPolicies:{}},now),null);
});
test('bound passive PT receipt closes the executor quarantine without a browser action',t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'pt-receipt-import-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const observation=path.join(root,'observation');fs.mkdirSync(path.join(root,'data'));
  fs.mkdirSync(path.join(observation,'config'),{recursive:true});fs.mkdirSync(path.join(observation,'outputs'));
  fs.writeFileSync(path.join(root,'data/v2-integration.json'),JSON.stringify({executionEngine:'v1',v2ProjectRoot:observation}));
  fs.writeFileSync(path.join(observation,'config/runtime.local.json'),JSON.stringify({executionEngine:'v1',legacyRoot:root}));
  const target={origin:'https://open.cd',accountKey:'site-default'},config={automationUserDataDir:path.join(root,'data/automation')};
  const now=new Date('2026-09-30T02:00:00Z'),binding=ptExecutionBinding(config,root,target);
  const receipt={...target,profileBinding:binding.profileBinding,status:'already_signed',businessDate:'2026-09-30',
    observedAt:now.toISOString(),submissionAttempted:false,operationMode:'safe_history_page',readSafety:'reviewed_passive',
    evidence:{source:'pt_page',authoritative:true,businessDate:'2026-09-30',confirmedAt:now.toISOString(),pagePath:'/index.php',
      statusSignal:'open_cd_daily_record_entry',evidenceScope:'site_account_day'}};
  const file=path.join(observation,'outputs/pt-fallback-results-2026-09-30.json');
  const write=value=>fs.writeFileSync(file,JSON.stringify({source:'execution-supplement',businessDate:'2026-09-30',sites:[value]}));
  write(receipt);
  const result=verifiedPtObservation(root,target,config,now);
  assert.equal(result.status,'already_signed');assert.equal(result.submissionAttempted,false);
  const unlabelled=verifiedPtObservation(root,{origin:target.origin},config,now);
  assert.equal(unlabelled.accountKey,undefined);
  assert.equal(resultIdentity({...unlabelled,origin:target.origin}),target.origin);
  const state=updateSiteState({sites:{[target.origin]:{pendingOpenCdAt:'2026-09-30T01:00:00Z'}}},[{...target,...result}],now,config);
  assert.equal(state.sites[target.origin].pendingOpenCdAt,null);
  for(const invalid of [{...receipt,profileBinding:'b'.repeat(64)},{...receipt,accountKey:'secondary'},
    {...receipt,submissionAttempted:true},{...receipt,businessDate:'2026-09-29'},
    {...receipt,evidence:{...receipt.evidence,pagePath:'/attendance.php'}}]){
    write(invalid);assert.equal(verifiedPtObservation(root,target,config,now),null);
  }
});
