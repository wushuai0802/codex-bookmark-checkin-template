#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {dayVerdict,shanghaiDay} from '../observation/public/day-verdict.mjs';
import {verdictSnapshot} from '../observation/src/daily-reconciliation.mjs';

const categories=['done','verifying','actionNeeded','external','paused','noFeature'];
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const count=value=>Number.isSafeInteger(value)&&value>=0;
const hash=value=>crypto.createHash('sha256').update(value,'utf8').digest('hex');
const requireValue=value=>{if(!value)throw Error('invalid_baseline_input');};
const validDay=value=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value)&&
  Number.isFinite(Date.parse(value+'T00:00:00Z'))&&new Date(value+'T00:00:00Z').toISOString().slice(0,10)===value;
const time=value=>typeof value==='string'&&/(?:Z|[+-]\d{2}:\d{2})$/.test(value)&&Number.isFinite(Date.parse(value))?Date.parse(value):NaN;
const onDay=(value,date)=>Number.isFinite(time(value))&&shanghaiDay(value)===date;
const shiftDay=(date,offset)=>{
  const value=new Date(date+'T00:00:00Z');value.setUTCDate(value.getUTCDate()+offset);
  const result=Number.isFinite(value.getTime())?value.toISOString().slice(0,10):null;
  requireValue(validDay(result));return result;
};

// Only local, ordinary files are read. No runtime imports, child processes,
// writers, locks, notifier, login helper or network APIs are used by this tool.
function ordinary(file,directory=false){
  const absolute=path.resolve(file),base=path.parse(absolute).root;
  requireValue(!absolute.startsWith('\\\\')&&!absolute.startsWith('//'));
  let current=base;
  for(const piece of path.relative(base,absolute).split(path.sep).filter(Boolean)){
    current=path.join(current,piece);
    const stat=fs.lstatSync(current);
    if(stat.isSymbolicLink())throw Error('linked_input');
  }
  const stat=fs.lstatSync(absolute);
  requireValue(directory?stat.isDirectory():stat.isFile());
  return absolute;
}
function readText(file){
  try{return {value:fs.readFileSync(ordinary(file),{encoding:'utf8',flag:'r'}).replace(/^\uFEFF/,'')};}
  catch(error){return {code:error.code==='ENOENT'?'missing':'unreadable'};}
}
function readJson(file){
  const result=readText(file);if(result.code)return result;
  try{return {value:JSON.parse(result.value)};}catch{return {code:'invalid_json'};}
}
function list(directory){
  try{return {entries:fs.readdirSync(ordinary(directory,true),{withFileTypes:true})};}
  catch(error){return {entries:[],code:error.code==='ENOENT'?'missing':'unreadable'};}
}

export function parseBaselineOptions(argv,{now=new Date()}={}){
  const values={},flags=new Set();
  for(let i=0;i<argv.length;i++){
    const arg=argv[i];
    if(['--json','--sites'].includes(arg)){requireValue(!flags.has(arg));flags.add(arg);continue;}
    requireValue(['--config','--days','--until'].includes(arg)&&!Object.hasOwn(values,arg)&&
      typeof argv[i+1]==='string'&&argv[i+1].length>0&&!argv[i+1].startsWith('--'));
    values[arg]=argv[++i];
  }
  requireValue(Number.isFinite(new Date(now).getTime())&&Boolean(values['--config']));
  const days=values['--days']===undefined?7:Number(values['--days']);
  requireValue(count(days)&&days>0&&(values['--days']===undefined||/^[1-9]\d*$/.test(values['--days'])));
  const until=values['--until']??shiftDay(shanghaiDay(now),-1);
  requireValue(validDay(until));shiftDay(until,1-days);
  // Match doctor/release config resolution, without importing release actions.
  const configFile=path.resolve(values['--config']),loaded=readJson(configFile);
  requireValue(!loaded.code&&object(loaded.value));
  const config=loaded.value;
  requireValue(Object.keys(config).every(key=>['executionRoot','observationRoot','opsRoot','backupRoot','taskNames'].includes(key)));
  const roots={};
  for(const key of ['executionRoot','observationRoot','opsRoot','backupRoot'])if(Object.hasOwn(config,key)){
    requireValue(typeof config[key]==='string'&&config[key].trim().length>0);
    roots[key]=path.resolve(path.dirname(configFile),config[key]);
    requireValue(!roots[key].startsWith('\\\\')&&!roots[key].startsWith('//'));
  }
  requireValue(roots.executionRoot&&roots.observationRoot);
  const runtimeRoots=[roots.executionRoot,roots.observationRoot,...(roots.opsRoot?[roots.opsRoot]:[])];
  requireValue(new Set(runtimeRoots.map(root=>process.platform==='win32'?root.toLowerCase():root)).size===runtimeRoots.length);
  return {...roots,days,until,json:flags.has('--json'),sites:flags.has('--sites')};
}

function domain(origin){
  try{
    const url=new URL(origin);
    if(!['https:','http:'].includes(url.protocol)||url.origin!==origin||url.username||url.password)return null;
    return host(url.hostname);
  }catch{return null;}
}
function host(value){
  return typeof value==='string'&&value.length<=253&&
    /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,62}$/i.test(value)?value.toLowerCase():null;
}
function siteRows(tasks,verdict){
  const byId=new Map(tasks.map(task=>[task.taskId,task])),seen=new Set(),sites=[];
  for(const item of verdict.items){
    if(!['verifying','actionNeeded','external'].includes(item.class))continue;
    const name=domain(byId.get(item.taskId)?.origin),key=name+'|'+item.class;
    if(name&&!seen.has(key)){seen.add(key);sites.push({domain:name,status:item.class});}
  }
  return sites.sort((a,b)=>a.domain.localeCompare(b.domain)||a.status.localeCompare(b.status));
}
function project(snapshot,at){
  requireValue(Array.isArray(snapshot.tasks)&&Array.isArray(snapshot.receipts??[]));
  requireValue(snapshot.tasks.every(task=>object(task)&&typeof task.taskId==='string'&&task.taskId.length>0&&domain(task.origin)));
  requireValue(new Set(snapshot.tasks.map(task=>task.taskId)).size===snapshot.tasks.length);
  const receipts=snapshot.receipts??[];
  requireValue(receipts.every(item=>object(item)&&snapshot.tasks.some(task=>task.taskId===item.taskId))&&
    new Set(receipts.map(item=>item.taskId)).size===receipts.length);
  const now=new Date(at),view=verdictSnapshot(snapshot,{now}),verdict=dayVerdict(view,{now});
  return {total:verdict.total,counts:verdict.counts,sites:siteRows(view.tasks,verdict)};
}

// Notification-Digest.ps1 persists the formatted verdict, not payload.dayVerdict
// or its scope. Its fixed regular_tasks warning is the durable scope signal.
function digest(item,file,date){
  requireValue(item.schemaVersion===1&&['eventKey','taskId','name','source','status','summary','payloadHash'].every(key=>typeof item[key]==='string'));
  requireValue(item.eventKey===`external:${item.source}:${item.taskId}:${date}`&&onDay(item.createdAt,date));
  requireValue(file===hash(item.eventKey)+'.json'&&item.payloadHash===hash(
    [item.eventKey,item.taskId,item.name,item.source,item.status,item.summary].join('\n')));
  const text=item.summary.replaceAll('\r\n','\n');
  const match=text.match(/^签到日报 (\d{2})-(\d{2})\n有效 (\d+)：已完成 (\d+)，核验中 (\d+)，需处理 (\d+)\n外部阻断 (\d+) · 已暂停 (\d+) · 无此功能 (\d+)(?:\n|$)/);
  requireValue(match&&date.slice(5)===match[1]+'-'+match[2]);
  const [total,...numbers]=match.slice(3).map(Number),counts=Object.fromEntries(categories.map((key,index)=>[key,numbers[index]]));
  requireValue([total,...numbers].every(count)&&count(numbers.reduce((sum,n)=>sum+n,0))&&total===counts.done+counts.verifying+counts.actionNeeded);
  requireValue(item.status===(counts.actionNeeded?'needs_attention':counts.verifying?'unconfirmed':'success'));
  const sites=[],seen=new Set(),section=text.split('\n\n需处理\n')[1]?.split('\n\n')[0]??'';
  for(const line of section.split('\n')){
    const name=host(line.match(/^• ([a-z0-9.-]+)：/i)?.[1]);
    if(name&&!seen.has(name)){seen.add(name);sites.push({domain:name,status:'actionNeeded'});}
  }
  return {total,counts,sites:sites.sort((a,b)=>a.domain.localeCompare(b.domain)),at:time(item.createdAt),
    source:'daily_digest',complete:!text.includes('\n仅主任务口径，观测范围待同步'),
    sitesComplete:counts.verifying===0&&counts.external===0&&sites.length===counts.actionNeeded};
}

function loadDigests(root,dates,now){
  const records=new Map(),issues=new Map(),directory=path.join(root,'data/notification-outbox'),listing=list(directory);
  let readIssue=null;
  for(const entry of listing.entries){
    if(!entry.isFile()||entry.isSymbolicLink()||!/^([a-f0-9]{64})\.json$/.test(entry.name))continue;
    const loaded=readJson(path.join(directory,entry.name));
    if(loaded.code){readIssue='outbox_'+loaded.code;continue;}
    const item=loaded.value;
    if(!object(item)||typeof item.eventKey!=='string'||typeof item.source!=='string'||typeof item.taskId!=='string')continue;
    const prefix=`external:${item.source}:${item.taskId}:`,date=item.eventKey.startsWith(prefix)?item.eventKey.slice(prefix.length):null;
    if(!dates.has(date))continue; // Exception/per-change keys cannot masquerade as the daily digest.
    try{
      const record=digest(item,entry.name,date);requireValue(record.at<=now+60_000);
      records.set(date,[...(records.get(date)??[]),record]);
    }
    catch{issues.set(date,'daily_digest_invalid');}
  }
  return {records,issues,code:listing.code==='unreadable'?'outbox_unreadable':readIssue};
}
function loadSnapshots(root,dates,now){
  const records=new Map(),issues=new Map();
  for(const file of ['shadow-beta-snapshot.json','dashboard-generation.json','dashboard-generation.previous.json']){
    const loaded=readJson(path.join(root,'outputs',file));if(loaded.code)continue;
    const snapshot=file==='shadow-beta-snapshot.json'?loaded.value:loaded.value?.snapshot,date=snapshot?.businessDate;
    if(!dates.has(date))continue;
    try{
      requireValue(snapshot.schemaVersion===1&&snapshot.mode==='shadow_read_only'&&onDay(snapshot.generatedAt,date)&&time(snapshot.generatedAt)<=now+60_000);
      const view=project(snapshot,snapshot.generatedAt);
      const complete=!snapshot.ptStatus||snapshot.ptStatus.businessDate===date;
      records.set(date,[...(records.get(date)??[]),{...view,at:time(snapshot.generatedAt),source:'snapshot',complete,sitesComplete:complete}]);
    }catch{issues.set(date,'snapshot_invalid');}
  }
  return {records,issues};
}
function reportView(report,date,engine=false){
  const finishedAt=engine?report.sourceFinishedAt:report.finishedAt;
  requireValue(onDay(finishedAt,date)&&String(report.runId??'').startsWith(date.replaceAll('-','')+'-')&&Array.isArray(report.results));
  requireValue(!engine||report.businessDate===date&&report.completedCrossDay!==true);
  const targets=report.bookmarkSummary?.targets??report.results;
  requireValue(Array.isArray(targets)&&targets.every(object)&&report.results.every(object));
  const identity=item=>{requireValue(domain(item.origin));return JSON.stringify([item.origin,item.accountKey??'site-default']);};
  requireValue(new Set(targets.map(identity)).size===targets.length);
  const tasks=targets.map((target,index)=>{
    const matches=report.results.filter(result=>identity(result)===identity(target)),result=matches.length===1?matches[0]:{};
    return {...result,...target,taskId:'baseline_'+index,observedStatus:result.status,
      observedAt:result.observedAt??result.evidence?.confirmedAt??result.evidence?.createdAt};
  });
  return {...project({businessDate:date,tasks},finishedAt),at:time(finishedAt),complete:false,sitesComplete:false,
    source:engine?'engine_daily_partial':'execution_report_partial'};
}
function loadReports(executionRoot,observationRoot,dates,now){
  const records=new Map(),issues=new Map(),logs=path.join(executionRoot,'logs');
  const add=(report,date,engine=false)=>{
    try{
      const record=reportView(report,date,engine);requireValue(record.at<=now+60_000);
      records.set(date,[...(records.get(date)??[]),record]);
    }catch{issues.set(date,'execution_report_invalid');}
  };
  for(const entry of list(logs).entries){
    const match=entry.name.match(/^(\d{4})(\d{2})(\d{2})-[a-z0-9-]+$/i),date=match&&match.slice(1).join('-');
    if(!dates.has(date)||!entry.isDirectory()||entry.isSymbolicLink())continue;
    const loaded=readJson(path.join(logs,entry.name,'result.json'));
    if(loaded.code)issues.set(date,'execution_report_'+loaded.code);else add(loaded.value,date);
  }
  for(const date of dates){
    const loaded=readJson(path.join(observationRoot,'outputs',`engine-daily-${date}.json`));
    if(!loaded.code)add(loaded.value,date,true);
  }
  return {records,issues};
}
function ledgerDates(root,dates){
  const result=new Set(),loaded=readText(path.join(root,'outputs/shadow-ledger.jsonl'));
  if(loaded.code)return result;
  for(const line of loaded.value.split(/\r?\n/)){
    try{
      const item=JSON.parse(line);
      if(item?.schemaVersion===1&&dates.has(item.businessDate)&&Array.isArray(item.taskSummaries))result.add(item.businessDate);
    }catch{/* Lossy/malformed ledger rows are never used to invent verdict counts. */}
  }
  return result;
}
const blank=()=>({total:null,counts:Object.fromEntries(categories.map(key=>[key,null]))});
const rate=value=>value.total>0?value.counts.done/value.total:null;

export function runSuccessBaseline(options,{now=new Date()}={}){
  requireValue(object(options)&&count(options.days)&&options.days>0&&validDay(options.until));
  requireValue(typeof options.executionRoot==='string'&&typeof options.observationRoot==='string'&&Number.isFinite(new Date(now).getTime()));
  const first=shiftDay(options.until,1-options.days),dates=new Set(Array.from({length:options.days},(_,i)=>shiftDay(first,i)));
  const digests=loadDigests(options.executionRoot,dates,new Date(now).getTime()),snapshots=loadSnapshots(options.observationRoot,dates,new Date(now).getTime());
  const reports=loadReports(options.executionRoot,options.observationRoot,dates,new Date(now).getTime()),ledger=ledgerDates(options.observationRoot,dates);
  const days=[];
  for(const businessDate of dates){
    const daily=digests.records.get(businessDate)??[],saved=(snapshots.records.get(businessDate)??[]).sort((a,b)=>b.at-a.at);
    const raw=(reports.records.get(businessDate)??[]).sort((a,b)=>Number(a.source==='engine_daily_partial')-Number(b.source==='engine_daily_partial')||b.at-a.at);
    const conflict=daily.length>1||saved.length>1&&saved[0].at===saved[1].at&&JSON.stringify(saved[0])!==JSON.stringify(saved[1]);
    const selected=(daily.length===1&&daily[0].complete?daily[0]:null)??saved.find(item=>item.complete)??
      (daily.length===1?daily[0]:null)??saved[0]??raw[0];
    const complete=Boolean(selected?.complete)&&!conflict&&!digests.issues.has(businessDate);
    const missing=[];
    if(!complete){
      if(conflict)missing.push('daily_evidence_conflict');
      missing.push(digests.issues.get(businessDate)??digests.code??(daily.length===0?'daily_digest_missing':null));
      if(!saved.some(item=>item.complete))missing.push(snapshots.issues.get(businessDate)??'authorized_snapshot_missing');
      if(selected&&!selected.complete)missing.push('pt_verdict_inputs_missing');
      if(!selected)missing.push(reports.issues.get(businessDate)??'execution_report_missing');
      if(!selected&&ledger.has(businessDate))missing.push('ledger_verdict_fields_missing');
    }
    const view=selected??blank();
    const row={businessDate,total:view.total,counts:{...view.counts},completionRate:rate(view),
      manualInterventions:view.counts.actionNeeded,source:selected?.source??(ledger.has(businessDate)?'shadow_ledger_partial':'missing'),
      complete,missing:[...new Set(missing.filter(Boolean))]};
    if(options.sites){
      row.sites=selected?.sites??[];row.sitesComplete=Boolean(selected?.sitesComplete)&&complete;
      row.siteCodes=row.sitesComplete?[]:['unfinished_site_verdicts_not_retained'];
    }
    days.push(row);
  }
  const completeDays=days.filter(day=>day.complete),totals=completeDays.length?{total:0,counts:Object.fromEntries(categories.map(key=>[key,0]))}:blank();
  for(const row of completeDays){totals.total+=row.total;for(const key of categories)totals.counts[key]+=row.counts[key];}
  requireValue(!completeDays.length||count(totals.total)&&Object.values(totals.counts).every(count));
  return {schemaVersion:1,from:first,until:options.until,manualInterventionBasis:'action_needed_rows',days,
    totals:{scope:'complete_days_only',requestedDays:days.length,completeDays:completeDays.length,incompleteDays:days.length-completeDays.length,
      ...totals,completionRate:rate(totals),manualInterventions:totals.counts.actionNeeded}};
}

export function formatBaseline(result){
  const number=value=>value===null?'?':String(value),percent=value=>value===null?'?':(value*100).toFixed(2)+'%';
  const cells=row=>[number(row.total),...categories.map(key=>number(row.counts[key])),percent(row.completionRate),number(row.manualInterventions)];
  const lines=['日期 | 有效 | 已完成 | 核验中 | 需处理 | 外部阻断 | 已暂停 | 无此功能 | 完成率 | 人工干预需求 | 数据来源 | 完整性'];
  for(const row of result.days){
    lines.push([row.businessDate,...cells(row),row.source,row.complete?'完整':'不完整',...row.missing].join(' | '));
    if(row.sites){
      for(const item of row.sites)lines.push([row.businessDate,item.domain,item.status].join(' | '));
      if(!row.sitesComplete)lines.push([row.businessDate,...row.siteCodes].join(' | '));
    }
  }
  lines.push(['合计',...cells(result.totals),'complete_days_only',result.totals.completeDays+'/'+result.totals.requestedDays].join(' | '));
  lines.push('人工干预需求口径 | action_needed_rows');
  return lines.join('\n');
}

export function runBaselineCli(argv,{now=new Date(),stdout=value=>console.log(value),stderr=value=>console.error(value)}={}){
  try{
    const options=parseBaselineOptions(argv,{now}),result=runSuccessBaseline(options,{now});
    stdout(options.json?JSON.stringify(result,null,2):formatBaseline(result));
    return result.totals.incompleteDays?1:0;
  }catch{
    stderr(argv.includes('--json')?JSON.stringify({code:'baseline_unavailable'}):'baseline_unavailable');return 2;
  }
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))process.exitCode=runBaselineCli(process.argv.slice(2));
