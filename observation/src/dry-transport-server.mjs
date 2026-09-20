import http from 'node:http';
import crypto from 'node:crypto';
import {openTransportStore,transaction} from './transport-store.mjs';
import {evaluateCandidateDispatch,createLease,createTaskEnvelope,idempotencyKey,leaseActive} from './candidate-protocol.mjs';

export const tokenDigest=token=>crypto.createHash('sha256').update(token).digest('hex');
const hash=value=>tokenDigest(JSON.stringify(value));
const loopback=new Set(['127.0.0.1','::1']);
const denied=(status,message)=>Object.assign(new Error(message),{status});
const fields=(body,allowed)=>{
  if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).some(key=>!allowed.includes(key)))throw denied(400,'invalid_request');
};

export function createDryTransportServer({stateFile,legacyRoot,workers,registryProvider=null,snapshotProvider,epoch=1,clock=()=>new Date().toISOString(),bind='127.0.0.1',port=0}={}){
  if(!loopback.has(bind))throw Error('dry transport binds loopback only; use TLS termination or SSH forwarding');
  if(!Number.isSafeInteger(epoch)||epoch<1)throw Error('invalid epoch');
  if(!Array.isArray(workers)||!workers.length)throw Error('worker registry required');
  const registry=new Map();
  for(const worker of workers){
    if(!/^worker_[A-Za-z0-9_-]{8,80}$/.test(worker.workerId)||!/^[a-f0-9]{64}$/.test(worker.credentialHash)||registry.has(worker.workerId))throw Error('invalid worker registration');
    if(!Array.isArray(worker.allowedOrigins)||worker.allowedOrigins.some(origin=>new URL(origin).origin!==origin||!origin.startsWith('https://')))throw Error('invalid worker allowlist');
    registry.set(worker.workerId,structuredClone(worker));
  }
  const db=openTransportStore(stateFile,legacyRoot);
  try{transaction(db,()=>{
    const old=Number(db.prepare("SELECT value FROM meta WHERE key='epoch'").get()?.value??0);
    if(epoch<old)throw Error('epoch rollback refused');
    db.prepare("INSERT INTO meta VALUES('epoch',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(String(epoch));
    if(epoch>old)db.prepare("UPDATE jobs SET phase='quarantined' WHERE epoch<>? AND phase<>'accepted'").run(epoch);
  });}catch(error){db.close();throw error;}
  const currentEpoch=()=>Number(db.prepare("SELECT value FROM meta WHERE key='epoch'").get().value);
  function authenticate(request){
    const current=registryProvider?registryProvider():[...registry.values()];
    const matches=current.filter(worker=>worker.workerId===request.headers['x-fabric-worker']);
    const worker=matches.length===1?matches[0]:null;
    const auth=request.headers.authorization;
    if(!worker||!/^[a-f0-9]{64}$/.test(worker.credentialHash)||typeof auth!=='string'||!auth.startsWith('Bearer ')||auth.length>512)throw denied(401,'unauthorized');
    const digest=tokenDigest(auth.slice(7));
    if(!crypto.timingSafeEqual(Buffer.from(digest,'hex'),Buffer.from(worker.credentialHash,'hex')))throw denied(401,'unauthorized');
    return worker;
  }
  function claim(worker,body){
    fields(body,['mode','now']);
    if(body.mode!=='dry_run')throw denied(400,'execute_disabled');
    const now=clock();
    if(!Number.isFinite(Date.parse(body.now))||Math.abs(Date.parse(now)-Date.parse(body.now))>60_000)throw denied(409,'clock_skew');
    if(currentEpoch()!==epoch)throw denied(409,'server_epoch_stale');
    const snapshot=snapshotProvider(worker);
    if(!snapshot||!Array.isArray(snapshot.tasks)||snapshot.tasks.length>1000)throw denied(503,'snapshot_unavailable');
    const capability={...worker,platform:'windows',capabilities:['api_evidence'],executionModes:['dry_run'],profileIsolation:true,heartbeatAt:body.now};
    return transaction(db,()=>{
      let selected=null;
      db.prepare("UPDATE jobs SET phase='quarantined' WHERE phase='active' AND (epoch<>? OR json_extract(envelope,'$.lease.expiresAt')<=?)").run(epoch,now);
      for(const task of snapshot.tasks){
        if(evaluateCandidateDispatch({snapshot,taskId:task.taskId,worker:capability,now}).decision!=='dry_run')continue;
        const key=idempotencyKey(task),old=db.prepare('SELECT * FROM jobs WHERE key=?').get(key);
        if(old){
          const stored=JSON.parse(old.envelope);
          if(old.phase==='active'&&(!leaseActive(stored.lease,{now})||old.epoch!==epoch||stored.planHash!==snapshot.planHash))db.prepare("UPDATE jobs SET phase='quarantined' WHERE key=?").run(key);
          else if(old.phase==='active'&&old.worker===worker.workerId)return stored;
          continue;
        }
        selected??=task;
      }
      if(!selected)return null;
      // A worker has one active dry lease; expired/ambiguous jobs are never reissued.
      if(db.prepare("SELECT 1 FROM jobs WHERE worker=? AND phase='active'").get(worker.workerId))return null;
      const lease=createLease({taskId:selected.taskId,planHash:snapshot.planHash,owner:worker.workerId,issuedAt:now,ttlSeconds:120});
      const envelope={...createTaskEnvelope({snapshot,task:selected,lease}),transportEpoch:epoch,adapter:'dry.noop.v1'};
      db.prepare('INSERT INTO jobs(key,worker,epoch,envelope,phase) VALUES(?,?,?,?,?)').run(envelope.idempotencyKey,worker.workerId,epoch,JSON.stringify(envelope),'active');
      return envelope;
    });
  }
  function accept(worker,body){
    fields(body,['idempotencyKey','envelopeId','leaseId','epoch','mode','status','browserActions']);
    if(body.mode!=='dry_run'||body.status!=='dry_run_complete'||body.browserActions!==0)throw denied(400,'invalid_dry_receipt');
    return transaction(db,()=>{
      const old=db.prepare('SELECT * FROM jobs WHERE key=?').get(body.idempotencyKey);
      if(!old||old.worker!==worker.workerId)throw denied(403,'receipt_owner_mismatch');
      const envelope=JSON.parse(old.envelope);
      if(body.envelopeId!==envelope.envelopeId||body.leaseId!==envelope.lease.leaseId||body.epoch!==old.epoch)throw denied(409,'receipt_binding_mismatch');
      if(old.phase==='accepted'){
        if(hash(JSON.parse(old.receipt))!==hash(body))throw denied(409,'receipt_conflict');
        return {accepted:true,duplicate:true};
      }
      if(old.phase!=='active'||currentEpoch()!==old.epoch||!leaseActive(envelope.lease,{now:clock()}))throw denied(409,'lease_expired_or_fenced');
      db.prepare("UPDATE jobs SET phase='accepted',receipt=? WHERE key=?").run(JSON.stringify(body),body.idempotencyKey);
      return {accepted:true,duplicate:false};
    });
  }
  const server=http.createServer(async(request,response)=>{
    const send=(status,body)=>{response.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});response.end(JSON.stringify(body));};
    try{
      const worker=authenticate(request);
      if(request.method!=='POST'||!['/v2/dry/claim','/v2/dry/receipt','/v2/dry/status'].includes(request.url))throw denied(404,'route_not_found');
      if(!(request.headers['content-type']??'').startsWith('application/json'))throw denied(415,'json_required');
      let raw='';for await(const chunk of request){raw+=chunk.toString('utf8');if(Buffer.byteLength(raw)>8192)throw denied(413,'request_too_large');}
      let body;try{body=JSON.parse(raw);}catch{throw denied(400,'invalid_json');}
      let value;
      if(request.url.endsWith('/status')){fields(body,['mode']);if(body.mode!=='dry_run')throw denied(400,'execute_disabled');
        value={mode:'dry_run',executeEnabled:false,epoch:currentEpoch(),workerId:worker.workerId,jobs:db.prepare('SELECT phase,count(*) AS count FROM jobs WHERE worker=? GROUP BY phase').all(worker.workerId)};
      }else value=request.url.endsWith('/claim')?{mode:'dry_run',executeEnabled:false,envelope:claim(worker,body)}:accept(worker,body);
      send(200,value);
    }catch(error){send(error.status??503,{error:error.status?error.message:'transport_unavailable'});}
  });
  server.requestTimeout=10_000;server.headersTimeout=10_000;server.maxHeadersCount=20;
  return {server,db,bind,port,close:async()=>{if(server.listening)await new Promise(resolve=>server.close(resolve));db.close();}};
}
