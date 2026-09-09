import fs from 'node:fs';
import path from 'node:path';
import {buildCanaryTask} from './canary-task.mjs';
import {runCanary} from './canary-runner.mjs';

function executionWindow(now,schedule) {
  const [hour,minute]=String(schedule).split(':').map(Number),parts=new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Shanghai',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(now),current=Number(parts.slice(0,2))*60+Number(parts.slice(3,5));
  return {current,scheduled:hour*60+minute,display:parts};
}

export async function runDaily({root=path.resolve('.'),legacyRoot,execute=false,accountKey=null,now=new Date(),runAccount=runCanary,notifyAccount=null}={}) {
  if(!legacyRoot)throw Error('legacyRoot is required'); if(!Number.isFinite(now.getTime()))throw Error('now is invalid');
  const day=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai'}).format(now),config=JSON.parse(fs.readFileSync(path.join(legacyRoot,'config','config.json'),'utf8'));
  const schedule=String(config.schedule??'08:05'),window=executionWindow(now,schedule);
  if(execute&&(window.current<window.scheduled-30||window.current>window.scheduled+5))throw Error(`V2 daily execute window is closed (${schedule}, now ${window.display})`);
  const planFile=path.join(legacyRoot,'data','last-valid-bookmark-plan.json'),plan=fs.existsSync(planFile)?JSON.parse(fs.readFileSync(planFile,'utf8')):{};
  const planHash=/^[a-f0-9]{64}$/.test(String(plan.planFingerprint??''))?plan.planFingerprint:'0'.repeat(64);
  const registry=JSON.parse(fs.readFileSync(path.join(root,'outputs','v2-profile-registry.json'),'utf8'));
  const outputDir=path.join(root,'outputs'),files=fs.readdirSync(outputDir).filter(name=>/^migration-[A-Za-z0-9._-]+\.json$/.test(name)),results=[];
  for(const file of files){
    const migration=JSON.parse(fs.readFileSync(path.join(outputDir,file),'utf8')); if(accountKey&&migration.accountKey!==accountKey)continue; if(!['candidate','active'].includes(migration.state)||!migration.origin||!migration.accountKey)continue;
    const profile=registry.profiles.find(item=>item.accountKey===migration.accountKey&&item.origin===migration.origin&&item.state==='ready');
    if(!profile){results.push({accountKey:migration.accountKey,state:'blocked',reason:'profile_not_ready'});continue;}
    const task=buildCanaryTask({profile,businessDate:day,planHash,adapterRule:migration.adapterRule??{}}),result=await runAccount({task,execute,root,legacyRoot,runAccount});
    if(!execute&&result.mutationCount!==0)throw Error(`read-only daily runner received a mutation for ${migration.accountKey}`);
    results.push({accountKey:migration.accountKey,origin:migration.origin,stage:result.stage,phase:result.phase,mutationCount:result.mutationCount,output:result.output??null});
    if(execute&&result.stage==='succeeded'&&result.mutationCount===1){const updated={...migration,state:'active',ownership:{...migration.ownership,current:'v2-worker',switchedAt:result.completedAt},lastSuccessAt:result.completedAt};fs.writeFileSync(path.join(outputDir,file),JSON.stringify(updated,null,2),'utf8');}
    if(execute&&result.output&&notifyAccount)await notifyAccount(result.output);
  }
  const report={schemaVersion:1,mode:execute?'v2_daily_execute':'v2_daily_read_only',businessDate:day,scheduledAt:schedule,observedAt:now.toISOString(),executionEnabled:execute,results},output=path.join(outputDir,`v2-daily-${day}.json`);fs.writeFileSync(output,JSON.stringify(report,null,2),'utf8');return {...report,output};
}

async function runAccount({task,execute,root,legacyRoot}) { return runCanary({task,execute,root,legacyRoot,writeOutput:true}); }
