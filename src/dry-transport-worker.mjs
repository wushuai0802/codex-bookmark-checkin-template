import crypto from 'node:crypto';
import {openTransportStore,transaction} from './transport-store.mjs';
import {leaseActive,idempotencyKey} from './candidate-protocol.mjs';
const hash=v=>crypto.createHash('sha256').update(JSON.stringify(v)).digest('hex');

export function validateDryEnvelope(envelope,{workerId,allowedOrigins,now}){
  if(!envelope||envelope.mode!=='dry_run'||envelope.adapter!=='dry.noop.v1'||!Number.isSafeInteger(envelope.transportEpoch)||envelope.transportEpoch<1)throw Error('non-dry envelope refused');
  if(envelope.lease?.owner!==workerId||envelope.lease.taskId!==envelope.taskId||envelope.lease.planHash!==envelope.planHash||!leaseActive(envelope.lease,{now}))throw Error('invalid dry lease');
  if(!allowedOrigins.includes(envelope.target?.origin)||envelope.target.actionType!=='checkin'||envelope.target.logicalSiteKey!==envelope.target.origin)throw Error('target not allowlisted');
  if(envelope.idempotencyKey!==idempotencyKey(envelope))throw Error('invalid task identity');
  if(!/^envelope_[a-f0-9]{24}$/.test(envelope.envelopeId))throw Error('invalid envelope id');
  if(new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai'}).format(new Date(now))!==envelope.businessDate)throw Error('wrong business date');
  return true;
}

export async function runTransportWorker({baseUrl,workerId,credential,allowedOrigins,stateFile,legacyRoot,clock=()=>new Date().toISOString(),fetchImpl=fetch,fault=null}={}){
  const url=new URL(baseUrl);
  if(url.username||url.password||url.search||url.hash||url.pathname!=='/'||!(url.protocol==='https:'||(url.protocol==='http:'&&['127.0.0.1','[::1]'].includes(url.hostname))))throw Error('worker requires HTTPS or loopback transport');
  if(typeof credential!=='string'||credential.length<32||credential.length>256)throw Error('independent worker credential required');
  const db=openTransportStore(stateFile,legacyRoot);
  async function post(route,body){
    const response=await fetchImpl(new URL(route,url),{method:'POST',redirect:'error',headers:{'Content-Type':'application/json','Connection':'close','X-Fabric-Worker':workerId,Authorization:`Bearer ${credential}`},body:JSON.stringify(body),signal:AbortSignal.timeout(8000)});
    let text='';
    const reader=response.body.getReader(),decoder=new TextDecoder();let size=0;
    for(;;){const chunk=await reader.read();if(chunk.done)break;size+=chunk.value.byteLength;if(size>65536){await reader.cancel();throw Error('transport response too large');}text+=decoder.decode(chunk.value,{stream:true});}
    text+=decoder.decode();
    if(!response.ok)throw Object.assign(new Error('transport rejected request'),{status:response.status});
    return JSON.parse(text);
  }
  const send=async row=>{
    try{
      const ack=await post('/v2/dry/receipt',JSON.parse(row.receipt));
      if(ack.accepted!==true)throw Error('receipt not acknowledged');
      db.prepare("UPDATE local_jobs SET phase='reported' WHERE key=?").run(row.key);
      return 'reported';
    }catch(error){
      if([400,403,409].includes(error.status)){db.prepare("UPDATE local_jobs SET phase='review' WHERE key=?").run(row.key);return 'receipt_review';}
      return 'outbox_pending';
    }
  };
  try{
    const pending=db.prepare("SELECT * FROM local_jobs WHERE phase='outbox' ORDER BY key LIMIT 1").get();
    if(pending)return {mode:'dry_run',outcome:await send(pending),browserActions:0};
    let result;
    try{result=await post('/v2/dry/claim',{mode:'dry_run',now:clock()});}
    catch(error){if(error.status)throw error;return {mode:'dry_run',outcome:'transport_unavailable',browserActions:0};}
    if(result.executeEnabled!==false||result.mode!=='dry_run')throw Error('unexpected execution permission');
    if(!result.envelope)return {mode:'dry_run',outcome:'idle',browserActions:0};
    const envelope=result.envelope;
    validateDryEnvelope(envelope,{workerId,allowedOrigins,now:clock()});
    const binding=hash(envelope),key=envelope.idempotencyKey;
    const old=transaction(db,()=>{
      const existing=db.prepare('SELECT * FROM local_jobs WHERE key=?').get(key);
      if(existing)return existing;
      db.prepare("INSERT INTO local_jobs(key,binding,phase) VALUES(?,?,'prepared')").run(key,binding);
      return null;
    });
    if(old)return {mode:'dry_run',outcome:old.binding!==binding?'binding_conflict':old.phase==='reported'?'duplicate':'interrupted_requires_review',browserActions:0};
    if(fault==='after_prepare')throw Error('injected interruption');
    // Intentionally no browser, shell, login, registration or site/network adapter.
    const receipt={idempotencyKey:key,envelopeId:envelope.envelopeId,leaseId:envelope.lease.leaseId,epoch:envelope.transportEpoch,mode:'dry_run',status:'dry_run_complete',browserActions:0};
    db.prepare("UPDATE local_jobs SET phase='outbox',receipt=? WHERE key=?").run(JSON.stringify(receipt),key);
    if(fault==='after_outbox')return {mode:'dry_run',outcome:'outbox_pending',browserActions:0};
    return {mode:'dry_run',outcome:await send({key,receipt:JSON.stringify(receipt)}),browserActions:0};
  }finally{db.close();}
}
