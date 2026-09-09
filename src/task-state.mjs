import crypto from 'node:crypto';
import {normalizeOrigin,taskIdentity} from './contracts.mjs';
const transitions={planned:['identity_verified','blocked'],identity_verified:['status_read','blocked'],status_read:['prepared','already_done','not_available','blocked'],prepared:['submitting','blocked'],submitting:['verifying','submission_unknown'],verifying:['succeeded','already_done','submission_unknown','blocked'],submission_unknown:['verifying','blocked'],succeeded:[],already_done:[],not_available:[],blocked:[]};
const digest=value=>crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0,24);
export function transitionTask(task,next,{at=new Date().toISOString(),reason=null,evidence=null}={}){
 if(!task||!transitions[task.phase]?.includes(next))throw Error(`invalid task transition: ${task?.phase} -> ${next}`);
 if(!Number.isFinite(Date.parse(at)))throw Error('transition timestamp invalid');
 if(['succeeded','already_done'].includes(next)&&evidence?.authoritative!==true)throw Error('terminal success requires authoritative evidence');
 const event={at:new Date(at).toISOString(),from:task.phase,to:next,reason,evidence};
 return {...task,phase:next,lastEvent:event,events:[...(task.events??[]),event]};
}
export function createTaskInstance({origin,accountKey,businessDate,planHash,adapterId}={}){
 if(!/^https:\/\/[^\s/]+$/.test(String(origin))||!/^[A-Za-z0-9._-]+$/.test(String(accountKey))||!/^\d{4}-\d{2}-\d{2}$/.test(String(businessDate))||!/^[a-f0-9]{64}$/.test(String(planHash))||!/^\w[\w.-]+\.v\d+$/.test(String(adapterId)))throw Error('task identity invalid');
 const logicalSiteKey=normalizeOrigin(origin),identity=taskIdentity({businessDate,logicalSiteKey,accountKey,actionType:'checkin',scheduleOccurrence:'daily'});
 return {schemaVersion:1,taskId:identity.taskId,planUnitId:identity.planUnitId,origin:logicalSiteKey,logicalSiteKey,accountKey,businessDate,actionType:'checkin',scheduleOccurrence:'daily',planHash,adapterId,phase:'planned',mutationCount:0,events:[]};
}
export function prepareSubmission(task,{at=new Date().toISOString()}={}){
 let prepared=task;
 if(task.phase==='planned') prepared=transitionTask(transitionTask(transitionTask(task,'identity_verified',{at}), 'status_read',{at}), 'prepared',{at});
 else prepared=transitionTask(task,'prepared',{at});
 return {...prepared,intent:{id:`intent_${digest({taskId:task.taskId,planHash:task.planHash})}`,taskId:task.taskId,idempotencyKey:`idem_${crypto.createHash('sha256').update(`${task.businessDate}|${task.taskId}|checkin`).digest('hex').slice(0,24)}`,createdAt:new Date(at).toISOString(),mutationAllowed:true}};
}
export function markSubmissionUnknown(task,{at=new Date().toISOString(),reason='response_timeout'}={}){return transitionTask(transitionTask(task,'submitting',{at}),'submission_unknown',{at,reason});}
export function successfulVerification(task,evidence,{at=new Date().toISOString(),already=false}={}){
 if(task?.phase!=='verifying')throw Error('success requires verifying phase');
 return transitionTask(task,'succeeded',{at,evidence:{...evidence,authoritative:true},reason:already?'already_done':null});
}
