import {taskIdentity} from './contracts.mjs';

export function buildCanaryTask({profile,businessDate,planHash,adapterRule={}}={}) {
  if(!profile||profile.state!=='ready'||String(profile.identity??'')!==String(profile.expectedIdentity??'')) throw Error('V2 profile is not ready');
  const identity=taskIdentity({businessDate,logicalSiteKey:profile.origin,accountKey:profile.accountKey,actionType:'checkin',scheduleOccurrence:'daily'});
  return {schemaVersion:1,mode:'candidate_execute_pending',executionEnabled:false,...identity,planHash,businessDate,origin:profile.origin,accountKey:profile.accountKey,accountId:String(profile.identity),profileDir:profile.profileDir,adapterId:'new-api.execute.v1',adapterRule:{...adapterRule},executionOwner:'legacy-checkin',v1Fallback:{enabled:true,owner:'legacy-checkin'},preconditions:{profileReady:true,identityVerified:true,v1MustBeStoppedBeforeMutation:true,firstMutationNotPerformed:true}};
}
