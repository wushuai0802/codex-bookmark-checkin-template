import path from 'node:path';
import {assertPlanHash,taskIdentity} from './contracts.mjs';
import {runIsolatedBrowserTask} from './isolated-browser-worker.mjs';
import {createNewApiExecutionAdapter} from './new-api-execution-adapter.mjs';

export async function verifyProfile({profile,root=path.resolve('.'),planHash,adapterRule={},executablePath,launchPersistentContext,now=new Date().toISOString()}={}) {
  assertPlanHash(planHash,'profile verification planHash');
  if(!profile?.accountKey||!profile?.origin||!/^\d{1,20}$/.test(String(profile.expectedIdentity??'')))throw Error('profile metadata is invalid');
  const businessDate=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai'}).format(new Date(now)),identity=taskIdentity({businessDate,logicalSiteKey:profile.origin,accountKey:profile.accountKey});
  const task={...identity,origin:profile.origin,accountKey:profile.accountKey,accountId:String(profile.expectedIdentity),businessDate,planHash};
  const result=await runIsolatedBrowserTask({task,adapterDefinition:createNewApiExecutionAdapter({origin:profile.origin,rule:adapterRule}),profileDir:profile.profileDir,dedicatedRoot:root,executablePath,windowMode:'offscreen',allowMutation:false,launchPersistentContext});
  if(String(result.identity?.userId??'')!==String(profile.expectedIdentity))return {...profile,state:'pending_login',v1TaskStopEligible:false,verificationReason:'identity_not_verified',identityVerifiedAt:null};
  return {...profile,state:'ready',identity:String(result.identity.userId),username:typeof result.identity.username==='string'?result.identity.username.slice(0,80):null,identityVerifiedAt:new Date(now).toISOString(),statusVerified:result.stage,verifiedBy:'v2-worker-read-only',v1TaskStopEligible:false};
}
