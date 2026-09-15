import {defineAdapter} from './adapter-contract.mjs';
import {createTaskInstance,prepareSubmission,successfulVerification,transitionTask} from './task-state.mjs';

function classify(adapter,error,fallback){
 try{const value=adapter?.methods?.classify_error?.(error);if(typeof value==='string'&&value.trim())return value.trim().slice(0,80);}catch{}
 return fallback;
}

export async function runObservedTask({adapterDefinition,origin,accountKey,businessDate,planHash,expectedIdentity,context={},allowMutation=false,persistIntent=null,recoveryProof=null,now=new Date().toISOString()}={}){
 const adapter=adapterDefinition?.methods ? adapterDefinition : defineAdapter(adapterDefinition),task=createTaskInstance({origin,accountKey,businessDate,planHash,adapterId:adapter.id});
 let identity;
 try { identity=await adapter.methods.identity({origin,accountKey,expectedIdentity,context}); } catch(error) { identity={blockedReason:classify(adapter,error,'identity_error')}; }
 const recoveredOAuthIdentity=!identity?.userId&&allowMutation&&adapter.id==='oauth-reward.execute.v1'&&recoveryProof?.authoritative===true&&recoveryProof.kind==='durable_non_mutating_failure'&&recoveryProof.previousPhase==='submit_rejected'&&recoveryProof.stage==='not_signed'&&recoveryProof.taskId===task.taskId&&recoveryProof.accountKey===accountKey&&recoveryProof.origin===origin&&recoveryProof.businessDate===businessDate&&String(expectedIdentity??'')!=='';
 if(recoveredOAuthIdentity)identity={userId:String(expectedIdentity),origin:adapter.origin,recovery:'durable_non_mutating_failure'};
 if(!identity?.userId)return {task:transitionTask(task,'blocked',{reason:identity?.blockedReason??'identity_missing'}),identity:null,identityDiagnostic:identity?.blockedReason??null,mutationCount:0,stage:'identity'};
 if(identity.origin!==adapter.origin||expectedIdentity!=null&&String(identity.userId)!==String(expectedIdentity))return {task:transitionTask(task,'blocked',{reason:'identity_mismatch'}),identity,mutationCount:0,stage:'identity'};
 let current=transitionTask(task,'identity_verified',{at:now,evidence:{authoritative:true,source:'identity'},reason:'identity_verified'});
 let status;
 if(recoveredOAuthIdentity)status={state:'not_signed',evidence:{authoritative:true,source:'execution_recovery_audit',businessDate,accountId:String(expectedIdentity)}};
 else try { status=await adapter.methods.read_status({origin,accountKey,businessDate,identity,context}); } catch(error) { status={state:'unknown',reason:classify(adapter,error,'status_read_error')}; }
 const statusAuthoritative=status?.evidence?.authoritative===true;
 if(status?.state==='already_done'||status?.state==='not_available'){
   current=transitionTask(current,'status_read',{at:now,evidence:status.evidence});
   if(!statusAuthoritative)return {task:transitionTask(current,'blocked',{at:now,reason:'status_evidence_not_authoritative'}),identity,mutationCount:0,stage:'status'};
   current=transitionTask(current,status.state,{at:now,evidence:status.evidence,reason:status.reason??null});
   return {task:current,identity,mutationCount:0,stage:status.state};
 }
 current=transitionTask(current,'status_read',{evidence:status?.evidence??null});
 if(status?.state!=='not_signed'||!statusAuthoritative)return {task:transitionTask(current,'blocked',{reason:status?.state==='not_signed'?'status_evidence_not_authoritative':status?.reason??'status_unknown'}),identity,mutationCount:0,stage:'status'};
 if(!allowMutation)return {task:current,identity,mutationCount:0,stage:'not_signed',dryRun:true};
 if(!adapter.mutating)return {task:transitionTask(current,'blocked',{reason:'adapter_read_only'}),identity,mutationCount:0,stage:'read_only'};
 current=prepareSubmission(current,{at:now});
 if(typeof persistIntent==='function')await persistIntent(current.intent,current);
 let submitted;
 try { submitted=await adapter.methods.submit_once({origin,accountKey,identity,intent:current.intent,context}); }
  catch(error) { submitted={state:'unknown',reason:classify(adapter,error,'submit_transport_unknown'),actionMayHaveHappened:true}; }
 const submittedState=submitted?.state??(submitted?.accepted===true?'accepted':'rejected');
 const submitting=transitionTask(current,'submitting',{at:now});
  if(submittedState!=='accepted'){
    if(submittedState==='unknown'&&submitted?.actionMayHaveHappened===false)return {task:transitionTask(current,'blocked',{at:now,reason:submitted?.reason??'submission_not_sent'}),identity,mutationCount:0,stage:'submit_rejected'};
    if(submitted?.actionMayHaveHappened===true||submittedState==='unknown')return {task:transitionTask(submitting,'submission_unknown',{at:now,reason:submitted?.reason??'submission_unknown',evidence:submitted?.evidence??null}),identity,mutationCount:1,stage:'submission_unknown'};
   return {task:transitionTask(current,'blocked',{at:now,reason:submitted?.reason??'submission_rejected'}),identity,mutationCount:0,stage:'submit_rejected'};
 }
 let after;
 try { after=await adapter.methods.verify({origin,accountKey,businessDate,identity,submission:submitted,context}); }
  catch(error) { after={state:'unknown',reason:classify(adapter,error,'verification_error')}; }
 const verifying=transitionTask(submitting,'verifying',{at:now});
 if(after?.state==='confirmed')return {task:successfulVerification(verifying,after.evidence,{at:now}),identity,mutationCount:1,stage:'succeeded'};
 return {task:transitionTask(verifying,'submission_unknown',{at:now,reason:after?.reason??'verification_failed',evidence:after?.evidence??null}),identity,mutationCount:1,stage:'submission_unknown'};
}
