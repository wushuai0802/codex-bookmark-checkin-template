import {defineAdapter} from './adapter-contract.mjs';
import {createTaskInstance,prepareSubmission,successfulVerification,transitionTask} from './task-state.mjs';

export async function runObservedTask({adapterDefinition,origin,accountKey,businessDate,planHash,expectedIdentity,context={}}={}){
 const adapter=adapterDefinition?.methods ? adapterDefinition : defineAdapter(adapterDefinition),task=createTaskInstance({origin,accountKey,businessDate,planHash,adapterId:adapter.id});
 const identity=await adapter.methods.identity({origin,accountKey,expectedIdentity,context});
 if(!identity?.userId)return {task:transitionTask(task,'blocked',{reason:'identity_missing'}),mutationCount:0,stage:'identity'};
 let current=transitionTask(task,'identity_verified',{evidence:{authoritative:true,source:'identity'},reason:'identity_verified'});
 const status=await adapter.methods.read_status({origin,accountKey,businessDate,identity,context});
 if(status?.state==='already_done'||status?.state==='not_available')return {task:transitionTask(current,'status_read',{evidence:status.evidence}),mutationCount:0,stage:status.state};
 current=transitionTask(current,'status_read',{evidence:status?.evidence??null});
 if(status?.state!=='not_signed')return {task:transitionTask(current,'blocked',{reason:status?.reason??'status_unknown'}),mutationCount:0,stage:'status'};
 if(!adapter.mutating)return {task:transitionTask(current,'blocked',{reason:'adapter_read_only'}),mutationCount:0,stage:'read_only'};
 current=prepareSubmission(current);
 const submitted=await adapter.methods.submit_once({origin,accountKey,identity,intent:current.intent,context});
 const after=await adapter.methods.verify({origin,accountKey,identity,submission:submitted,context});
 if(after?.state==='confirmed')return {task:successfulVerification(transitionTask(transitionTask(current,'submitting'), 'verifying'),after.evidence),mutationCount:1,stage:'succeeded'};
 return {task:transitionTask(transitionTask(current,'submitting'),'submission_unknown',{reason:after?.reason??'verification_failed',evidence:after?.evidence??null}),mutationCount:1,stage:'submission_unknown'};
}
