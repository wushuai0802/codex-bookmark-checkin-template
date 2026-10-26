import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {siteFaultCodes} from './checkin-contract.generated.mjs';

const day=value=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai'}).format(new Date(value));
const hash=value=>crypto.createHash('sha256').update(value).digest('hex');
const canonical=value=>path.resolve(value).replaceAll('\\','/').toLowerCase();
const read=file=>JSON.parse(fs.readFileSync(file,'utf8'));
const identity=value=>{
  const url=new URL(value.origin);
  if(url.protocol!=='https:'||url.origin!==value.origin||url.username||url.password)throw Error('invalid notification identity');
  return url.origin+'|'+(String(value.accountKey??'').trim()||'site-default');
};
const dated=(value,businessDate,now)=>Number.isFinite(Date.parse(value))&&Date.parse(value)<=now.getTime()+60_000&&day(value)===businessDate;
const positive=value=>['signed','already_signed'].includes(value?.status)&&value.evidence?.authoritative===true;
const samePlan=(report,snapshot)=>{
  const expected=(report.bookmarkSummary?.targets??[]).map(identity).sort(),actual=(snapshot.tasks??[]).map(identity).sort();
  return new Set(expected).size===expected.length&&actual.length===expected.length&&actual.every((key,index)=>key===expected[index]);
};
const currentSnapshot=({report,snapshot,now})=>Array.isArray(report?.bookmarkSummary?.targets)&&Array.isArray(report?.results)&&
  snapshot?.businessDate===day(now)&&snapshot?.source?.runId===report.runId&&dated(snapshot.generatedAt,day(now),now)&&
  now.getTime()-Date.parse(snapshot.generatedAt)<=60*60_000&&Array.isArray(snapshot.tasks)&&samePlan(report,snapshot)&&
  snapshot.tasks.every(task=>task.businessDate===day(now));
const validAvailability=(item,businessDate,now)=>(item?.condition==='site_maintenance'||
  item?.condition==='upstream_unavailable'&&siteFaultCodes.includes(item.failureCode))&&item.businessDate===businessDate&&
  dated(item.observedAt,businessDate,now)&&dated(item.verifiedAt,businessDate,now)&&
  Date.parse(item.observedAt)<=Date.parse(item.verifiedAt)+60_000&&now.getTime()-Date.parse(item.verifiedAt)<=60*60_000;
const projectAvailability=item=>({origin:item.origin,accountKey:item.accountKey??'site-default',condition:item.condition,
  ...(item.condition==='upstream_unavailable'?{failureCode:item.failureCode}:{}),
  businessDate:item.businessDate,observedAt:new Date(item.observedAt).toISOString(),verifiedAt:new Date(item.verifiedAt).toISOString(),
  summary:item.condition==='site_maintenance'?'站点维护，恢复后只读核验':'站点服务异常，恢复后只读核验'});

// Site-wide availability changes notification wording only. It is never a
// completion receipt or permission to retry an uncertain account submission.
export function notificationAvailability({report,snapshot,now=new Date()}={}){
  if(!currentSnapshot({report,snapshot,now})||snapshot.ptStatus?.businessDate!==day(now))return [];
  return snapshot.tasks.flatMap(task=>{
    const results=report.results.filter(result=>identity(result)===identity(task));
    if(results.length!==1||['signed','already_signed','not_available'].includes(results[0].status))return [];
    const sites=(snapshot.ptStatus.sites??[]).filter(site=>site.origin===task.origin&&(!site.accountRef||site.accountRef===task.accountRef));
    if(sites.length!==1||sites[0].discrepancy===true)return [];
    const current=sites[0].effective;
    const condition=current?.siteCondition==='site_maintenance'?'site_maintenance':
      siteFaultCodes.includes(current?.failureCode)?'upstream_unavailable':null;
    if(current?.fresh!==true||!condition||['signed','already_signed','not_available'].includes(current.status))return [];
    const item={origin:task.origin,accountKey:task.accountKey??'site-default',condition,
      ...(condition==='upstream_unavailable'?{failureCode:current.failureCode}:{}),
      businessDate:day(now),observedAt:current.observedAt,verifiedAt:snapshot.generatedAt};
    return validAvailability(item,day(now),now)?[projectAvailability(item)]:[];
  });
}

// Add only privately authorized PT-only work. The shared inventory projection
// owns deduplication; the ordinary report keeps its original account contract.
export function notificationSupplementalResults({report,snapshot,now=new Date(),projectWorkload}={}){
  if(!currentSnapshot({report,snapshot,now})||snapshot.ptStatus?.businessDate!==day(now)||typeof projectWorkload!=='function')return [];
  const ptStatus={...snapshot.ptStatus,sites:(snapshot.ptStatus.sites??[]).map(site=>{
    const url=new URL(site.origin);
    if(url.protocol!=='https:'||url.origin!==site.origin||url.username||url.password)throw Error('invalid supplemental notification origin');
    const effective=site.effective??{},evidence=effective.evidence??{};
    const fresh=effective.fresh===true&&dated(effective.observedAt,day(now),now)&&
      (!['signed','already_signed'].includes(effective.status)||evidence.businessDate===day(now)&&
        dated(evidence.confirmedAt??effective.observedAt,day(now),now));
    return {...site,effective:{...effective,fresh}};
  })};
  const workload=projectWorkload({tasks:snapshot.tasks,ptStatus,businessDate:day(now),counts:snapshot.counts});
  return workload.tasks.filter(task=>task.ptSupplementOnly===true).map(task=>{
    const verified=task.evidence?.authoritative===true,status=['signed','already_signed'].includes(task.observedStatus)&&!verified
      ?'needs_attention':task.observedStatus;
    const external=task.condition==='site_maintenance'||task.condition==='upstream_unavailable'&&siteFaultCodes.includes(task.failureCode);
    return {origin:task.origin,accountKey:'site-default',status,
      ...(status==='not_available'&&task.condition==='task_disabled'?{availabilityKind:'task_disabled',disabledByConfig:true}:{}),
      ...(task.failureCode?{failureCode:task.failureCode}:{}),
      ...(typeof task.submissionAttempted==='boolean'?{submissionAttempted:task.submissionAttempted}:{}),
      ...(external?{notificationAvailabilityObserved:true,availability:{condition:task.condition,
        ...(task.condition==='upstream_unavailable'?{failureCode:task.failureCode}:{}),businessDate:day(now),observedAt:task.observedAt},retryCause:'upstream_unavailable'}:{}),
      evidence:{source:task.evidence?.source??'none',authoritative:verified,businessDate:day(now),
        confirmedAt:task.observedAt,summary:external?'站点服务异常，恢复后只读核验':verified?'当日 PT 证据已确认':'尚无当日权威签到证据'}};
  });
}

export function notificationOverrides({report,snapshot,confirmed,now=new Date()}={}){
  const businessDate=day(now);
  if(!currentSnapshot({report,snapshot,now}))return [];
  const receipts=new Map((snapshot.receipts??[]).map(value=>[value.taskId,value]));
  return snapshot.tasks.flatMap(task=>{
    const current=confirmed.get(task.origin+'|'+(task.accountRef??'site-default'));
    if(!current||receipts.get(task.taskId)?.evidence?.verification==='identity_conflict'||!positive(current)||
      current.evidence.businessDate!==businessDate||!dated(current.observedAt,businessDate,now))return [];
    const confirmedAt=current.evidence.confirmedAt??current.observedAt;
    if(!dated(confirmedAt,businessDate,now))return [];
    return [{origin:task.origin,accountKey:task.accountKey??'site-default',status:'already_signed',
      evidence:{source:String(current.evidence.source??'pt_page').slice(0,80),authoritative:true,
        confirmedAt:new Date(confirmedAt).toISOString(),businessDate,evidenceScope:'site_account_day'}}];
  });
}

export async function reconcileNotification({root,report,now=new Date(),persist=false}={}){
  root=path.resolve(root);
  const none={bound:false,ready:true,overrides:[]};
  let binding;
  try{
    const integration=read(path.join(root,'data/v2-integration.json'));
    if(integration.executionEngine!=='v1'||!path.isAbsolute(integration.v2ProjectRoot??''))return none;
    const controller=path.resolve(integration.v2ProjectRoot),runtime=read(path.join(controller,'config/runtime.local.json'));
    if(runtime.executionEngine!=='v1'||canonical(runtime.legacyRoot??'.')!==canonical(root))return none;
    binding=controller;
  }catch{return fs.existsSync(path.join(root,'data/v2-integration.json'))?{bound:true,ready:false,overrides:[]}:none;}
  const businessDate=day(now),targets=report?.bookmarkSummary?.targets;
  if(!Array.isArray(targets)||!Array.isArray(report?.results)||!/^[a-f0-9]{64}$/.test(report.bookmarkSummary.planFingerprint??'')||
    !String(report.runId??'').startsWith(businessDate.replaceAll('-','')+'-')||!dated(report.finishedAt,businessDate,now))
    return {bound:true,ready:false,overrides:[]};
  try{
    const latest=read(path.join(root,'logs/latest.json'));
    if(dated(latest.finishedAt,businessDate,now)&&Date.parse(latest.finishedAt)>Date.parse(report.finishedAt))
      return {bound:true,ready:false,overrides:[],superseded:true};
  }catch{/* A saved report still requires the verified observation binding below. */}
  const expected=new Set(targets.map(identity));
  const scope=hash(JSON.stringify([canonical(binding),report.bookmarkSummary.planFingerprint,[...expected].sort()]));
  const file=path.join(root,'data/notification-reconciliation',businessDate+'.json');
  let previous;
  try{previous=read(file);}catch{}
  const retained=new Map(),availability=new Map();
  if(previous?.schemaVersion===1&&previous.businessDate===businessDate&&previous.scope===scope){
    for(const item of previous.overrides??[]){
      try{if(expected.has(identity(item))&&positive(item)&&item.evidence.businessDate===businessDate&&
        dated(item.evidence.confirmedAt,businessDate,now))retained.set(identity(item),item);}catch{}
    }
    for(const item of Array.isArray(previous.availability)?previous.availability:[]){
      try{if(expected.has(identity(item))&&validAvailability(item,businessDate,now))availability.set(identity(item),projectAvailability(item));}catch{}
    }
  }
  let valid=false,supplementalResults=[];
  try{
    const [{readDashboardGeneration},{confirmedPtByTask},{authorizedWorkload}]=await Promise.all([
      import(pathToFileURL(path.join(binding,'src/dashboard-generation.mjs')).href),
      import(pathToFileURL(path.join(binding,'src/daily-reconciliation.mjs')).href),
      import(pathToFileURL(path.join(binding,'src/workload-view.mjs')).href),
    ]);
    const generation=readDashboardGeneration(path.join(binding,'outputs'));
    if(generation&&!generation.stale){
      const snapshot=generation.current.snapshot;
      valid=currentSnapshot({report,snapshot,now});
      supplementalResults=notificationSupplementalResults({report,snapshot,now,projectWorkload:authorizedWorkload});
      const fresh=notificationOverrides({report,snapshot,confirmed:confirmedPtByTask(snapshot),now});
      for(const item of fresh)retained.set(identity(item),item);
      if(valid){
        availability.clear();
        for(const item of notificationAvailability({report,snapshot,now}))availability.set(identity(item),item);
      }
      // A newer authoritative negative or identity conflict is meaningful,
      // unlike a late raw engine unknown or a missing observation sidecar.
      if(valid)for(const task of snapshot.tasks??[]){
        const key=identity(task),old=retained.get(key),site=(snapshot.ptStatus?.sites??[]).find(site=>site.origin===task.origin&&
          (!site.accountRef||site.accountRef===task.accountRef)),current=site?.effective;
        if(old&&(snapshot.receipts??[]).some(value=>value.taskId===task.taskId&&value.evidence?.verification==='identity_conflict'))retained.delete(key);
        if(old&&current?.status==='not_signed'&&current.authoritative===true&&current.fresh===true&&
          dated(current.observedAt,businessDate,now)&&Date.parse(current.observedAt)>Date.parse(old.evidence.confirmedAt))retained.delete(key);
      }
    }
  }catch{valid=false;supplementalResults=[];/* A temporary sidecar outage cannot downgrade a verified daily receipt. */}
  const overrides=[...retained.values()].sort((a,b)=>identity(a).localeCompare(identity(b)));
  const currentAvailability=[...availability.values()].sort((a,b)=>identity(a).localeCompare(identity(b)));
  if(persist&&(valid||overrides.length||currentAvailability.length)){
    fs.mkdirSync(path.dirname(file),{recursive:true});
    const temporary=file+'.'+crypto.randomUUID()+'.tmp';
    try{fs.writeFileSync(temporary,JSON.stringify({schemaVersion:1,businessDate,scope,overrides,availability:currentAvailability}),{mode:0o600});fs.renameSync(temporary,file);}
    finally{if(fs.existsSync(temporary))fs.unlinkSync(temporary);}
  }
  return {bound:true,ready:valid||overrides.length>0||currentAvailability.length>0,overrides,availability:currentAvailability,
    supplementalResults,scope:valid?'authorized_workload':'regular_tasks'};
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{
    const args=process.argv.slice(2),root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
    if(!['--report'].includes(args[0])||!args[1]||args.slice(2).some(value=>value!=='--persist'))throw Error('invalid notification request');
    const reportFile=path.resolve(args[1]),relative=path.relative(path.join(root,'logs'),reportFile);
    if(relative.startsWith('..')||path.isAbsolute(relative))throw Error('notification report outside logs');
    console.log(JSON.stringify(await reconcileNotification({root,report:read(reportFile),persist:args.includes('--persist')})));
  }catch{console.log(JSON.stringify({bound:false,ready:false,overrides:[]}));}
}
