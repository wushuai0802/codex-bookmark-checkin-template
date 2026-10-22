import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {sameLockOwner} from './run-lock.mjs';
import {pendingOpenCdSubmission} from './quota-claim-guard.mjs';
import {boundPtObservation,freshPtUnsignedObservation,ptObservationBinding} from './pt-observation-receipt.mjs';

const dayAt=value=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai'}).format(new Date(value));
const serialized=new Map();
const fingerprint=parts=>crypto.createHash('sha256').update(JSON.stringify(parts)).digest('hex');

function assertOwner(root,lease){
  const file=path.resolve(root,'tmp/run.lock');
  if(path.resolve(lease?.lockPath??'.')!==file||lease?.owner?.pid!==process.pid)
    throw Error('PT receipt closure requires the current V1 run lock');
  const saved=JSON.parse(fs.readFileSync(file,'utf8'));
  if(!sameLockOwner(saved,lease.owner))throw Error('PT receipt closure run lock ownership changed');
}

function loadState(root,fallback){
  const file=path.join(root,'data/site-state.json');
  const state=fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):fallback;
  if(!state||typeof state.sites!=='object'||state.sites===null)throw Error('invalid PT closure site state');
  return state;
}

function saveState(root,state,lease){
  assertOwner(root,lease);
  const file=path.join(root,'data/site-state.json'),temporary=file+'.'+crypto.randomUUID()+'.tmp';
  fs.mkdirSync(path.dirname(file),{recursive:true});
  try{fs.writeFileSync(temporary,JSON.stringify(state,null,2),{mode:0o600});fs.renameSync(temporary,file);}
  finally{if(fs.existsSync(temporary))fs.unlinkSync(temporary);}
}

async function heldOperation(root,lease,run){
  assertOwner(root,lease);
  const key=path.resolve(root).toLowerCase(),previous=serialized.get(key)??Promise.resolve();
  const current=previous.catch(()=>{}).then(()=>{assertOwner(root,lease);return run();});
  serialized.set(key,current);
  try{return await current;}finally{if(serialized.get(key)===current)serialized.delete(key);}
}

// Import saved completion for the original pending business day. Legacy
// timestamps with no original profile binding deliberately remain unresolved.
// This updates only quarantine/audit state, never today's completion counters.
export async function reconcilePendingPtObservations({root,targets=[],config,state,now=new Date(),lockLease,persist=saveState}={}){
  return heldOperation(root,lockLease,async()=>{
    const current=loadState(root,state),resolutions=[];
    const matches=targets.filter(target=>target.origin==='https://open.cd'&&
      String(target.accountKey??'site-default')==='site-default');
    if(matches.length!==1)return {state:current,changed:false,resolutions};
    const target=matches[0],site=current.sites[target.origin];
    if(!site)return {state:current,changed:false,resolutions};
    const candidates=[];
    if(site.pendingOpenCdAt)candidates.push({pendingAt:site.pendingOpenCdAt,
      profileBinding:site.pendingOpenCdProfileBinding??null,accountKey:site.pendingOpenCdAccountKey??'site-default',source:'current'});
    for(const item of site.openCdPendingHistory??[]){
      if(item?.status==='historical_confirmed')continue;
      candidates.push({pendingAt:item.pendingAt,profileBinding:item.profileBinding??null,
        accountKey:item.accountKey??'site-default',source:'history'});
    }
    const audits=site.openCdSubmissionResolutions??[];
    const seenCandidates=new Set();
    const consumedReceipts=new Set();
    let nextSite={...site},changed=false;
    for(const candidate of candidates){
      const candidateKey=`${candidate.pendingAt}\u0000${candidate.profileBinding??''}`;
      if(seenCandidates.has(candidateKey))continue;
      seenCandidates.add(candidateKey);
      const pending=Date.parse(candidate.pendingAt??'');
      if(!Number.isFinite(pending)||pending>now.getTime()||!/^[a-f0-9]{64}$/.test(candidate.profileBinding??'')||
        candidate.accountKey!=='site-default')continue;
      const businessDate=dayAt(pending),receipt=boundPtObservation(root,target,config,
        {now,businessDate,after:pending,profileBinding:candidate.profileBinding});
      if(!receipt)continue;
      const receiptAt=Date.parse(receipt.evidence.confirmedAt);
      const receiptKey=`${candidate.profileBinding}\u0000${businessDate}\u0000${receipt.evidence.confirmedAt}`;
      if(consumedReceipts.has(receiptKey))continue;
      consumedReceipts.add(receiptKey);
      const activeRecovery=(site.openCdRecoveryAttempts??[]).find(item=>item.accountKey==='site-default'&&
        item.profileBinding===candidate.profileBinding&&item.businessDate===businessDate&&
        ['claimed','outcome_unknown'].includes(item.state)&&Number.isFinite(Date.parse(item.claimedAt))&&
        receiptAt>=Date.parse(item.claimedAt));
      const currentDayResolution=businessDate===dayAt(now)&&candidate.source==='current';
      const activeForBinding=(site.openCdRecoveryAttempts??[]).some(item=>item.accountKey==='site-default'&&
        item.profileBinding===candidate.profileBinding&&item.businessDate===businessDate&&
        ['claimed','outcome_unknown'].includes(item.state));
      if(currentDayResolution&&activeForBinding&&!activeRecovery)continue;
      const resolutionKind=currentDayResolution?'current_day_confirmed':'historical_confirmed';
      const resolution={resolutionId:fingerprint([target.origin,'site-default',candidate.pendingAt,candidate.profileBinding,resolutionKind]),
        kind:resolutionKind,origin:target.origin,accountKey:'site-default',profileBinding:candidate.profileBinding,
        pendingAt:candidate.pendingAt,businessDate,originalOutcome:'unknown',confirmedAt:receipt.evidence.confirmedAt,
        observedAt:receipt.observedAt,resolvedAt:now.toISOString(),evidence:{source:receipt.evidence.source,authoritative:true,
          businessDate,confirmedAt:receipt.evidence.confirmedAt,pagePath:receipt.evidence.pagePath,
          statusSignal:receipt.evidence.statusSignal,evidenceScope:'site_account_day'}};
      if(!audits.some(item=>item.resolutionId===resolution.resolutionId))audits.push(resolution);
      if(candidate.source==='current'){
        nextSite.pendingOpenCdAt=null;nextSite.pendingOpenCdProfileBinding=null;nextSite.pendingOpenCdAccountKey=null;
      }
      if(activeRecovery){
        nextSite.openCdRecoveryAttempts=(nextSite.openCdRecoveryAttempts??[]).map(item=>item.claimId===activeRecovery.claimId?
          {...item,state:currentDayResolution?'confirmed_current_day':'historical_confirmed',finishedAt:now.toISOString(),
            confirmedAt:receipt.evidence.confirmedAt,resolutionBusinessDate:businessDate}:item);
        resolution.recoveryClaimId=activeRecovery.claimId;
      }
      const linkedPendingAts=new Set([candidate.pendingAt,activeRecovery?.originalPendingAt].filter(Boolean));
      nextSite.openCdPendingHistory=(nextSite.openCdPendingHistory??[]).map(item=>
        linkedPendingAts.has(item.pendingAt)&&
        (item.profileBinding===candidate.profileBinding||currentDayResolution&&item.pendingAt===activeRecovery?.originalPendingAt)?
          {...item,status:currentDayResolution?'resolved_current_day':'historical_confirmed',confirmedAt:receipt.evidence.confirmedAt,resolutionId:resolution.resolutionId}:item);
      resolutions.push(resolution);changed=true;
    }
    if(!changed)return {state:current,changed:false,resolutions};
    nextSite.openCdSubmissionResolutions=audits;
    const next={...current,updatedAt:now.toISOString(),sites:{...current.sites,[target.origin]:nextSite}};
    await persist(root,next,lockLease);
    return {state:next,changed:true,resolutions};
  });
}

// Claim a fresh negative proof before any guarded browser action. The claim is
// durable even if the runner crashes; the same proof cannot authorize replay.
export async function claimPtUnsignedRecovery({root,target,config,state,previousReport,now=new Date(),lockLease,persist=saveState,
  profileBinding,allowInactiveRecovery=false}={}){
  return heldOperation(root,lockLease,async()=>{
    const current=loadState(root,state),bindingHint=profileBinding??target?.profileBinding,
      blocked=pendingOpenCdSubmission(target,current,previousReport,{now,profileBinding:bindingHint,allowInactiveRecovery});
    if(target?.origin!=='https://open.cd'||!blocked||blocked.stateCorrupt===true)return {state:current,allowed:false,recovery:null};
    const site=current.sites[target.origin]??{},binding=ptObservationBinding(root,target,config);
    const today=dayAt(now);
    const attempts=(site.openCdRecoveryAttempts??[]).map(item=>
      ['claimed','outcome_unknown'].includes(item.state)&&item.businessDate!==today?
        {...item,state:'superseded_for_new_business_day',supersededAt:now.toISOString()}:item);
    const previousTimes=(previousReport?.results??[]).filter(item=>item?.origin===target.origin&&
      String(item.accountKey??'site-default')==='site-default').flatMap(item=>[
      item.observedAt,item.finishedAt,item.evidence?.confirmedAt,item.evidence?.createdAt]);
    const knownAfter=[blocked.observedAt,site.pendingOpenCdAt,site.lastRunAt,site.lastSuccessAt,site.lastConfirmedAt,
      previousReport?.finishedAt,...previousTimes,...(site.openCdPendingHistory??[]).flatMap(item=>[item.pendingAt,item.supersededAt]),
      ...attempts.flatMap(item=>[item.claimedAt,item.proofConfirmedAt,item.finishedAt])]
      .map(value=>Date.parse(value??'')).filter(Number.isFinite);
    const proof=freshPtUnsignedObservation(root,target,config,{now,profileBinding:binding.profileBinding,
      after:Math.max(-Infinity,...knownAfter)});
    if(!proof)return {state:current,allowed:false,recovery:null};
    const claimId=fingerprint([target.origin,binding.accountKey,binding.profileBinding,proof.businessDate,proof.evidence.confirmedAt]);
    if(attempts.some(item=>item.claimId===claimId))return {state:current,allowed:false,recovery:null};
    const recovery={claimId,origin:target.origin,accountKey:binding.accountKey,profileBinding:binding.profileBinding,
      businessDate:proof.businessDate,claimedAt:now.toISOString(),proofConfirmedAt:proof.evidence.confirmedAt,
      originalPendingAt:site.pendingOpenCdAt??blocked.observedAt??null,state:'claimed',
      originalOutcome:'unknown',recoveryProofType:'current_day_not_signed',
      evidence:{source:proof.evidence.source,authoritative:true,businessDate:proof.businessDate,
        confirmedAt:proof.evidence.confirmedAt,pagePath:proof.evidence.pagePath,statusSignal:proof.evidence.statusSignal,
        evidenceScope:'site_account_day'}};
    const next={...current,updatedAt:now.toISOString(),sites:{...current.sites,[target.origin]:{...site,
      openCdRecoveryAttempts:[...attempts,recovery]}}};
    await persist(root,next,lockLease);
    return {state:next,allowed:true,recovery};
  });
}
