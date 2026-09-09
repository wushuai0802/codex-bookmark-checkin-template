import fs from 'node:fs';
import path from 'node:path';
import {buildCanaryTask} from './canary-task.mjs';
import {runCanary} from './canary-runner.mjs';
import {acquireExecutionLock,releaseExecutionLock} from './execution-lock.mjs';
import {assertPlanHash,normalizeOrigin,taskIdentity} from './contracts.mjs';

function executionWindow(now,schedule) {
  const [hour,minute]=String(schedule).split(':').map(Number),parts=new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Shanghai',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(now),current=Number(parts.slice(0,2))*60+Number(parts.slice(3,5));
  return {current,scheduled:hour*60+minute,display:parts};
}

function boundedReason(error,fallback='runner_error') {
  return String(error?.message??fallback).replace(/[\r\n\t]+/g,' ').slice(0,200);
}

function migrationKeyFromFile(file) {
  const match=/^migration-([A-Za-z0-9._-]+)\.json$/.exec(file);
  return match?.[1]??null;
}

const terminalStages=new Set(['succeeded','already_done','not_available']);
function isValidTimestamp(value) { return Number.isFinite(Date.parse(String(value??''))); }

function writeJsonAtomic(file,value) {
  const temp=`${file}.${process.pid}.${Date.now()}.tmp`;
  try { fs.writeFileSync(temp,JSON.stringify(value,null,2),'utf8');fs.renameSync(temp,file); }
  catch(error) { try { fs.rmSync(temp,{force:true}); } catch {} throw error; }
}

function writeFailureOutput({outputDir,migration,businessDate,reason}) {
  const accountKey=String(migration?.accountKey??'');
  if(!/^[A-Za-z0-9._-]{1,80}$/.test(accountKey))return null;
  let origin;
  try { origin=normalizeOrigin(migration?.origin); } catch { return null; }
  const identity=taskIdentity({businessDate,logicalSiteKey:origin,accountKey,actionType:'checkin',scheduleOccurrence:'daily'});
  const completedAt=new Date().toISOString();
  const report={schemaVersion:1,mode:'canary_execute',taskId:identity.taskId,businessDate,origin,accountKey,stage:'blocked',phase:'blocked',mutationCount:0,evidence:null,reason:boundedReason({message:reason}),completedAt};
  const output=path.join(outputDir,`canary-result-${accountKey}-${businessDate}-blocked.json`);
  try { writeJsonAtomic(output,report); return output; } catch { return null; }
}

async function attemptNotification(notifyAccount,output,row) {
  if(!notifyAccount||!output)return;
  try { await notifyAccount(output); row.delivery={state:'attempted'}; }
  catch(error) { row.delivery={state:'failed',reason:boundedReason(error,'notification_failed')}; }
}

async function runDailyOnce({root=path.resolve('.'),legacyRoot,execute=false,accountKey=null,now=new Date(),runAccount=runCanary,notifyAccount=null,executionLock=null}={}) {
  if(!legacyRoot)throw Error('legacyRoot is required'); if(!Number.isFinite(now.getTime()))throw Error('now is invalid');
  const day=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai'}).format(now),config=JSON.parse(fs.readFileSync(path.join(legacyRoot,'config','config.json'),'utf8'));
  const schedule=String(config.schedule??'08:05'),window=executionWindow(now,schedule);
  if(!/^([01]\d|2[0-3]):[0-5]\d$/.test(schedule))throw Error('schedule is invalid; canary is refused');
  if(execute&&(window.current<window.scheduled-30||window.current>window.scheduled+5))throw Error(`V2 daily execute window is closed (${schedule}, now ${window.display})`);
  const planFile=path.join(legacyRoot,'data','last-valid-bookmark-plan.json');
  if(!fs.existsSync(planFile)) throw Error('execution plan is missing; canary is refused');
  let plan;
  try { plan=JSON.parse(fs.readFileSync(planFile,'utf8')); }
  catch(error) { throw Error(`execution plan is invalid: ${error.message}`); }
  const planHash=assertPlanHash(plan?.planFingerprint,'execution plan planFingerprint');
  const registry=JSON.parse(fs.readFileSync(path.join(root,'outputs','v2-profile-registry.json'),'utf8'));
  const outputDir=path.join(root,'outputs'),files=fs.readdirSync(outputDir).filter(name=>/^migration-[A-Za-z0-9._-]+\.json$/.test(name)),results=[];
  for(const file of files){
    const fileAccountKey=migrationKeyFromFile(file);
    let migration;
    try { migration=JSON.parse(fs.readFileSync(path.join(outputDir,file),'utf8')); }
    catch(error) {
      if(accountKey&&fileAccountKey!==accountKey)continue;
      const fallback=registry.profiles.find(item=>item.accountKey===fileAccountKey),source={accountKey:fileAccountKey,origin:fallback?.origin};
      const row={...source,stage:'blocked',phase:'blocked',mutationCount:0,reason:'migration_invalid_json'};row.output=execute?writeFailureOutput({outputDir,migration:source,businessDate:day,reason:row.reason}):null;
      results.push(row);await attemptNotification(notifyAccount,row.output,row);continue;
    }
    if(accountKey&&fileAccountKey!==accountKey)continue;
    if(!migration||typeof migration!=='object'||Array.isArray(migration)){
      const fallback=registry.profiles.find(item=>item.accountKey===fileAccountKey),source={accountKey:fileAccountKey,origin:fallback?.origin};
      const row={...source,stage:'blocked',phase:'blocked',mutationCount:0,reason:'migration_invalid_shape'};row.output=execute?writeFailureOutput({outputDir,migration:source,businessDate:day,reason:row.reason}):null;
      results.push(row);await attemptNotification(notifyAccount,row.output,row);continue;
    }
    if(String(migration.accountKey??'')!==String(fileAccountKey??'')){
      const row={accountKey:migration.accountKey??fileAccountKey,origin:migration.origin,stage:'blocked',phase:'blocked',mutationCount:0,reason:'migration_key_mismatch'};
      row.output=execute?writeFailureOutput({outputDir,migration,businessDate:day,reason:row.reason}):null;results.push(row);await attemptNotification(notifyAccount,row.output,row);continue;
    }
    if(!['candidate','active'].includes(migration.state))continue;
    if(migration.adapterId!=='new-api.execute.v1'){
      const row={accountKey:migration.accountKey??fileAccountKey,origin:migration.origin,stage:'blocked',phase:'blocked',mutationCount:0,reason:'adapter_not_implemented'};
      row.output=execute?writeFailureOutput({outputDir,migration,businessDate:day,reason:row.reason}):null;results.push(row);await attemptNotification(notifyAccount,row.output,row);continue;
    }
    if(!migration.origin||!migration.accountKey){
      const row={accountKey:migration.accountKey??fileAccountKey,origin:migration.origin,stage:'blocked',phase:'blocked',mutationCount:0,reason:'migration_identity_missing'};
      row.output=execute?writeFailureOutput({outputDir,migration,businessDate:day,reason:row.reason}):null;results.push(row);await attemptNotification(notifyAccount,row.output,row);continue;
    }
    if(!/^[A-Za-z0-9._-]{1,80}$/.test(String(migration.accountKey))){
      const row={accountKey:fileAccountKey,origin:migration.origin,stage:'blocked',phase:'blocked',mutationCount:0,reason:'migration_account_key_invalid'};
      row.output=execute?writeFailureOutput({outputDir,migration,businessDate:day,reason:row.reason}):null;results.push(row);await attemptNotification(notifyAccount,row.output,row);continue;
    }
    const profile=registry.profiles.find(item=>item.accountKey===migration.accountKey&&item.origin===migration.origin&&item.state==='ready');
    if(!profile){
      const row={accountKey:migration.accountKey,origin:migration.origin,stage:'blocked',phase:'blocked',mutationCount:0,reason:'profile_not_ready'};
      results.push(row); await attemptNotification(notifyAccount,execute?writeFailureOutput({outputDir,migration,businessDate:day,reason:row.reason}):null,row); continue;
    }
    if(migration.accountId!=null&&String(migration.accountId)!==String(profile.identity)){
      const row={accountKey:migration.accountKey,origin:migration.origin,stage:'blocked',phase:'blocked',mutationCount:0,reason:'migration_identity_mismatch'};
      row.output=execute?writeFailureOutput({outputDir,migration,businessDate:day,reason:row.reason}):null;results.push(row);await attemptNotification(notifyAccount,row.output,row);continue;
    }
    try {
      const task=buildCanaryTask({profile,businessDate:day,planHash,adapterRule:migration.adapterRule??{},ownershipState:migration.state}),result=await runAccount({task,execute,root,legacyRoot,executionLock});
      if(!execute&&result.mutationCount!==0)throw Error(`read-only daily runner received a mutation for ${migration.accountKey}`);
      const row={accountKey:migration.accountKey,origin:migration.origin,stage:result.stage,phase:result.phase??result.stage,mutationCount:result.mutationCount,duplicate:result.duplicate===true,output:result.output??null};
      if(result.persistenceError)row.persistence={state:'failed',reason:boundedReason({message:result.persistenceError},'result_persist_failed')};
      results.push(row);
      if(execute&&row.stage==='succeeded'&&row.mutationCount===1&&result.handoffPending!==true){
        try {
          if(!isValidTimestamp(result.completedAt))throw Error('successful result has no valid completion time');
          const completedAt=new Date(result.completedAt).toISOString();
          const updated={...migration,state:'active',ownership:{...(migration.ownership??{}),current:'v2-worker',switchedAt:completedAt},lastSuccessAt:completedAt};
          writeJsonAtomic(path.join(outputDir,file),updated);
        } catch(error) { row.persistence={state:'failed',reason:boundedReason(error,'migration_persist_failed')}; }
      } else if(execute&&row.stage==='succeeded'&&result.handoffPending===true) {
        row.persistence={state:'failed',reason:'handoff_pending'};
      }
      if(execute&&result.output)await attemptNotification(notifyAccount,result.output,row);
    } catch(error) {
      const row={accountKey:migration.accountKey,origin:migration.origin,stage:'blocked',phase:'blocked',mutationCount:0,reason:boundedReason(error)};
      row.output=execute?writeFailureOutput({outputDir,migration,businessDate:day,reason:row.reason}):null;
      results.push(row); await attemptNotification(notifyAccount,row.output,row);
    }
  }
  const failedCount=results.filter(row=>!terminalStages.has(row.stage)||row.persistence?.state==='failed'||row.delivery?.state==='failed').length;
  const deliveryFailureCount=results.filter(row=>row.delivery?.state==='failed').length;
  const persistenceFailureCount=results.filter(row=>row.persistence?.state==='failed').length;
  const report={schemaVersion:1,mode:execute?'v2_daily_execute':'v2_daily_read_only',businessDate:day,scheduledAt:schedule,observedAt:now.toISOString(),executionEnabled:execute,results,failedCount,deliveryFailureCount,persistenceFailureCount,hasFailures:failedCount>0||deliveryFailureCount>0||persistenceFailureCount>0},output=path.join(outputDir,`v2-daily-${day}.json`);writeJsonAtomic(output,report);return {...report,output};
}

async function runAccount({task,execute,root,legacyRoot,executionLock}) { return runCanary({task,execute,root,legacyRoot,executionLock,writeOutput:true}); }

export async function runDaily(options={}) {
  const root=options.root??path.resolve('.');
  if(!options.execute)return runDailyOnce(options);
  const executionLock=acquireExecutionLock(root);
  try { return await runDailyOnce({...options,root,executionLock}); }
  finally { releaseExecutionLock(executionLock); }
}
