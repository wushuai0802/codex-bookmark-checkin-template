import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {createWorkerGateway} from '../src/worker-gateway.mjs';
import {createDashboardServer} from '../src/dashboard-server.mjs';
import {tokenDigest} from '../src/dry-transport-server.mjs';
import {runTransportWorker} from '../src/dry-transport-worker.mjs';

test('shared ingress isolates dashboard auth, rotates/revokes worker keys live, and executes no-op only',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'m2b-gateway-'));
 const registryFile=path.join(root,'registry.json'),old=crypto.randomBytes(32).toString('hex'),next=crypto.randomBytes(32).toString('hex');
 const workerId='worker_gateway01',origin='https://transport-canary.invalid';
 const write=key=>fs.writeFileSync(registryFile,JSON.stringify({schemaVersion:1,workers:key?[{workerId,credentialHash:tokenDigest(key),allowedOrigins:[origin],sourceMode:'canary'}]:[]}));
 write(old);
 const gateway=createWorkerGateway({registryFile,stateFile:path.join(root,'server.sqlite'),snapshotFile:path.join(root,'missing-snapshot.json')});
 const app=createDashboardServer({dataDir:root,adminToken:'dashboard-token-independent',bind:'127.0.0.1',port:0,workerGateway:gateway});
 await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
 const base=`http://127.0.0.1:${app.server.address().port}`;
 const status=key=>fetch(base+'/v2/dry/status',{method:'POST',headers:{Authorization:`Bearer ${key}`,'X-Fabric-Worker':workerId,'Content-Type':'application/json'},body:'{"mode":"dry_run"}'});
 try{
  assert.equal((await status('dashboard-token-independent')).status,401);
  assert.equal((await fetch(base+'/api/overview',{headers:{Authorization:`Bearer ${old}`}})).status,401);
  assert.equal((await status(old)).status,200);
  const result=await runTransportWorker({baseUrl:base,workerId,credential:old,allowedOrigins:[origin],stateFile:path.join(root,'worker.sqlite'),legacyRoot:path.join(root,'v1')});
  assert.equal(result.outcome,'reported');assert.equal(result.browserActions,0);
  write(next);assert.equal((await status(old)).status,401);assert.equal((await status(next)).status,200);
  write(null);assert.equal((await status(next)).status,401);
  assert.equal((await fetch(base+'/healthz')).status,200);
 }finally{await new Promise(resolve=>app.server.close(resolve));await gateway.close();fs.rmSync(root,{recursive:true,force:true});}
});
