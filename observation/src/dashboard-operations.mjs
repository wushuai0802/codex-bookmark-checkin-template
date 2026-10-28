import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {acquireExecutionLock,releaseExecutionLock} from './execution-lock.mjs';
import {ptStatusCondition} from '../public/dashboard-model.mjs';
import {sitePtCapabilities} from './pt-capabilities.mjs';
const dayAt=now=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai'}).format(now);
const active=new Set(['queued','running']);
const states=new Set(['queued','running','completed','waiting_login','blocked','expired','interrupted']);
const exactOrigin=value=>{try{const u=new URL(value);return u.protocol==='https:'&&u.origin===value&&!u.username&&!u.password?value:null;}catch{return null;}};
const key=target=>target.origin+'|'+(target.accountRef??'site-default');

export function operationTargets(snapshot){
  const receipts=new Map((snapshot.receipts??[]).map(r=>[r.taskId,r]));
  const result=(snapshot.tasks??[]).map(task=>({...task,evidence:task.evidence??receipts.get(task.taskId)?.evidence,
    status:task.observedStatus,kind:task.ptSupplementOnly===true?'pt':'regular'}));
  for(const site of snapshot.ptStatus?.sites??[]){
    const existing=result.filter(t=>t.origin===site.origin&&(!site.accountRef||t.ptSupplementOnly===true||site.accountRef===t.accountRef));
    if(existing.length===1){
      const target=existing[0];target.pt=site;
      const disabled=site.disabledByConfig===true||target.evidence?.verification==='task_disabled';
      if(!disabled&&site.effective?.fresh===true&&site.effective.authoritative===true&&['signed','already_signed','not_signed','not_available'].includes(site.effective.status)){
        target.status=site.effective.status;target.evidence=site.effective.evidence;
        target.failureCode=site.effective.failureCode;target.underlyingFailureCode=site.effective.underlyingFailureCode;
      }
      continue;
    }
    if(!site.inLegacyPlan)result.push({origin:site.origin,accountRef:null,displayName:site.displayName,status:site.effective?.status,kind:'pt',pt:site,
      evidence:site.effective?.evidence,failureCode:site.effective?.failureCode,underlyingFailureCode:site.effective?.underlyingFailureCode});
  }
  return result.map(target=>{
    const uncertain=target.failureCode==='submission_outcome_unknown'||target.evidence?.verification==='submission_outcome_unknown'||target.pt?.recovery?.code==='submission_outcome_unknown';
    const disabled=target.pt?.disabledByConfig===true||target.evidence?.verification==='task_disabled';
    const terminal=['signed','already_signed','not_available'].includes(target.status);
    const bookmarkReview=[target.failureCode,target.underlyingFailureCode,ptStatusCondition(target.pt)]
      .some(code=>['site_migration','bookmark_origin_changed'].includes(code));
    const capability=sitePtCapabilities(target.pt??{origin:target.origin});
    const current=target.pt?.effective,proof=current?.evidence,observed=Date.parse(current?.observedAt??''),published=Date.parse(snapshot.generatedAt??'');
    // A fresh passive login-page observation can authorize opening the bound
    // login window without authorizing another uncertain check-in submission.
    const passiveLogin=target.kind==='pt'&&target.pt?.fallbackEnabled===true&&!target.pt.discrepancy&&capability.read&&
      (!target.accountKey||target.accountKey==='site-default')&&current?.source==='execution-supplement'&&
      current.status==='login_required'&&current.fresh===true&&current.submissionAttempted===false&&
      proof?.readSafety==='reviewed_passive'&&proof.evidenceScope==='site_account_day'&&
      proof.businessDate===snapshot.businessDate&&/^[a-f0-9]{64}$/.test(proof.profileBinding??'')&&
      Number.isFinite(observed)&&Number.isFinite(published)&&observed<=published+60_000&&published-observed<=30*60_000&&
      dayAt(new Date(observed))===snapshot.businessDate;
    const login=!disabled&&!terminal&&(!uncertain||passiveLogin)&&!bookmarkReview&&(target.status==='login_required'||['login_required','upstream_login_required','two_factor_required','managed_challenge'].includes(target.failureCode));
    const actions={verify:Boolean(!disabled&&target.pt&&capability.read),retry:Boolean(!disabled&&!bookmarkReview&&!target.pt?.discrepancy&&capability.guardedSubmit&&target.pt?.fallbackEnabled&&
      (!target.accountKey||target.accountKey==='site-default')&&
      target.pt.effective?.status==='not_signed'&&target.pt.effective?.authoritative&&target.pt.effective?.fresh),
      login,resume:login&&!uncertain&&target.kind==='regular'};
    return {...target,actions};
  });
}

function load(root){const file=path.join(root,'operation-requests.json');
  if(!fs.existsSync(file))return {schemaVersion:1,requests:[],worker:null};
  const state=JSON.parse(fs.readFileSync(file,'utf8'));
  if(state.schemaVersion!==1||!Array.isArray(state.requests)||state.requests.length>1000)throw Error('invalid operation queue');return state;}
function save(root,state){fs.mkdirSync(root,{recursive:true});const file=path.join(root,'operation-requests.json'),tmp=file+'.'+crypto.randomUUID()+'.tmp';
  try{fs.writeFileSync(tmp,JSON.stringify(state,null,2),{mode:0o600});fs.renameSync(tmp,file);}finally{if(fs.existsSync(tmp))fs.unlinkSync(tmp);}}
function transact(root,fn){const lease=acquireExecutionLock(root,{name:'dashboard-operations.lock'});try{const state=load(root);const result=fn(state);save(root,state);return result;}finally{releaseExecutionLock(lease);}}
function expire(state,now){for(const r of state.requests)if(active.has(r.status)&&(Date.parse(r.expiresAt)<=now.getTime()||r.businessDate!==dayAt(now))){
  const running=r.status==='running';r.status=running?'interrupted':'expired';r.message=running?'执行回执未返回；请先只读核验':'请求已过期，请根据今日状态重新操作';}}
function publicRequest(r){return {id:r.id,origin:r.origin,accountRef:r.accountRef??null,action:r.action,status:r.status,createdAt:r.createdAt,
  finishedAt:r.finishedAt??null,nextEligibleAt:r.nextEligibleAt??null,message:r.message??null,resultStatus:r.resultStatus??null};}

export function enqueueOperation(root,input,snapshot,now=new Date()){
  const origin=exactOrigin(input.origin),action=input.action;
  if(!origin||!['verify','retry','login','resume'].includes(action)||
    input.accountRef!=null&&!/^acct_[a-f0-9]{16}$/.test(input.accountRef))throw Error('invalid operation target');
  if(snapshot.businessDate!==dayAt(now)||!Number.isFinite(Date.parse(snapshot.generatedAt))||
     now.getTime()-Date.parse(snapshot.generatedAt)>26*3600_000||Date.parse(snapshot.generatedAt)>now.getTime()+60_000)throw Error('refresh today status before requesting an operation');
  const targets=operationTargets(snapshot).filter(t=>key(t)===key(input));
  if(targets.length!==1||targets[0].actions[action]!==true)throw Error('operation is unavailable for this current account state');
  return transact(root,state=>{
    expire(state,now);
    const duplicate=state.requests.findLast(r=>key(r)===key(input)&&r.action===action&&
      (active.has(r.status)||now.getTime()-Date.parse(r.createdAt)<60_000));
    if(duplicate)return {request:publicRequest(duplicate),duplicate:true};
    state.requests=state.requests.filter(r=>active.has(r.status)).concat(state.requests.filter(r=>!active.has(r.status)).slice(-199));
    if(state.requests.filter(r=>active.has(r.status)).length>=20)throw Error('operation queue is full');
    const request={id:'op_'+crypto.randomBytes(16).toString('hex'),origin,accountRef:input.accountRef??null,action,status:'queued',
      businessDate:dayAt(now),planHash:snapshot.planHash,createdAt:now.toISOString(),expiresAt:new Date(now.getTime()+2*3600_000).toISOString()};
    state.requests.push(request);return {request:publicRequest(request),duplicate:false};
  });
}

export function operationView(root,now=new Date()){
  const state=load(root);expire(state,now);const lastSeen=Date.parse(state.worker?.lastSeenAt??'');
  return {worker:{online:Number.isFinite(lastSeen)&&now.getTime()-lastSeen<15*60_000,lastSeenAt:state.worker?.lastSeenAt??null},
    requests:state.requests.slice(-50).reverse().map(publicRequest)};
}

export function claimOperation(root,now=new Date()){
  return transact(root,state=>{expire(state,now);state.worker={lastSeenAt:now.toISOString()};
    const r=state.requests.find(r=>r.status==='queued'&&(!r.nextEligibleAt||Date.parse(r.nextEligibleAt)<=now.getTime()));
    if(!r)return null;r.status='running';r.claimToken=crypto.randomBytes(24).toString('hex');r.startedAt=now.toISOString();return {...r};});
}

export function finishOperation(root,{id,claimToken,status,message,resultStatus,nextEligibleAt},now=new Date()){
  if(!states.has(status)||['running','expired'].includes(status)||typeof message!=='string'||message.length>240||/[<>]|(?:cookie|token|password|authorization)\s*[:=]/i.test(message))throw Error('invalid operation result');
  return transact(root,state=>{
    const r=state.requests.find(r=>r.id===id);
    if(!r||r.claimToken!==claimToken)throw Error('operation lease mismatch');
    if(!['running','queued'].includes(r.status))return publicRequest(r);
    r.status=status;r.message=message;r.resultStatus=/^[a-z_]{1,40}$/.test(resultStatus??'')?resultStatus:null;
    if(status==='queued'){
      const at=Date.parse(nextEligibleAt);if(!Number.isFinite(at)||at<=now.getTime()||at>now.getTime()+30*60_000)throw Error('invalid retry time');
      r.nextEligibleAt=new Date(at).toISOString();
    }else r.finishedAt=now.toISOString();
    state.worker={lastSeenAt:now.toISOString()};return publicRequest(r);
  });
}
