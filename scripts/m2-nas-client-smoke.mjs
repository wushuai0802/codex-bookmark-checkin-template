// The credential remains in memory and is sent only through the loopback SSH tunnel.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {runTransportWorker} from '../src/dry-transport-worker.mjs';
import {tokenDigest} from '../src/dry-transport-server.mjs';
const [sshTarget,remoteSource,outputRoot]=process.argv.slice(2);
if(!/^[a-zA-Z0-9_-]+$/.test(sshTarget)||!/^\/home\/[a-zA-Z0-9_/-]+$/.test(remoteSource))throw Error('unsafe smoke configuration');
const name='checkin-fabric-m2-smoke-'+crypto.randomBytes(4).toString('hex');
const credential=crypto.randomBytes(32).toString('hex');
const root=fs.mkdtempSync(path.join(path.resolve(outputRoot),'m2-smoke-'));
const ssh=command=>execFileSync('ssh',['-o','BatchMode=yes','-o','ConnectTimeout=10',sshTarget,command],{encoding:'utf8',windowsHide:true,timeout:20000});
let started=false;
// This NAS denies TCP forwarding. Use its existing authorized SSH exec channel
// for the fixture test only; do not weaken SSH policy or expose an HTTP port.
const relayCode=`import json,sys,urllib.request,urllib.error
r=json.load(sys.stdin)
assert r['path'] in ['/v2/dry/claim','/v2/dry/receipt']
q=urllib.request.Request('http://127.0.0.1:18879'+r['path'],data=r['body'].encode(),headers=r['headers'],method='POST')
try:
 s=urllib.request.urlopen(q,timeout=8)
except urllib.error.HTTPError as e:
 s=e
print(json.dumps({'status':s.status,'body':s.read(65537).decode()}))`;
const encoded=Buffer.from(relayCode).toString('base64');
const fetchRelay=async(url,options)=>{
  const command=`python3 -c \"import base64;exec(base64.b64decode('${encoded}'))\"`;
  const raw=execFileSync('ssh',['-o','BatchMode=yes',sshTarget,command],{input:JSON.stringify({path:new URL(url).pathname,body:options.body,headers:options.headers}),encoding:'utf8',windowsHide:true,timeout:15000});
  const reply=JSON.parse(raw);return new Response(reply.body,{status:reply.status});
};
try{
  ssh(`sudo -n docker run --rm -d --name ${name} --network host --read-only --cap-drop ALL --security-opt no-new-privileges --tmpfs /state:rw,noexec,nosuid,size=16m,mode=0777 -v ${remoteSource}:/app:ro -e M2_WORKER_DIGEST=${tokenDigest(credential)} --entrypoint node codex-checkin-fabric-v2:beta /app/scripts/m2-nas-fixture.mjs`);
  started=true;
  const options={baseUrl:'http://127.0.0.1:18879',workerId:'worker_nassmoke01',credential,allowedOrigins:['https://m2-fixture.invalid'],stateFile:path.join(root,'worker.sqlite'),legacyRoot:path.join(root,'v1-excluded'),fetchImpl:fetchRelay};
  let first;for(let attempt=0;attempt<4;attempt++){first=await runTransportWorker({...options,fault:'after_outbox'});if(first.outcome!=='transport_unavailable')break;await new Promise(r=>setTimeout(r,500));}
  console.log('Initial dry-run: '+first?.outcome);
  const offline=await runTransportWorker({...options,fetchImpl:async()=>{throw Error('injected offline');}});
  const recovered=await runTransportWorker(options);
  console.log('Recovered delivery: '+recovered.outcome);
  const duplicate=await runTransportWorker(options);
  if(first?.outcome!=='outbox_pending'||offline.outcome!=='outbox_pending'||recovered.outcome!=='reported'||duplicate.outcome!=='idle')throw Error('NAS dry transport acceptance failed');
  const result={nasRoundTrip:true,independentCredential:true,transport:'encrypted-ssh-exec-fixture-relay',directHttpsTested:false,first:first.outcome,offline:offline.outcome,recovered:recovered.outcome,duplicate:duplicate.outcome,realCheckins:0,browserActions:0,permanentWorkerInstalled:false};
  fs.writeFileSync(path.join(root,'acceptance.json'),JSON.stringify(result,null,2));console.log(JSON.stringify({...result,output:root}));
}catch(error){
  if(started)console.error(ssh(`sudo -n docker logs --tail 15 ${name}`));
  throw error;
}finally{
  if(started){ssh(`sudo -n docker stop ${name}`);console.log('Temporary NAS fixture container removed');}
}
