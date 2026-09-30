import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {operationTargets} from './dashboard-operations.mjs';
import {loadRuntimeConfig} from './runtime-config.mjs';
import {runPtSite} from './pt-site-execution.mjs';
import {recordPtVerification} from './pt-verification.mjs';
import {runHarvestFallback} from './harvest-fallback.mjs';
import {runLegacyEngine} from './legacy-engine.mjs';
import {acquireExecutionLock,releaseExecutionLock} from './execution-lock.mjs';
const read=file=>JSON.parse(fs.readFileSync(file,'utf8'));
const dayAt=now=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai'}).format(now);

export function validateDashboardOperation(request,snapshot,now=new Date()){
  if(!['verify','retry','login','resume'].includes(request.action)||!/^op_[a-f0-9]{32}$/.test(request.id??'')||request.businessDate!==dayAt(now)||Date.parse(request.expiresAt)<=now.getTime()||
     !Number.isFinite(Date.parse(request.expiresAt))||request.planHash!==snapshot.planHash||snapshot.businessDate!==dayAt(now))throw Error('operation scope changed');
  const matches=operationTargets(snapshot).filter(t=>t.origin===request.origin&&(t.accountRef??null)===(request.accountRef??null));
  if(matches.length!==1)throw Error('account target changed');
  const target=matches[0];
  if(['signed','already_signed','not_available'].includes(target.status)&&request.action!=='verify')return {...target,skip:true};
  if(target.actions[request.action]!==true)throw Error('operation is not authorized by current status');
  return target;
}

export async function executeDashboardOperation(root,request,{now=new Date(),runSite=runPtSite,runEngine=runLegacyEngine,runFallback=runHarvestFallback,openLogin}={}){
  const snapshot=read(path.join(root,'outputs/shadow-beta-snapshot.json')),target=validateDashboardOperation(request,snapshot,now);
  if(target.skip)return {status:'completed',message:'今日任务已处理，无需重复执行',resultStatus:target.status};
  const runtime=loadRuntimeConfig(root);
  if(runtime.executionEngine!=='v1'||!runtime.legacyRoot)throw Error('execution layer is unavailable');
  const legacy=runtime.legacyRoot,config=read(path.join(legacy,'config/config.json'));
  const accountKey=target.accountKey??'site-default';
  if(request.action==='verify'||request.action==='retry'){
    const integration=read(path.join(legacy,'data/v2-integration.json')),gate=integration.harvestPtGate;
    const catalogFile=gate?.catalogFile;
    if(!catalogFile)throw Error('PT catalog unavailable');
    const bytes=fs.readFileSync(catalogFile),catalogHash=crypto.createHash('sha256').update(bytes).digest('hex'),catalog=JSON.parse(bytes);
    if(request.action==='verify'){
      const result=await runSite({root,origin:target.origin,catalogFile,catalogHash,readOnly:true});
      recordPtVerification(root,result);
      return {status:result.status==='login_required'?'waiting_login':'completed',message:result.evidence.summary||'只读核验已完成',resultStatus:result.status};
    }
    if(!/^[A-Za-z0-9._@-]+$/.test(gate.sshTarget??'')||!/^\/volume3\/docker\/[A-Za-z0-9._/-]+$/.test(gate.database??'')||gate.database.split('/').includes('..'))throw Error('Harvest probe unavailable');
    const refreshHarvest=()=>JSON.parse(execFileSync('ssh',['-o','BatchMode=yes','-o','ConnectTimeout=5',gate.sshTarget,'sudo -n python3 - '+gate.database],
      {input:fs.readFileSync(path.join(root,'scripts/harvest-observe.py'),'utf8'),encoding:'utf8',timeout:15000,windowsHide:true,maxBuffer:2000000}));
    const day=dayAt(now),fallbackFile=path.join(root,'outputs','pt-fallback-results-'+day+'.json');
    const result=await runFallback({root,now,execute:true,harvest:refreshHarvest(),refreshHarvest,catalog,catalogFile,catalogHash,
      plan:read(path.join(legacy,'data/last-valid-bookmark-plan.json')),latest:read(path.join(legacy,'logs/latest.json')),config,
      fallbackReport:fs.existsSync(fallbackFile)?read(fallbackFile):null,fallbackOnlyEnabled:runtime.ptFallbackOnlyEnabled,
      readOnlyOrigins:[target.origin],onlyOrigins:[target.origin]});
    const outcome=result.outcomes?.find(o=>o.origin===target.origin);
    if(!outcome&&result.assessments?.some(a=>a.origin===target.origin&&['confirmed_by_harvest','confirmed_by_executor','confirmed_by_executor_supplement'].includes(a.state)))
      return {status:'completed',message:'最新回执已确认今日完成，无需补签',resultStatus:'already_signed'};
    if(['signed','already_signed'].includes(outcome?.v1Status)||['already_confirmed','confirmed_by_passive_read'].includes(outcome?.state))
      return {status:'completed',message:'执行层已确认今日签到完成',resultStatus:outcome.v1Status??'already_signed'};
    if(['passive_verification_cooldown','deferred_busy','deferred_preflight'].includes(outcome?.state))return {status:'queued',message:'等待执行器空闲或既有冷却结束',nextEligibleAt:new Date(Date.now()+5*60_000).toISOString()};
    return {status:'blocked',message:'本次未满足补签条件；保留记录，先查看核验结果',resultStatus:outcome?.v1Status??'unknown'};
  }
  if(request.action==='login'){
    if(openLogin)await openLogin({root,legacy,target,config});
    else{
      const {ptExecutionBinding}=await import(pathToFileURL(path.join(legacy,'src/pt-read-policy.mjs')));
      const {acquireRunLock,releaseRunLock}=await import(pathToFileURL(path.join(legacy,'src/run-lock.mjs')));
      const binding=ptExecutionBinding(config,legacy,{origin:target.origin,accountKey});
      const identity=[...Object.values(config.oauthAccountIdentities??{}),...(config.supplementalOAuthAccounts??[])].find(a=>a.accountKey===accountKey);
      const url=config.savedLoginUrls?.[target.origin]??config.oauthLoginUrls?.[target.origin]??identity?.loginUrl??
        target.origin+(target.pt?'/login.php':'/login');
      if(new URL(url).origin!==target.origin)throw Error('login URL binding mismatch');
      let engine,runner;
      try{engine=acquireExecutionLock(root);runner=await acquireRunLock(path.join(legacy,'tmp/run.lock'));
        execFileSync(runtime.powershellExecutable??'pwsh',['-NoProfile','-File',path.join(legacy,'scripts/Open-PlainLoginChrome.ps1'),
          '-Urls',url,'-UserDataDirOverride',binding.profile,'-EnablePasswordManager'],{windowsHide:true,encoding:'utf8',timeout:30000});
      }finally{if(runner)await releaseRunLock(runner);if(engine)releaseExecutionLock(engine);}
    }
    return {status:'waiting_login',message:'已在执行电脑打开绑定窗口；完成登录并关闭窗口后，点击“登录后继续”'};
  }
  const result=await runEngine({root,mode:'execute',origins:[target.origin],accountKeys:[accountKey],notify:false});
  const outcome=result.results?.find(r=>r.origin===target.origin&&(r.accountKey??'site-default')===accountKey);
  return {status:['signed','already_signed','not_available'].includes(outcome?.status)?'completed':'blocked',
    message:['signed','already_signed'].includes(outcome?.status)?'执行层确认今日签到完成':outcome?.status==='not_available'?'站点当前未开放签到':'执行层已复核；请查看最新结果，未强制重复提交',resultStatus:outcome?.status??'unknown'};
}
