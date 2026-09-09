import {assertPlanHash,normalizeOrigin,taskIdentity} from './contracts.mjs';

export function buildCanaryTask({profile,businessDate,planHash,adapterRule={},ownershipState='candidate'}={}) {
  if(!profile||profile.state!=='ready'||String(profile.identity??'')!==String(profile.expectedIdentity??'')) throw Error('V2 profile is not ready');
  if(!['candidate','active'].includes(ownershipState)) throw Error('V2 ownership state is invalid');
  const origin=normalizeOrigin(profile.origin);if(!origin.startsWith('https://'))throw Error('V2 profile origin must use HTTPS');
  const verifiedPlanHash=assertPlanHash(planHash,'canary planHash');
  const identity=taskIdentity({businessDate,logicalSiteKey:origin,accountKey:profile.accountKey,actionType:'checkin',scheduleOccurrence:'daily'});
  const active=ownershipState==='active';
  return {schemaVersion:1,mode:active?'v2_owned_execute':'candidate_execute_pending',executionEnabled:false,...identity,planHash:verifiedPlanHash,businessDate,origin,accountKey:profile.accountKey,accountId:String(profile.identity),profileDir:profile.profileDir,adapterId:'new-api.execute.v1',adapterRule:{...adapterRule},ownershipState,executionOwner:active?'v2-worker':'legacy-checkin',v1Fallback:{enabled:!active,owner:active?'v2-worker':'legacy-checkin'},preconditions:{profileReady:true,identityVerified:true,v1MustBeStoppedBeforeMutation:!active,firstMutationNotPerformed:!active}};
}
