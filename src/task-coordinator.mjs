import {defineAdapter} from './adapter-contract.mjs';
import {createTaskInstance,prepareSubmission,successfulVerification,transitionTask} from './task-state.mjs';

export async function runObservedTask({adapterDefinition,origin,accountKey,businessDate,planHash,expectedIdentity,context={},allowMutation=false,persistIntent=null,now=new Date().toISOString()}={}){
 const adapter=adapterDefinition?.methods ? adapterDefinition : defineAdapter(adapterDefinition),task=createTaskInstance({origin,accountKey,businessDate,planHash,adapterId:adapter.id});
 let identity;
 try { identity=await adapter.methods.identity({origin,accountKey,expectedIdentity,context}); } catch { identity=null; }
 if(!identity?.userId)return {task:transitionTask(task,'blocked',{reason:'identity_missing'}),identity:null,mutationCount:0,stage:'identity'};
 if(expectedIdentity!=null&&String(identity.userId)!==String(expectedIdentity))return {task:transitionTask(task,'blocked',{reason:'identity_mismatch'}),identity,mutationCount:0,stage:'identity'};
 let current=transitionTask(task,'identity_verified',{at:now,evidence:{authoritative:true,source:'identity'},reason:'identity_verified'});
 let status;
 try { status=await adapter.methods.read_status({origin,accountKey,businessDate,identity,context}); } catch { status={state:'unknown',reason:'status_read_error'}; }
 if(status?.state==='already_done'||status?.state==='not_available'){
   current=transitionTask(current,'status_read',{at:now,evidence:status.evidence});
  current=transitionTask(current,status.state,{at:now,evidence:status.evidence,reason:status.reason??null});
   return {task:current,identity,mutationCount:0,stage:status.state};
 }
 current=transitionTask(current,'status_read',{evidence:status?.evidence??null});
 if(status?.state!=='not_signed')return {task:transitionTask(current,'blocked',{reason:status?.reason??'status_unknown'}),identity,mutationCount:0,stage:'status'};
 if(!allowMutation)return {task:current,identity,mutationCount:0,stage:'not_signed',dryRun:true};
 if(!adapter.mutating)return {task:transitionTask(current,'blocked',{reason:'adapter_read_only'}),identity,mutationCount:0,stage:'read_only'};
 current=prepareSubmission(current,{at:now});
 if(typeof persistIntent==='function')await persistIntent(current.intent,current);
 let submitted;
 try { submitted=await adapter.methods.submit_once({origin,accountKey,identity,intent:current.intent,context}); }
 catch { submitted={state:'unknown',reason:'submit_transport_unknown',actionMayHaveHappened:true}; }
 const submittedState=submitted?.state??(submitted?.accepted===true?'accepted':'rejected');
 const submitting=transitionTask(current,'submitting',{at:now});
 if(submittedState!=='accepted'){
   if(submitted?.actionMayHaveHappened===true||submittedState==='unknown')return {task:transitionTask(submitting,'submission_unknown',{at:now,reason:submitted?.reason??'submission_unknown',evidence:submitted?.evidence??null}),identity,mutationCount:1,stage:'submission_unknown'};
   return {task:transitionTask(current,'blocked',{at:now,reason:submitted?.reason??'submission_rejected'}),identity,mutationCount:0,stage:'submit_rejected'};
 }
 let after;
 try { after=await adapter.methods.verify({origin,accountKey,businessDate,identity,submission:submitted,context}); }
 catch { after={state:'unknown',reason:'verification_error'}; }
 const verifying=transitionTask(submitting,'verifying',{at:now});
 if(after?.state==='confirmed')return {task:successfulVerification(verifying,after.evidence,{at:now}),identity,mutationCount:1,stage:'succeeded'};
 return {task:transitionTask(verifying,'submission_unknown',{at:now,reason:after?.reason??'verification_failed',evidence:after?.evidence??null}),identity,mutationCount:1,stage:'submission_unknown'};
}
