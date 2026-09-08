// Temporary integration service. Synthetic .invalid targets only; no real plan.
import {createDryTransportServer} from '../src/dry-transport-server.mjs';
import {taskIdentity,planHash} from '../src/contracts.mjs';
const origin='https://m2-fixture.invalid';
function fixture(){
  const now=new Date().toISOString();
  const businessDate=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai'}).format(new Date(now));
  const task={...taskIdentity({businessDate,logicalSiteKey:origin,accountKey:'synthetic'}),origin,logicalSiteKey:origin,accountKey:'synthetic',businessDate,actionType:'checkin',observedStatus:'failed',executionOwner:'legacy-checkin'};
  return {mode:'shadow_read_only',generatedAt:now,businessDate,planHash:planHash([task]),tasks:[task],health:{healthy:true,sourceCheckedAt:now,freshness:{fresh:true,maxAgeHours:26}}};
}
const instance=createDryTransportServer({stateFile:'/state/transport.sqlite',legacyRoot:'/v1-not-mounted',port:18879,workers:[{workerId:'worker_nassmoke01',allowedOrigins:[origin],credentialHash:process.env.M2_WORKER_DIGEST}],snapshotProvider:fixture});
instance.server.listen(instance.port,instance.bind,()=>console.log('M2 synthetic dry transport ready'));
for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>instance.close().then(()=>process.exit(0)));
