import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {acquireExecutionLock,releaseExecutionLock} from './execution-lock.mjs';
import {runPtSite} from './pt-site-execution.mjs';
import {recordPtVerification} from './pt-verification.mjs';
import {boundMonitorCatalog} from './monitor-catalog.mjs';
import {loadEffectiveConfig} from './effective-config.mjs';
const dayAt=value=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai'}).format(value);
const read=file=>JSON.parse(fs.readFileSync(file,'utf8').replace(/^\uFEFF/,''));

export function ptEvidenceCandidates(snapshot,catalog,state,now=new Date()){
  const today=dayAt(now);
  if(snapshot?.businessDate!==today)return [];
  const receipts=new Map((snapshot.receipts??[]).map(r=>[r.taskId,r]));
  const origins=new Set((catalog.sites??[]).map(s=>s.origin));
  return (snapshot.tasks??[]).filter(t=>{
    const readbackReview=t.observedStatus==='needs_attention'&&t.failureCode==='submission_outcome_unknown'&&t.submissionAttempted===true;
    const positiveWithoutEvidence=['signed','already_signed'].includes(t.observedStatus);
    if(!origins.has(t.origin)||(!positiveWithoutEvidence&&!readbackReview)||receipts.get(t.taskId)?.evidence?.authoritative===true)return false;
    const previous=state.sites?.[t.origin];
    return !previous||previous.businessDate!==today||previous.attempts<2&&Date.parse(previous.nextAttemptAt)<=now.getTime();
  }).map(t=>t.origin).filter((origin,index,all)=>all.indexOf(origin)===index);
}

export function refreshEvidenceCatalog(root,catalogFile,now=new Date()){
  const runtime=read(path.join(root,'config/runtime.local.json')),config=loadEffectiveConfig(runtime.legacyRoot);
  const previous=read(catalogFile);
  const catalog=boundMonitorCatalog(config.bookmarksPath,previous.scope,now);
  const file=path.join(root,'data/pt-evidence-catalog.json');
  fs.mkdirSync(path.dirname(file),{recursive:true});
  const temporary=file+'.'+process.pid+'.tmp';
  try{fs.writeFileSync(temporary,JSON.stringify(catalog),{mode:0o600});fs.renameSync(temporary,file);}
  finally{if(fs.existsSync(temporary))fs.unlinkSync(temporary);}
  return file;
}

export async function repairPtEvidence({root,catalogFile,maxSites=1,clock=()=>new Date(),runSite=runPtSite,record=recordPtVerification,refreshCatalog=refreshEvidenceCatalog}={}){
  if(!Number.isInteger(maxSites)||maxSites<1||maxSites>4)throw Error('Evidence repair site limit must be 1..4');
  const lease=acquireExecutionLock(root,{name:'pt-evidence-repair.lock'});
  try {
    const snapshot=read(path.join(root,'outputs/shadow-beta-snapshot.json'));
    if(snapshot.businessDate!==dayAt(clock()))return {businessDate:snapshot.businessDate,results:[]};
    let currentCatalog=refreshCatalog(root,catalogFile,clock()),catalog=read(currentCatalog);
    const stateFile=path.join(root,'data/pt-evidence-repair.json');
    const state=fs.existsSync(stateFile)?read(stateFile):{schemaVersion:1,sites:{}};
    const now=clock(),candidates=ptEvidenceCandidates(snapshot,catalog,state,now).slice(0,maxSites),results=[];
    for(const origin of candidates){
      if(dayAt(clock())!==snapshot.businessDate)break;
      currentCatalog=refreshCatalog(root,catalogFile,clock());
      const hash=crypto.createHash('sha256').update(fs.readFileSync(currentCatalog)).digest('hex');
      const old=state.sites[origin],attempts=old?.businessDate===snapshot.businessDate?old.attempts+1:1;
      let outcome='evidence_unavailable';
      try{
        const result=await runSite({root,origin,catalogFile:currentCatalog,catalogHash:hash,readOnly:true});
        if(dayAt(clock())!==snapshot.businessDate)break;
        // A diagnostic cannot erase the already reported completion. Only a
        // current positive readback is published; other results stay in this audit.
        if(['signed','already_signed'].includes(result.status)&&result.evidence?.authoritative===true){
          const saved=record(root,result,{now:clock()});outcome=saved.recorded?'verified':'existing_receipt';
        }
      }catch(error){
        if(/already active|正在运行|正在启动|占用/i.test(error.message)){results.push({origin,outcome:'busy'});break;}
        outcome=error.code==='PT_READONLY_UNSAFE'||error.code==='PT_PREFLIGHT'?'capability_unavailable':'readback_unavailable';
      }
      state.sites[origin]={businessDate:snapshot.businessDate,attempts:['verified','existing_receipt'].includes(outcome)?2:attempts,
        outcome,checkedAt:clock().toISOString(),nextAttemptAt:new Date(clock().getTime()+2*3600000).toISOString()};
      results.push({origin,outcome});
      fs.mkdirSync(path.dirname(stateFile),{recursive:true});
      const temporary=stateFile+'.'+process.pid+'.tmp';
      try{fs.writeFileSync(temporary,JSON.stringify(state,null,2),{mode:0o600});fs.renameSync(temporary,stateFile);}
      finally{if(fs.existsSync(temporary))fs.unlinkSync(temporary);}
    }
    return {businessDate:snapshot.businessDate,results};
  }finally{releaseExecutionLock(lease);}
}
