import fs from 'node:fs';
import path from 'node:path';
import {loadRuntimeConfig} from './runtime-config.mjs';
import {runLegacyEngine} from './legacy-engine.mjs';
import {runPtSite,projectPtSiteResult} from './pt-site-execution.mjs';

const dayAt=date=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai'}).format(date);
const originOf=value=>{try{const u=new URL(value);return u.protocol==='https:'&&!u.username&&!u.password&&u.pathname==='/'&&!u.search&&!u.hash?u.origin:null;}catch{return null;}};
const terminal=new Set(['signed','already_signed']);
const failures=new Set(['failed','not_signed']);

export function planHarvestFallback({harvest,catalog,plan,latest,config={},now=new Date(),fallbackOnlyEnabled=false}={}) {
  const businessDate=dayAt(now),eligible=[],blocked=[];let observedSuccess=0;
  if(harvest?.source!=='harvest'||harvest.businessDate!==businessDate||!Array.isArray(harvest.sites)||
     !Number.isFinite(Date.parse(harvest.generatedAt))||Date.parse(harvest.generatedAt)>now.getTime()+60_000||
     now.getTime()-Date.parse(harvest.generatedAt)>30*60_000)throw Error('Harvest report is stale or invalid');
  if(!Array.isArray(catalog?.sites)||!Array.isArray(plan?.targets)||!Array.isArray(latest?.results))throw Error('execution plan or catalog missing');
  const currentV1=latest.runState==='final'&&latest.isComplete===true&&String(latest.runId??'').startsWith(businessDate.replaceAll('-','')+'-');
  const doneAt=Date.parse(harvest.taskCompletion?.completedAt),startedAt=Date.parse(harvest.taskCompletion?.startedAt);
  const harvestCompleted=harvest.taskCompletion?.status==='completed'&&Number.isInteger(harvest.taskCompletion.resultId)&&
    Number.isFinite(startedAt)&&Number.isFinite(doneAt)&&startedAt<=doneAt&&doneAt<=now.getTime()+60_000&&
    dayAt(new Date(startedAt))===businessDate&&dayAt(new Date(doneAt))===businessDate;
  const catalogByOrigin=new Map();
  for(const site of catalog.sites){
    const origin=originOf(site?.origin);
    if(!origin||catalogByOrigin.has(origin))throw Error('PT catalog has an invalid or duplicate origin');
    catalogByOrigin.set(origin,site);
  }
  const catalogOrigins=new Set(catalogByOrigin.keys());
  const registered=plan.targets.filter(target=>(target.folderNames??[]).some(folder=>typeof folder==='string'&&/pt/i.test(folder)));
  const observations=new Map(),assessments=[];
  const block=(origin,reason)=>{blocked.push({origin,reason});assessments.push({origin,state:'blocked',reason});};
  for(const site of harvest.sites){
    const origin=originOf(site?.origin);
    if(!origin||observations.has(origin)){block(origin??null,'invalid_or_duplicate_origin');continue;}
    observations.set(origin,site);
  }
  for(const target of registered){
    const origin=originOf(target.origin);
    if(origin&&!observations.has(origin))observations.set(origin,{origin,status:'unknown',missingFromHarvest:true});
  }
  for(const [origin,site] of observations){
    const confirmedAt=Date.parse(site.observedAt);
    const confirmed=terminal.has(site.status)&&site.evidence?.authoritative===true&&Number.isFinite(confirmedAt)&&dayAt(new Date(confirmedAt))===businessDate;
    if(confirmed){observedSuccess++;assessments.push({origin,state:'confirmed_by_harvest'});continue;}
    const status=terminal.has(site.status)?'unknown':site.status;
    if(!failures.has(status)&&status!=='unknown')continue;
    if(!harvestCompleted){block(origin,'harvest_task_not_complete');continue;}
    const at=status==='unknown'?doneAt:Date.parse(site.observedAt);
    if(!Number.isFinite(at)||at>now.getTime()+60_000||dayAt(new Date(at))!==businessDate||
       now.getTime()-at>26*3600_000){block(origin,'stale_failure');continue;}
    if(!catalogOrigins.has(origin)&&!registered.some(target=>originOf(target.origin)===origin)){
      block(origin,'outside_confirmed_bookmark_scope');continue;
    }
    if(!currentV1){block(origin,'v1_day_not_ready');continue;}
    const targets=registered.filter(t=>originOf(t.origin)===origin);
    if(targets.length>1){block(origin,'ambiguous_legacy_account');continue;}
    const target=targets[0],accountKey=target?.accountKey??'site-default';
    if(!target&&!fallbackOnlyEnabled){block(origin,'fallback_only_not_enabled');continue;}
    if((config.disabledCheckinOrigins??[]).includes(origin)||(config.disabledAccountKeys??[]).includes(accountKey)||
       (config.excludedOrigins??[]).includes(origin)){
      block(origin,'disabled_by_v1_configuration');continue;
    }
    let entryUrl=null;
    if(!target){
      entryUrl=catalogByOrigin.get(origin)?.entryUrl;
      try {
        const url=new URL(entryUrl);
        if(url.protocol!=='https:'||url.origin!==origin||url.username||url.password||url.search||url.hash||entryUrl.length>255)throw Error('invalid entry');
      } catch {block(origin,'fallback_entry_missing_or_unsafe');continue;}
    }
    const prior=latest.results.find(r=>r.origin===origin&&(r.accountKey??'site-default')===accountKey);
    if(prior&&terminal.has(prior.status)){assessments.push({origin,state:'confirmed_by_executor'});continue;}
    if(prior?.status==='not_available'){
      block(origin,'v1_feature_or_task_unavailable');continue;
    }
    if(prior?.failureCode==='submission_outcome_unknown'){
      block(origin,'submission_outcome_unknown');continue;
    }
    eligible.push({origin,accountKey,kind:target?'registered':'fallback_only',...(entryUrl?{entryUrl}:{}),observedAt:new Date(at).toISOString(),
      trigger:site.missingFromHarvest?'registered_pt_status_unobserved':status==='unknown'?'harvest_task_done_status_unknown':'harvest_explicit_failure'});
    assessments.push({origin,state:'executor_recheck_queued'});
  }
  return {schemaVersion:1,businessDate,source:'harvest',observedSuccess,registeredCount:registered.length,
    fallbackOnlyCount:[...catalogOrigins].filter(origin=>!registered.some(target=>originOf(target.origin)===origin)).length,
    assessments,eligible,blocked};
}

function writeAtomic(file,value){fs.mkdirSync(path.dirname(file),{recursive:true});const temporary=`${file}.${process.pid}.tmp`;fs.writeFileSync(temporary,JSON.stringify(value,null,2),{encoding:'utf8',mode:0o600});fs.renameSync(temporary,file);}

function claimWorker(root) {
  const file=path.join(root,'data/harvest-fallback.lock');fs.mkdirSync(path.dirname(file),{recursive:true});
  for(let attempt=0;attempt<2;attempt++){
    try{fs.writeFileSync(file,JSON.stringify({pid:process.pid,createdAt:new Date().toISOString()}),{flag:'wx'});return file;}
    catch(error){
      if(error.code!=='EEXIST')throw error;
      let old;try{old=JSON.parse(fs.readFileSync(file,'utf8'));}catch{throw Error('Harvest fallback lock is unreadable');}
      try{process.kill(old.pid,0);}catch(e){if(e.code==='ESRCH'){fs.rmSync(file,{force:true});continue;}}
      throw Error('Harvest fallback worker is already active');
    }
  }
  throw Error('Harvest fallback lock unavailable');
}

export async function runHarvestFallback({root=path.resolve('.'),harvest,catalog,plan,latest,config={},now=new Date(),execute=false,
  catalogFile=null,catalogHash=null,fallbackOnlyEnabled=false,runEngine=runLegacyEngine,runSite=runPtSite}={}) {
  const preview=planHarvestFallback({harvest,catalog,plan,latest,config,now,fallbackOnlyEnabled});
  if(!execute)return {...preview,mode:'preview'};
  const runtime=loadRuntimeConfig(root);
  if(runtime.executionEngine!=='v1'||!runtime.legacyRoot)throw Error('Harvest fallback requires the V1 execution engine');
  const integration=JSON.parse(fs.readFileSync(path.join(runtime.legacyRoot,'data/v2-integration.json'),'utf8'));
  if(integration.executionEngine!=='v1'||path.resolve(integration.v2ProjectRoot)!==path.resolve(root))throw Error('Harvest fallback engine bindings disagree');
  if(preview.eligible.some(item=>item.kind==='fallback_only')&&(!catalogFile||!/^[a-f0-9]{64}$/i.test(catalogHash??'')))throw Error('PT fallback needs the bound bookmark catalog');
  if(!preview.eligible.length)return {...preview,mode:'executed',outcomes:[]};
  const workerLock=claimWorker(root);
  try{
  const stateFile=path.join(root,'outputs',`harvest-fallback-attempts-${preview.businessDate}.json`);
  let state={schemaVersion:1,businessDate:preview.businessDate,attempts:[]};
  if(fs.existsSync(stateFile)){
    state=JSON.parse(fs.readFileSync(stateFile,'utf8'));
    if(state.businessDate!==preview.businessDate||!Array.isArray(state.attempts))throw Error('Harvest fallback audit is invalid');
  }
  const outcomes=[];
  const statusFile=path.join(root,'outputs',`pt-fallback-results-${preview.businessDate}.json`);
  for(const candidate of preview.eligible){
    if(state.attempts.some(item=>item.origin===candidate.origin&&item.state!=='deferred_busy')){outcomes.push({origin:candidate.origin,state:'already_attempted'});continue;}
    // Persist before executing. An interrupted or uncertain attempt is not replayed.
    const attempt={origin:candidate.origin,accountKey:candidate.accountKey,observedAt:candidate.observedAt,startedAt:new Date().toISOString(),state:'in_progress'};
    state.attempts.push(attempt);writeAtomic(stateFile,state);
    try{
      if(candidate.kind==='fallback_only'){
        const result=projectPtSiteResult(await runSite({root,origin:candidate.origin,catalogFile,catalogHash}),candidate.origin);
        if(dayAt(new Date(result.observedAt))!==preview.businessDate||Date.parse(result.observedAt)>now.getTime()+60_000)throw Error('PT site result is not from today');
        let report={schemaVersion:1,source:'execution-supplement',businessDate:preview.businessDate,generatedAt:now.toISOString(),sites:[]};
        if(fs.existsSync(statusFile)){
          report=JSON.parse(fs.readFileSync(statusFile,'utf8'));
          if(report.source!=='execution-supplement'||report.businessDate!==preview.businessDate||!Array.isArray(report.sites))throw Error('PT status audit is invalid');
        }
        report.generatedAt=new Date().toISOString();
        report.sites=report.sites.filter(site=>site.origin!==candidate.origin);
        report.sites.push(result);writeAtomic(statusFile,report);
        attempt.v1Status=result.status;
      }else{
        const report=await runEngine({root,mode:'execute',origins:[candidate.origin],notify:false});
        attempt.runId=report.runId??null;
        attempt.v1Status=report.results?.find(r=>r.origin===candidate.origin&&r.accountKey===candidate.accountKey)?.status??'unknown';
      }
      attempt.state='completed';
    }catch(error){
      attempt.state=error.message==='V2 runner is already active'?'deferred_busy':'outcome_unknown';
      attempt.reason=String(error.message).slice(0,120);
    }
    writeAtomic(stateFile,state);
    outcomes.push({origin:candidate.origin,state:attempt.state,v1Status:attempt.v1Status??null});
  }
  return {...preview,mode:'executed',outcomes};
  }finally{try{const owner=JSON.parse(fs.readFileSync(workerLock,'utf8'));if(owner.pid===process.pid)fs.rmSync(workerLock,{force:true});}catch{}}
}

export function loadHarvestFallbackInputs({root,reportFile,catalogFile}={}) {
  const legacyRoot=loadRuntimeConfig(root).legacyRoot;
  if(!legacyRoot)throw Error('legacy root is required');
  return {harvest:JSON.parse(fs.readFileSync(reportFile,'utf8')),
    catalog:JSON.parse(fs.readFileSync(catalogFile,'utf8')),
    plan:JSON.parse(fs.readFileSync(path.join(legacyRoot,'data/last-valid-bookmark-plan.json'),'utf8')),
    config:JSON.parse(fs.readFileSync(path.join(legacyRoot,'config/config.json'),'utf8')),
    latest:JSON.parse(fs.readFileSync(path.join(legacyRoot,'logs/latest.json'),'utf8'))};
}
