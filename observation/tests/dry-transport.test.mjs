import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawn} from 'node:child_process';
import {createDryTransportServer,tokenDigest} from '../src/dry-transport-server.mjs';
import {runTransportWorker,validateDryEnvelope} from '../src/dry-transport-worker.mjs';
import {planHash,taskIdentity} from '../src/contracts.mjs';

const now='2026-09-08T01:00:00.000Z',origin='https://fixture.example',workerId='worker_transport01';
function snapshot(){const task={...taskIdentity({businessDate:'2026-09-08',logicalSiteKey:origin,accountKey:'primary'}),origin,logicalSiteKey:origin,accountKey:'primary',businessDate:'2026-09-08',actionType:'checkin',executionOwner:'legacy-checkin',observedStatus:'failed'};
 return {mode:'shadow_read_only',generatedAt:now,businessDate:'2026-09-08',tasks:[task],planHash:planHash([task]),health:{healthy:true,sourceCheckedAt:now,freshness:{fresh:true,maxAgeHours:26}}};}
async function setup(t){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'fabric-m2-')),credential=crypto.randomBytes(32).toString('hex');
 let time=now,data=snapshot(),instance;
 const config={stateFile:path.join(root,'server.sqlite'),legacyRoot:path.join(root,'v1'),workers:[{workerId,credentialHash:tokenDigest(credential),allowedOrigins:[origin]}],snapshotProvider:()=>data,clock:()=>time};
 async function start(epoch=1){instance=createDryTransportServer({...config,epoch});await new Promise(resolve=>instance.server.listen(0,instance.bind,resolve));return `http://127.0.0.1:${instance.server.address().port}`;}
 let baseUrl=await start();
 const options=()=>({baseUrl,workerId,credential,allowedOrigins:[origin],stateFile:path.join(root,'worker.sqlite'),legacyRoot:config.legacyRoot,clock:()=>time});
 t.after(async()=>{await instance.close();fs.rmSync(root,{recursive:true,force:true});});
 return {root,config,credential,options,get instance(){return instance;},time:v=>time=v,data:v=>data=v,
  restart:async epoch=>{await instance.close();baseUrl=await start(epoch);},
  post:async(route,body,token=credential,id=workerId)=>fetch(baseUrl+route,{method:'POST',headers:{'Content-Type':'application/json','X-Fabric-Worker':id,Authorization:`Bearer ${token}`},body:JSON.stringify(body)})};
}
const claim=async h=>(await (await h.post('/v2/dry/claim',{mode:'dry_run',now})).json()).envelope;
const receipt=e=>({idempotencyKey:e.idempotencyKey,envelopeId:e.envelopeId,leaseId:e.lease.leaseId,epoch:e.transportEpoch,mode:'dry_run',status:'dry_run_complete',browserActions:0});

test('authenticated loopback worker round trip survives server/worker restart without reexecution',async t=>{
 const h=await setup(t);assert.equal((await runTransportWorker(h.options())).outcome,'reported');
 await h.restart(1);assert.equal((await runTransportWorker(h.options())).outcome,'idle');
 assert.equal(h.instance.db.prepare("SELECT count(*) n FROM jobs WHERE phase='accepted'").get().n,1);
});
test('unauthorized worker, execute mode, commands, and wrong worker receipt are denied',async t=>{
 const h=await setup(t);
 assert.equal((await h.post('/v2/dry/claim',{mode:'dry_run',now},'wrong')).status,401);
 assert.equal((await h.post('/v2/dry/claim',{mode:'execute',now})).status,400);
 assert.equal((await h.post('/v2/dry/claim',{mode:'dry_run',now,command:'execute arbitrary code'})).status,400);
 const e=await claim(h);
 assert.equal((await h.post('/v2/dry/receipt',{...receipt(e),status:'signed'})).status,400);
 assert.equal((await h.post('/v2/dry/receipt',receipt(e),h.credential,'worker_other001')).status,401);
 assert.equal((await h.post('/v2/dry/receipt',{...receipt(e),epoch:2})).status,409);
});
test('lost claim response resumes the same lease rather than issuing another',async t=>{
 const h=await setup(t);const a=await claim(h);await h.restart(1);const b=await claim(h);
 assert.equal(a.envelopeId,b.envelopeId);assert.equal(h.instance.db.prepare('SELECT count(*) n FROM jobs').get().n,1);
});
test('receipt accepted then response lost is durably retried once after restart',async t=>{
 const h=await setup(t);let dropped=false;
 const fetchImpl=async(url,options)=>{const r=await fetch(url,options);if(String(url).endsWith('/receipt')&&!dropped){dropped=true;await r.text();throw Error('response lost');}return r;};
 assert.equal((await runTransportWorker({...h.options(),fetchImpl})).outcome,'outbox_pending');
 await h.restart(1);assert.equal((await runTransportWorker(h.options())).outcome,'reported');
 assert.equal(h.instance.db.prepare('SELECT count(*) n FROM jobs').get().n,1);
});
test('interruption after preparation never blindly replays',async t=>{
 const h=await setup(t);await assert.rejects(runTransportWorker({...h.options(),fault:'after_prepare'}),/interruption/);
 assert.equal((await runTransportWorker(h.options())).outcome,'interrupted_requires_review');
 assert.equal(h.instance.db.prepare("SELECT count(*) n FROM jobs WHERE phase='accepted'").get().n,0);
});
test('epoch increase fences old workers and epoch rollback is rejected',async t=>{
 const h=await setup(t);const e=await claim(h);await h.restart(2);
 assert.equal((await h.post('/v2/dry/receipt',receipt(e))).status,409);
 assert.equal(await claim(h),null);
 assert.throws(()=>createDryTransportServer({...h.config,epoch:1}),/rollback/);
});
test('expired lease is quarantined; late result cannot establish execution success',async t=>{
 const h=await setup(t);const e=await claim(h);h.time('2026-09-08T01:03:00Z');
 assert.equal((await h.post('/v2/dry/receipt',receipt(e))).status,409);
 const reply=await h.post('/v2/dry/claim',{mode:'dry_run',now:'2026-09-08T01:03:00Z'});assert.equal((await reply.json()).envelope,null);
 assert.equal(h.instance.db.prepare('SELECT phase FROM jobs').get().phase,'quarantined');
});
test('stale snapshots, clock skew, reconciliation conflicts, and monitor-only sites do not dispatch',async t=>{
 const h=await setup(t);
 assert.equal((await h.post('/v2/dry/claim',{mode:'dry_run',now:'2026-09-07T00:00:00Z'})).status,409);
 h.data({...snapshot(),generatedAt:'2026-09-01T00:00:00Z'});assert.equal(await claim(h),null);
 h.data({...snapshot(),reconciliation:{missingCount:1}});assert.equal(await claim(h),null);
 h.data({...snapshot(),tasks:[],planHash:planHash([]),ptStatus:{sites:[{origin}]}});assert.equal(await claim(h),null);
});
test('offline completed worker retains outbox and uploads without a new attempt',async t=>{
 const h=await setup(t);assert.equal((await runTransportWorker({...h.options(),fault:'after_outbox'})).outcome,'outbox_pending');
 assert.equal((await runTransportWorker({...h.options(),fetchImpl:async()=>{throw Error('offline');}})).outcome,'outbox_pending');
 assert.equal((await runTransportWorker(h.options())).outcome,'reported');
});
test('concurrent claims and workers cannot prepare more than one dry task',async t=>{
 const h=await setup(t);const claims=await Promise.all([claim(h),claim(h)]);assert.equal(claims[0].envelopeId,claims[1].envelopeId);
 const runs=await Promise.all([runTransportWorker(h.options()),runTransportWorker(h.options())]);
 assert.ok(runs.some(r=>r.outcome==='reported'));assert.equal(h.instance.db.prepare('SELECT count(*) n FROM jobs').get().n,1);
});
test('client rejects redirects, nonallowlisted target, execute envelopes and V1 journal path',async t=>{
 const h=await setup(t);const e=await claim(h);const context={workerId,allowedOrigins:[origin],now};
 assert.throws(()=>validateDryEnvelope({...e,mode:'execute'},context),/non-dry/);
 assert.throws(()=>validateDryEnvelope(e,{...context,allowedOrigins:[]}),/allowlisted/);
 await assert.rejects(runTransportWorker({...h.options(),baseUrl:'http://example.com/'}),/HTTPS/);
 await assert.rejects(runTransportWorker({...h.options(),stateFile:path.join(h.config.legacyRoot,'bad.sqlite')}),/V1/);
});

test('credential rotation revokes the old worker key without reassigning its pending work',async t=>{
 const h=await setup(t);await claim(h);
 h.config.workers[0].credentialHash=tokenDigest(crypto.randomBytes(32).toString('hex'));
 await h.restart(1);
 assert.equal((await h.post('/v2/dry/claim',{mode:'dry_run',now})).status,401);
 assert.equal(h.instance.db.prepare('SELECT count(*) n FROM jobs').get().n,1);
});

test('WAL intent survives abrupt child exit without close and is not replayed',async t=>{
 const h=await setup(t);const envelope=await claim(h);
 const source=`import fs from 'node:fs';import crypto from 'node:crypto';import {openTransportStore} from ${JSON.stringify(new URL('../src/transport-store.mjs',import.meta.url).href)};
 const args=JSON.parse(fs.readFileSync(0,'utf8'));const db=openTransportStore(args.file,args.legacy);
 db.prepare("INSERT INTO local_jobs(key,binding,phase) VALUES(?,?,'prepared')").run(args.envelope.idempotencyKey,crypto.createHash('sha256').update(JSON.stringify(args.envelope)).digest('hex'));
 process.exit(77);`;
 const child=spawn(process.execPath,['--input-type=module','-e',source],{windowsHide:true,stdio:['pipe','ignore','pipe']});
 const exited=new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve);});
 child.stdin.end(JSON.stringify({file:h.options().stateFile,legacy:h.config.legacyRoot,envelope}));
 assert.equal(await exited,77);
 assert.equal((await runTransportWorker(h.options())).outcome,'interrupted_requires_review');
});

test('remote redirect response is never followed with worker credentials',async t=>{
 const h=await setup(t);let called=0;
 const fetchImpl=async(url,options)=>{called++;assert.equal(options.redirect,'error');throw new TypeError('redirect rejected');};
 assert.equal((await runTransportWorker({...h.options(),fetchImpl})).outcome,'transport_unavailable');assert.equal(called,1);
});
test('database write refusal returns unavailable and creates no phantom lease',async t=>{
 const h=await setup(t);h.instance.db.exec('PRAGMA query_only=ON');
 assert.equal((await h.post('/v2/dry/claim',{mode:'dry_run',now})).status,503);
 assert.equal(h.instance.db.prepare('SELECT count(*) n FROM jobs').get().n,0);
 h.instance.db.exec('PRAGMA query_only=OFF');assert.ok(await claim(h));
});
