// Read-only V1/V2 inventory. Output is private operational metadata, not credentials.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { readMonitorCatalog } from '../src/monitor-catalog.mjs';
import { classifyEvidence } from '../src/contracts.mjs';
const [legacy, ops, out] = process.argv.slice(2);
if (!legacy || !ops || !out) throw Error('Usage: audit-migration <legacy> <ops> <out>');
const root=path.resolve(legacy), dest=path.resolve(out);
if(dest.toLowerCase().startsWith(root.toLowerCase()+path.sep))throw Error('Output must be outside V1');
const read=file=>JSON.parse(fs.readFileSync(file,'utf8'));
const hash=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const config=read(path.join(root,'config/config.json'));
const local=read(path.join(root,'config/config.local.json'));
const latestFile=path.join(root,'logs/latest.json'), result=read(latestFile);
const planFile=path.join(root,'data/last-valid-bookmark-plan.json'), plan=read(planFile);
const snapshot=read(new URL('../outputs/shadow-beta-snapshot.json',import.meta.url));
const monitorConfig=read(path.join(ops,'config/pt-monitor.local.json'));
const catalog=readMonitorCatalog(config.bookmarksPath,monitorConfig);
const origin=value=>{try{return new URL(value).origin;}catch{return null;}};
const statuses=rows=>rows.reduce((a,r)=>(a[r.status]=(a[r.status]??0)+1,a),{});
const stations=result.results.map(row=>{
 const site=origin(row.origin),key=row.accountKey||'site-default';
 const identity=snapshot.tasks.find(t=>t.origin===site&&t.accountKey===key)?.identity;
 const group=config.oauthSiteSessionBindings?.[site];
 return {origin:site,title:row.title,accountKey:key,userId:row.accountId??identity?.userId??null,identitySource:row.accountId?'result':identity?.source??null,
   sourceStatus:row.status,sourceEvidence:row.evidence?.source??null,bridgeEvidence:classifyEvidence(row),
   category:(row.folderNames??[]).some(f=>/PT/i.test(f))?'pt':'welfare',
   executionAccount:config.oauthExecutionAccountBindings?.[site]??null,sessionGroup:group??null,
   isolated:!!row.accountKey||!!config.isolatedOAuthSiteProfiles?.[site]||!!group||!!config.oauthExecutionAccountBindings?.[site],
   actualOrigin:config.oauthRecoveryTargetOrigins?.[site]??site,
   relatedOrigins:[...new Set((config.relatedCandidateUrls?.[site]??[]).map(origin).filter(Boolean))]};
});
const siteSet=new Set(stations.map(s=>s.origin));
const observed=[]; const skipped=[];
const today=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai'}).format(new Date());
const start=new Date(`${today}T00:00:00+08:00`);start.setUTCDate(start.getUTCDate()-13);
const dateFromRun=id=>/^\d{8}-/.test(id)?`${id.slice(0,4)}-${id.slice(4,6)}-${id.slice(6,8)}`:null;
const seen=new Set();
for(const entry of fs.readdirSync(path.join(root,'logs'),{withFileTypes:true})){
 if(!entry.isDirectory()||entry.isSymbolicLink()||!/^\d{8}-/.test(entry.name))continue;
 const day=dateFromRun(entry.name);if(new Date(`${day}T00:00:00+08:00`)<start||day>today)continue;
 const file=path.join(root,'logs',entry.name,'result.json');
 if(!fs.existsSync(file))continue;
 if(fs.statSync(file).size>5_000_000){skipped.push(entry.name);continue;}
 try{const r=read(file);if(!Array.isArray(r.results)||seen.has(r.runId))continue;seen.add(r.runId);
 observed.push({runId:r.runId,date:day,finishedAt:r.finishedAt??null,final:r.runState==='final',isComplete:r.isComplete===true,
  count:r.results.length,status:statuses(r.results),pending:r.results.filter(x=>!['signed','already_signed','not_available'].includes(x.status)).map(x=>({origin:origin(x.origin),accountKey:x.accountKey??'site-default',status:x.status,cause:x.retryCause??x.failureCode??null})),
  durationMs:Number.isFinite(r.durationMs)?r.durationMs:null});
 }catch{skipped.push(entry.name);}
}
observed.sort((a,b)=>a.runId.localeCompare(b.runId));
const days=[...new Set(observed.map(r=>r.date))].map(date=>{
 const rows=observed.filter(r=>r.date===date),full=rows.filter(r=>r.final&&r.isComplete&&r.count===stations.length);
 return {date,reportCount:rows.length,firstFullObserved:full[0]??null,lastFullObserved:full.at(-1)??null};
});
const policyKeys=['schedule','navigationTimeoutMs','retryCount','recoveryRounds','oauthAccountAttempts','taskTimeoutMinutes','schedulerMaxDailyAttempts','upstreamFailureGroupMaxDailyAttempts','loginRetryMaxDailyAttempts','deferredRetryDelayMs','loginRetryDelayMs','taskRetryCount','taskRetryDelayMinutes'];
const audit={generatedAt:new Date().toISOString(),schemaVersion:1,scope:'read-only inventory; no task executions',
 evidence:{latestFileHash:hash(latestFile),planFileHash:hash(planFile),latestRunId:result.runId,latestFinishedAt:result.finishedAt,sourceCodeHashes:Object.fromEntries(['src/index.mjs','src/browser.mjs','src/retry-policy.mjs','scripts/Run-Checkin.ps1','scripts/Start-UserScheduler.ps1'].map(p=>[p,hash(path.join(root,p))]))},
 counts:{logicalSites:siteSet.size,accountTasks:stations.length,latestStatus:statuses(result.results),ptCatalog:catalog.sites.length,monitorOnly:catalog.sites.filter(s=>!siteSet.has(s.origin)).length},
 policies:Object.fromEntries(policyKeys.filter(k=>config[k]!==undefined).map(k=>[k,config[k]])),
 configMismatchKeys:Object.keys(local).filter(k=>JSON.stringify(local[k])!==JSON.stringify(config[k])),
 stations,monitorOnly:catalog.sites.filter(s=>!siteSet.has(s.origin)),
 history:{windowStart:start.toISOString(),windowEnd:today,reportCount:observed.length,days,skipped,limitations:'Reports include resume/manual/merged results. First observed full report is NOT first-attempt success; last observed report is NOT necessarily the daily final outcome. No denominator normalization across changed plans.'},
 acceptance:read(path.join(ops,'outputs/shadow-acceptance.json')),
 planTargetCount:plan.targets?.length??null};
fs.mkdirSync(path.dirname(dest),{recursive:true});fs.writeFileSync(dest,JSON.stringify(audit,null,2));
console.log(JSON.stringify({counts:audit.counts,historyReports:observed.length,historyDays:days.length,configMismatchKeys:audit.configMismatchKeys,output:dest}));
