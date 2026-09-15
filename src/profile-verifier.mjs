import path from 'node:path';
import {assertPlanHash,taskIdentity} from './contracts.mjs';
import {runIsolatedBrowserTask} from './isolated-browser-worker.mjs';
import {createExecutionAdapter,executionBindingForOrigin} from './execution-adapter-registry.mjs';

export async function verifyProfile({profile,root=path.resolve('.'),planHash,adapterRule={},config={},adapterId=null,executablePath,launchPersistentContext,captchaSolver=null,now=new Date().toISOString()}={}) {
  assertPlanHash(planHash,'profile verification planHash');
  if(!profile?.accountKey||!profile?.origin||!/^\d{1,20}$/.test(String(profile.expectedIdentity??'')))throw Error('profile metadata is invalid');
  const businessDate=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai'}).format(new Date(now)),identity=taskIdentity({businessDate,logicalSiteKey:profile.origin,accountKey:profile.accountKey});
  const task={...identity,origin:profile.origin,accountKey:profile.accountKey,accountId:String(profile.expectedIdentity),businessDate,planHash};
  const binding=executionBindingForOrigin({origin:profile.origin,config}),resolvedAdapterId=adapterId??profile.adapterId??binding.adapterId;
  if(!resolvedAdapterId)return {...profile,state:'pending_login',identity:null,username:null,statusVerified:null,verifiedBy:'v2-worker-read-only',v1TaskStopEligible:false,verificationReason:'adapter_not_registered',identityVerifiedAt:null};
  const adapter=createExecutionAdapter({adapterId:resolvedAdapterId,origin:profile.origin,rule:{...binding.adapterRule,...adapterRule,provider:profile.provider??binding.adapterRule?.provider??null}});
  const result=await runIsolatedBrowserTask({task,adapterDefinition:adapter,profileDir:profile.profileDir,dedicatedRoot:root,executablePath,windowMode:'offscreen',allowMutation:false,captchaSolver,launchPersistentContext});
  if(String(result.identity?.userId??'')!==String(profile.expectedIdentity)){
    if(result.identityDiagnostic==='challenge_required'&&profile.state==='ready'&&String(profile.identity??'')===String(profile.expectedIdentity)&&Number.isFinite(Date.parse(profile.identityVerifiedAt))){
      return {...profile,verificationReason:'challenge_required',statusVerified:'deferred',verifiedBy:'v2-worker-read-only',v1TaskStopEligible:false};
    }
    return {...profile,state:'pending_login',identity:null,username:null,statusVerified:null,verifiedBy:'v2-worker-read-only',v1TaskStopEligible:false,verificationReason:'identity_not_verified',identityVerifiedAt:null};
  }
  return {...profile,state:'ready',identity:String(result.identity.userId),username:typeof result.identity.username==='string'?result.identity.username.slice(0,80):null,identityVerifiedAt:new Date(now).toISOString(),statusVerified:result.stage,verifiedBy:'v2-worker-read-only',v1TaskStopEligible:false,verificationReason:null};
}
