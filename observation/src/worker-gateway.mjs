import fs from 'node:fs';
import path from 'node:path';
import {createDryTransportServer} from './dry-transport-server.mjs';
import {taskIdentity,planHash} from './contracts.mjs';

export function createWorkerGateway({registryFile,stateFile,snapshotFile}){
  const registry=()=>{
    const data=JSON.parse(fs.readFileSync(registryFile,'utf8'));
    if(data.schemaVersion!==1||!Array.isArray(data.workers)||data.workers.length>20)throw Error('invalid worker registry');
    for(const w of data.workers){
      if(!/^worker_[A-Za-z0-9_-]{8,80}$/.test(w.workerId)||!/^[a-f0-9]{64}$/.test(w.credentialHash)||!['shadow','canary'].includes(w.sourceMode))throw Error('invalid worker registration');
      if(!Array.isArray(w.allowedOrigins)||w.allowedOrigins.length>1000||w.allowedOrigins.some(origin=>new URL(origin).origin!==origin||!origin.startsWith('https://')))throw Error('invalid worker scope');
    }
    if(new Set(data.workers.map(w=>w.workerId)).size!==data.workers.length)throw Error('duplicate worker');
    return data.workers;
  };
  function snapshotProvider(worker){
    if(worker.sourceMode==='shadow')return JSON.parse(fs.readFileSync(snapshotFile,'utf8'));
    const origin='https://transport-canary.invalid',now=new Date().toISOString(),businessDate=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai'}).format(new Date());
    const task={...taskIdentity({businessDate,logicalSiteKey:origin,accountKey:'canary'}),origin,logicalSiteKey:origin,accountKey:'canary',businessDate,actionType:'checkin',observedStatus:'failed',executionOwner:'legacy-checkin'};
    return {mode:'shadow_read_only',tasks:[task],planHash:planHash([task]),businessDate,generatedAt:now,health:{healthy:true,sourceCheckedAt:now,freshness:{fresh:true,maxAgeHours:26}}};
  }
  const transport=createDryTransportServer({stateFile,legacyRoot:path.resolve('/v1-not-mounted'),workers:registry(),registryProvider:registry,snapshotProvider});
  const hits=new Map();
  return {close:()=>transport.close(),handle(request,response){
    // Shared TLS ingress, independent worker authorization and bounded rate budget.
    const key=request.socket.remoteAddress??'unknown',now=Date.now();
    if(hits.size>1000)for(const [id,hit] of hits)if(now-hit.at>60_000)hits.delete(id);
    const hit=hits.get(key);const current=hit&&now-hit.at<60_000?hit:{at:now,count:0};current.count++;hits.set(key,current);
    if(current.count>60||hits.size>1100){response.writeHead(429,{'Content-Type':'application/json','Retry-After':'60'});response.end('{"error":"rate_limited"}');return;}
    transport.server.emit('request',request,response);
  }};
}
