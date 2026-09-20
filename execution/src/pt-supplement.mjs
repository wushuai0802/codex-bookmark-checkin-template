import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {launchAutomationContext,processTarget} from './browser.mjs';
import {acquireRunLock,releaseRunLock} from './run-lock.mjs';

const dayAt=value=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai'}).format(value);
const terminal=new Set(['signed','already_signed']);

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
  return {origin:requested,title:matches[0].displayName??url.hostname,
    candidates:[entryUrl],allowedOrigins:[requested],accountKey:'site-default',folderNames:['PT补签']};
}

export function publicSupplementResult(origin,result,now=new Date()){
  const claimed=result?.status;
  const confirmedAt=Date.parse(result?.evidence?.confirmedAt??result?.evidence?.createdAt);
  const authoritative=terminal.has(claimed)&&result?.evidence?.authoritative===true&&
    Number.isFinite(confirmedAt)&&dayAt(new Date(confirmedAt))===dayAt(now);
  const unavailable=result?.status==='not_available'&&result?.evidence?.authoritative===true&&
    Number.isFinite(confirmedAt)&&dayAt(new Date(confirmedAt))===dayAt(now);
  const status=authoritative?claimed:claimed==='login_required'?'login_required':
    result?.failureCode==='submission_outcome_unknown'?'needs_attention':
    unavailable?'not_available':
    terminal.has(claimed)?'unknown':'needs_attention';
  const source=['api','page_text','usage_log','pt_page'].includes(result?.evidence?.source)?result.evidence.source:'none';
  return {origin,status,observedAt:now.toISOString(),
    evidence:{source,authoritative:authoritative||unavailable,summary:authoritative?'执行层确认今日签到':
      terminal.has(claimed)?'执行层返回完成状态，仍需权威证据复核':
      status==='login_required'?'执行层会话需要登录':
      result?.failureCode==='submission_outcome_unknown'?'提交结果不明，禁止自动重放':'执行层尚未确认签到结果'},
    ...(result?.failureCode==='submission_outcome_unknown'?{submissionOutcomeUnknown:true}:{})};
}

export async function runPtSupplement({root,origin,catalogFile,catalogHash,now=new Date(),
  launch=launchAutomationContext,runTarget=processTarget,acquire=acquireRunLock,release=releaseRunLock}={}){
  if(!/^[a-f0-9]{64}$/i.test(catalogHash??''))throw Error('catalog hash is required');
  const bytes=fs.readFileSync(catalogFile);
  if(crypto.createHash('sha256').update(bytes).digest('hex')!==catalogHash.toLowerCase())throw Error('PT catalog changed');
  const target=ptSupplementTarget(JSON.parse(bytes.toString('utf8')),origin);
  const legacyRoot=path.resolve(root);
  const config=JSON.parse(fs.readFileSync(path.join(legacyRoot,'config/config.json'),'utf8'));
  const plan=JSON.parse(fs.readFileSync(path.join(legacyRoot,'data/last-valid-bookmark-plan.json'),'utf8'));
  if(!Array.isArray(plan.targets)||plan.targets.some(item=>item.origin===target.origin))throw Error('PT origin belongs to the daily plan');
  if((config.excludedOrigins??[]).includes(target.origin)||(config.disabledCheckinOrigins??[]).includes(target.origin)||
    (config.disabledAccountKeys??[]).includes('site-default'))throw Error('PT origin disabled by execution configuration');
  const profile=path.resolve(legacyRoot,config.automationUserDataDir??'');
  if(!fs.existsSync(path.join(profile,'Local State')))throw Error('execution browser profile is unavailable');
  const readRules=file=>{try{return JSON.parse(fs.readFileSync(path.join(legacyRoot,file),'utf8')).rules??[];}catch(error){if(error.code==='ENOENT')return [];throw error;}};
  const rules=[...readRules('config/qa-rules.json'),...readRules('config/qa-rules.local.json')];
  const safeConfig={...config,retryCount:0,failureScreenshots:false,capturePtEvidence:true};
  const lock=await acquire(path.join(legacyRoot,'tmp/run.lock'));
  let context;
  try {
    context=await launch(safeConfig);
    const result=await runTarget(context,target,safeConfig,rules,path.join(legacyRoot,'tmp'));
    return publicSupplementResult(target.origin,result,now);
  } finally {
    try{await context?.close();}finally{await release(lock);}
  }
}
