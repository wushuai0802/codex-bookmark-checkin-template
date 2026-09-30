import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {launchAutomationContext,processTarget,ptPageEvidence} from './browser.mjs';
import {acquireRunLock,releaseRunLock} from './run-lock.mjs';
import {ptExecutionBinding,ptReadPolicy,installPtReadFirewall} from './pt-read-policy.mjs';

const dayAt=value=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai'}).format(value);
const terminal=new Set(['signed','already_signed']);
const rewardHintOrigins=new Set(['https://hdtime.org','https://cyanbug.net']);

function exactOrigin(value){
  const url=new URL(value);
  if(url.protocol!=='https:'||url.origin!==value||url.username||url.password)throw Error('invalid PT origin');
  return url.origin;
}

export function ptSupplementTarget(catalog,origin){
  const requested=exactOrigin(origin);
  if(!Array.isArray(catalog?.sites))throw Error('PT catalog is missing sites');
  const matches=catalog.sites.filter(site=>site?.origin===requested);
  if(matches.length!==1)throw Error('PT origin is absent or ambiguous');
  const entryUrl=matches[0].entryUrl;
  const url=new URL(entryUrl);
  if(url.protocol!=='https:'||url.origin!==requested||url.username||url.password||url.search||url.hash||entryUrl.length>255)throw Error('PT entry is unsafe');
  const operationMode='legacy_checkin';
  const readSafety='unknown';
  return {origin:requested,title:matches[0].displayName??url.hostname,
    candidates:[entryUrl],allowedOrigins:[requested],
    accountKey:'site-default',folderNames:['PT补签'],ptSupplement:true,operationMode,readSafety};
}

export function publicSupplementResult(origin,result,now=new Date()){
  const claimed=result?.status;
  const confirmedAt=Date.parse(result?.evidence?.confirmedAt??result?.evidence?.createdAt);
  const dated=Number.isFinite(confirmedAt)&&confirmedAt<=now.getTime()+60_000&&
    dayAt(new Date(confirmedAt))===dayAt(now)&&
    (!result?.evidence?.businessDate||result.evidence.businessDate===dayAt(now))&&
    (!result?.startedAt||confirmedAt>=Date.parse(result.startedAt)-60_000);
  const authoritative=terminal.has(claimed)&&result?.evidence?.authoritative===true&&
    dated&&result?.failureCode!=='submission_outcome_unknown';
  const unavailable=result?.status==='not_available'&&result?.evidence?.authoritative===true&&
    dated;
  const status=authoritative?claimed:claimed==='login_required'?'login_required':
    claimed==='deferred'&&result?.submissionAttempted===false?'unknown':
    result?.failureCode==='submission_outcome_unknown'?'needs_attention':
    unavailable?'not_available':
    terminal.has(claimed)?'unknown':'needs_attention';
  const source=['api','page_text','usage_log','pt_page'].includes(result?.evidence?.source)?result.evidence.source:'none';
  return {origin,status,observedAt:now.toISOString(),
    ...(result?.retryCause==='harvest_waiting'&&result?.submissionAttempted===false?{retryCause:'harvest_waiting',
      ...(Number.isFinite(Date.parse(result.nextEligibleAt))?{nextEligibleAt:new Date(result.nextEligibleAt).toISOString()}:{} )}:{}),
    operationMode:result?.operationMode??'unknown',readSafety:result?.readSafety??'unknown',
    ...(result?.profileBinding?{profileBinding:result.profileBinding,accountKey:result.accountKey??'site-default'}:{}),
    businessDate:dayAt(now),...(result?.startedAt?{startedAt:result.startedAt}:{}),
    evidence:{source,authoritative:authoritative||unavailable,
      ...(Number.isFinite(confirmedAt)?{confirmedAt:new Date(confirmedAt).toISOString()}:{}),
      ...(result?.evidence?.businessDate?{businessDate:result.evidence.businessDate}:{}),
      ...(result?.evidence?.statusSignal?{statusSignal:result.evidence.statusSignal}:{}),
      ...(result?.evidence?.pagePath==='/index.php'?{pagePath:'/index.php'}:{}),
      evidenceScope:'site_account_day',summary:authoritative?'执行层确认今日签到':
      terminal.has(claimed)&&result?.evidence?.statusSignal==='cumulative_reward'?'检测到签到已得，疑似已签到；尚缺今日回执':
      terminal.has(claimed)?'执行层返回完成状态，仍需权威证据复核':
      status==='login_required'?'执行层会话需要登录':
      result?.failureCode==='submission_outcome_unknown'?'提交结果不明，禁止自动重放':'执行层尚未确认签到结果'},
    ...(result?.failureCode==='submission_outcome_unknown'?{submissionOutcomeUnknown:true}:{}),
    ...(result?.submissionAttempted===true?{submissionAttempted:true}:{}),
    ...(result?.submissionAttempted===false?{submissionAttempted:false}:{})};
}

export function ptRewardCounter(bodyText){
  const values=[...String(bodyText??'').matchAll(/(?:签到已得|簽到已得)\s*([0-9][0-9,]*(?:\.[0-9]+)?)/g)]
    .map(match=>Number(match[1].replaceAll(',','')));
  return values.length>0&&values.every(value=>Number.isFinite(value)&&value===values[0])?values[0]:null;
}

export async function readPtRewardCounter(context,origin,config){
  let page;
  try{
    page=await context.newPage();
    await page.goto(`${origin}/`,{waitUntil:'domcontentloaded',timeout:Math.min(15000,Number(config.navigationTimeoutMs)||15000)});
    if(new URL(page.url()).origin!==origin)return null;
    return ptRewardCounter(await page.locator('body').innerText({timeout:5000}));
  }catch{return null;}
  finally{await page?.close().catch(()=>{});}
}

export async function runPtSupplement({root,origin,catalogFile,catalogHash,now,clock=()=>now?new Date(now):new Date(),
  readOnly=false,validateScope=()=>{},
  launch=launchAutomationContext,runTarget=processTarget,readReward=readPtRewardCounter,
  acquire=acquireRunLock,release=releaseRunLock}={}){
  if(!/^[a-f0-9]{64}$/i.test(catalogHash??''))throw Error('catalog hash is required');
  const bytes=fs.readFileSync(catalogFile);
  if(crypto.createHash('sha256').update(bytes).digest('hex')!==catalogHash.toLowerCase())throw Error('PT catalog changed');
  const target=ptSupplementTarget(JSON.parse(bytes.toString('utf8')),origin);
  const startedAt=clock();
  const legacyRoot=path.resolve(root);
  const config=JSON.parse(fs.readFileSync(path.join(legacyRoot,'config/config.json'),'utf8'));
  await validateScope();
  const plan=JSON.parse(fs.readFileSync(path.join(legacyRoot,'data/last-valid-bookmark-plan.json'),'utf8'));
  // A bookmark entry is not automatically a safe read-only URL. Some PT
  // sites perform attendance on page load, so their mature flow is a formal
  // mutation even when no button is clicked.
  if(!Array.isArray(plan.targets)||(!readOnly&&plan.targets.some(item=>item.origin===target.origin)))throw Error('PT origin belongs to the daily plan');
  if((config.excludedOrigins??[]).includes(target.origin)||(config.disabledCheckinOrigins??[]).includes(target.origin)||
    (config.disabledAccountKeys??[]).includes('site-default'))throw Error('PT origin disabled by execution configuration');
  const owners=plan.targets.filter(item=>item.origin===target.origin);
  if(owners.length>1)throw Error('PT account binding is ambiguous');
  target.accountKey=owners[0]?.accountKey??'site-default';
  if((config.disabledAccountKeys??[]).includes(target.accountKey))throw Error('PT account disabled by execution configuration');
  const binding=ptExecutionBinding(config,legacyRoot,target);
  const profile=binding.profile;
  const policy=readOnly?ptReadPolicy(target.origin,config):null;
  if(!fs.existsSync(path.join(profile,'Local State')))throw Error('execution browser profile is unavailable');
  const readRules=file=>{try{return JSON.parse(fs.readFileSync(path.join(legacyRoot,file),'utf8')).rules??[];}catch(error){if(error.code==='ENOENT')return [];throw error;}};
  const rules=[...readRules('config/qa-rules.json'),...readRules('config/qa-rules.local.json')];
  const safeConfig={...binding.config,retryCount:0,failureScreenshots:false,capturePtEvidence:true,ptPassiveReadOnly:readOnly};
  const metadata={accountKey:binding.accountKey,profileBinding:binding.profileBinding,startedAt:startedAt.toISOString(),
    operationMode:policy?.mode??'legacy_checkin',readSafety:policy?'reviewed_passive':'attendance_page_risk'};
  const lock=await acquire(path.join(legacyRoot,'tmp/run.lock'));
  let context;
  try {
    await validateScope();
    context=await launch(safeConfig);
    await validateScope();
    if(readOnly){
      await installPtReadFirewall(context,policy);
      const readOnlyUrl=policy.url;
      const page=await context.newPage();
      try{
        await page.goto(readOnlyUrl,{waitUntil:'domcontentloaded',timeout:Math.min(15000,Number(config.navigationTimeoutMs)||15000)});
        const bodyText=await page.locator(policy.selector).innerText({timeout:5000});
        const observedAt=clock();
        const evidence=page.url()===policy.url?ptPageEvidence({origin:target.origin,url:page.url(),
          bodyText,status:'already_signed',now:observedAt,allowUndatedActionText:false}):null;
        return publicSupplementResult(target.origin,{...metadata,status:evidence?'already_signed':'unknown',
          submissionAttempted:false,evidence:evidence??{source:'none',authoritative:false}},observedAt);
      }finally{await page.close().catch(()=>{});}
    }
    const before=await readReward(context,target.origin,safeConfig);
    let result=await runTarget(context,target,safeConfig,rules,path.join(legacyRoot,'tmp'));
    if(terminal.has(result?.status)&&result?.evidence?.authoritative!==true&&
       (before!==null||rewardHintOrigins.has(target.origin))){
      const after=await readReward(context,target.origin,safeConfig);
      const observedAt=clock();
      if(before!==null&&after!==null&&after>before){
        result={...result,evidence:{source:'pt_page',authoritative:dayAt(startedAt)===dayAt(observedAt),confirmedAt:observedAt.toISOString(),
          businessDate:dayAt(observedAt),statusSignal:'reward_increment'}};
      }else if(rewardHintOrigins.has(target.origin)&&after!==null&&after>0&&
               (before===null||after===before)){
        result={...result,evidence:{source:'pt_page',authoritative:false,statusSignal:'cumulative_reward'}};
      }
    }
    return publicSupplementResult(target.origin,{...result,...metadata},clock());
  } finally {
    try{await context?.close();}finally{await release(lock);}
  }
}
