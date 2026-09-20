import fs from 'node:fs';
import path from 'node:path';
import {spawn,spawnSync} from 'node:child_process';
import {loadRuntimeConfig} from './runtime-config.mjs';
import {acquireExecutionLock,releaseExecutionLock} from './execution-lock.mjs';
import {buildSnapshot,writeSnapshot} from './bridge.mjs';
import {redactText} from './contracts.mjs';

const read=file=>JSON.parse(fs.readFileSync(file,'utf8'));
const canonical=value=>path.resolve(value).toLowerCase();
export function validateEngineLease({root,legacyRoot,env=process.env}={}) {
  const runtime=loadRuntimeConfig(root);
  if(runtime.executionEngine!=='v1'||canonical(runtime.legacyRoot)!==canonical(legacyRoot)||canonical(env.CHECKIN_V2_ENGINE_ROOT??'.')!==canonical(root))throw Error('V2 engine binding mismatch');
  const lease=read(path.join(root,'data/v2-run.lock'));
  if(!env.CHECKIN_V2_ENGINE_LEASE||lease.nonce!==env.CHECKIN_V2_ENGINE_LEASE||!Number.isSafeInteger(lease.pid)||lease.pid<=0)throw Error('V2 engine lease mismatch');
  try{process.kill(lease.pid,0);}catch{throw Error('V2 engine owner is not running');}
  return true;
}

export function engineCommand({legacyRoot,mode,accountKeys=[],origins=[],notify=false}={}) {
  if(!['scheduled','execute','dry-run'].includes(mode))throw Error('invalid engine mode');
  for(const key of accountKeys)if(!/^[A-Za-z0-9._-]{1,80}$/.test(key))throw Error('invalid account key');
  for(const origin of origins){const url=new URL(origin);if(url.origin!==origin||url.protocol!=='https:'||url.username||url.password)throw Error('invalid origin');}
  if(mode!=='execute'&&(accountKeys.length||origins.length))throw Error('selection requires execute mode');
  const file=path.join(legacyRoot,'scripts',mode==='scheduled'?'Start-UserScheduler.ps1':'Run-Checkin.ps1');
  const args=['-NoProfile','-NonInteractive','-WindowStyle','Hidden','-ExecutionPolicy','Bypass','-File',file];
  if(mode==='scheduled')args.push('-Once');
  else{
    if(mode==='dry-run')args.push('-DryRun');else args.push('-Attempts','1');
    if(!notify)args.push('-SuppressReport');
    // PS -File receives one argument; the gateway shim expands comma lists.
    if(accountKeys.length)args.push('-AccountKeys',accountKeys.join(','));
    if(origins.length)args.push('-Origins',origins.join(','));
  }
  return args;
}

function writeAtomic(file,value){fs.mkdirSync(path.dirname(file),{recursive:true});const tmp=file+'.'+process.pid+'.tmp';fs.writeFileSync(tmp,JSON.stringify(value,null,2),'utf8');fs.renameSync(tmp,file);}

export function readLegacyHealth({root,legacyRoot,spawnHealth=spawnSync}={}) {
  const script=path.join(legacyRoot,'scripts/Test-CheckinHealth.ps1');
  const shell=loadRuntimeConfig(root).powershellExecutable;
  if(!shell||!fs.existsSync(script))return null;
  try{
    const result=spawnHealth(shell,['-NoProfile','-NonInteractive','-File',script],{cwd:legacyRoot,windowsHide:true,encoding:'utf8',timeout:60_000,maxBuffer:1_000_000});
    if(result.status!==0||result.error)return null;
    const health=JSON.parse(result.stdout);
    if(typeof health.healthy!=='boolean'||!Number.isFinite(Date.parse(health.checkedAt))||!Array.isArray(health.failedChecks))return null;
    return health;
  }catch{return null;}
}

export function publishEngineReport({root,legacyRoot,exitCode=null,requireFreshSince=null,now=new Date()}={}) {
  const latest=read(path.join(legacyRoot,'logs/latest.json'));
  const day=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai'}).format(now),stamp=day.replaceAll('-','');
  if(!String(latest.runId).startsWith(stamp+'-')||!Array.isArray(latest.results))throw Error('engine report is not from current business date');
  if(requireFreshSince&&Date.parse(latest.finishedAt)<Date.parse(requireFreshSince)-2000)throw Error('engine did not produce a fresh report');
  const currentHealth=readLegacyHealth({root,legacyRoot});
  const snapshot=buildSnapshot({legacyRoot,generatedAt:now.toISOString(),...(currentHealth?{healthReport:currentHealth}:{})});
  for(const task of snapshot.tasks){task.executionOwner='v2-worker';task.executionMode='v1_engine';}
  const results=latest.results.map(r=>({origin:new URL(r.origin).origin,accountKey:r.accountKey??'site-default',status:r.status,reason:redactText(r.reason??''),availabilityKind:r.availabilityKind??null}));
  const counts={completed:0,unavailable:0,unresolved:0};
  for(const r of results){if(['signed','already_signed'].includes(r.status))counts.completed++;else if(r.status==='not_available'&&r.availabilityKind!=='task_disabled')counts.unavailable++;else counts.unresolved++;}
  const report={schemaVersion:1,mode:'v2_v1_engine',executionEngine:'v1',businessDate:day,runId:latest.runId,sourceFinishedAt:latest.finishedAt,observedAt:now.toISOString(),healthCheckedAt:currentHealth?.checkedAt??null,plannedTotal:latest.plannedTotal,processedTotal:latest.processedTotal,executionComplete:latest.isComplete===true,businessComplete:latest.isComplete===true&&counts.unresolved===0,exitCode,counts,results};
  writeSnapshot(snapshot,path.join(root,'outputs/shadow-beta-snapshot.json'),legacyRoot);
  writeAtomic(path.join(root,'outputs',`engine-daily-${day}.json`),report);
  writeAtomic(path.join(root,'outputs/engine-latest.json'),report);
  // The main snapshot now contains engine results. Retired canary receipts
  // must not overlay failures/successes from the previous execution backend.
  writeAtomic(path.join(root,'outputs/dashboard-runtime.json'),{schemaVersion:1,generatedAt:now.toISOString(),executionEngine:'v1',owners:[],results:[]});
  return report;
}

export async function runLegacyEngine({root=path.resolve('.'),mode='dry-run',accountKeys=[],origins=[],notify=false,spawnChild=spawn}={}){
  const runtime=loadRuntimeConfig(root),legacyRoot=runtime.legacyRoot;
  if(runtime.executionEngine!=='v1'||!legacyRoot)throw Error('V1 engine is not selected');
  const integration=read(path.join(legacyRoot,'data/v2-integration.json'));
  if(integration.executionEngine!=='v1'||canonical(integration.v2ProjectRoot)!==canonical(root))throw Error('V1 gateway and V2 engine selection disagree');
  const config=read(path.join(legacyRoot,'config/config.json'));
  const shell=runtime.powershellExecutable??config.powershellExecutable;
  if(!shell||!path.isAbsolute(shell)||!fs.existsSync(shell))throw Error('configured PowerShell executable unavailable');
  const args=engineCommand({legacyRoot,mode,accountKeys,origins,notify});
  let lease;
  try{lease=acquireExecutionLock(root);}
  catch(error){
    if(mode==='scheduled'&&error.message==='V2 runner is already active')return {mode:'v2_v1_engine',skipped:true,reason:'executor_busy',exitCode:0};
    throw error;
  }
  const startedAt=new Date().toISOString();let output;
  try{
    fs.mkdirSync(path.join(root,'logs'),{recursive:true});
    const logFile=path.join(root,'logs',`v1-engine-${Date.now()}.log`);output=fs.openSync(logFile,'a',0o600);
    const exitCode=await new Promise((resolve,reject)=>{
      const child=spawnChild(shell,args,{cwd:legacyRoot,windowsHide:true,shell:false,stdio:['ignore',output,output],env:{...process.env,CHECKIN_V2_ENGINE_ROOT:root,CHECKIN_V2_ENGINE_LEASE:lease.owner.nonce}});
      child.once('error',reject);child.once('exit',(code,signal)=>signal?reject(Error('V1 engine child interrupted')):resolve(code??1));
    });
    if(mode==='dry-run')return {mode:'v2_v1_engine_dry_run',exitCode,logFile};
    if(mode==='scheduled'){
      let latest=null;try{latest=read(path.join(legacyRoot,'logs/latest.json'));}catch{}
      if(!latest||Date.parse(latest.finishedAt)<Date.parse(startedAt)-2000){
        if(exitCode!==0)throw Error('scheduled V1 engine failed without a fresh final report');
        return {mode:'v2_v1_engine',skipped:true,reason:'no_new_final_report',exitCode,logFile};
      }
    }
    const report=publishEngineReport({root,legacyRoot,exitCode,requireFreshSince:mode==='execute'?startedAt:null});
    return {...report,logFile};
  }finally{if(output!==undefined)fs.closeSync(output);releaseExecutionLock(lease);}
}
