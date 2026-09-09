#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {buildCanaryTask} from '../src/canary-task.mjs';
import {runCanary} from '../src/canary-runner.mjs';
import {loadRuntimeConfig} from '../src/runtime-config.mjs';

const root=path.resolve('.');
const runtime=loadRuntimeConfig(root),legacyRoot=runtime.legacyRoot;
if(!legacyRoot)throw Error('legacyRoot is required');
const execute=process.argv.includes('--execute');
const accountArg=process.argv.find((value,index)=>process.argv[index-1]==='--account-key');
const selectedAccount=accountArg?String(accountArg).trim():null;
const nowArg=process.argv.find((value,index)=>process.argv[index-1]==='--now');
const now=nowArg?new Date(nowArg):new Date();
if(!Number.isFinite(now.getTime())) throw Error('invalid --now');
const day=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai'}).format(now);
const parts=new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Shanghai',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(now);
const config=JSON.parse(fs.readFileSync(path.join(legacyRoot,'config','config.json'),'utf8'));
const currentPlanFile=path.join(legacyRoot,'data','last-valid-bookmark-plan.json');
const currentPlan=fs.existsSync(currentPlanFile)?JSON.parse(fs.readFileSync(currentPlanFile,'utf8')):{};
const planHash=/^[a-f0-9]{64}$/.test(String(currentPlan.planFingerprint??''))?currentPlan.planFingerprint:'0'.repeat(64);
const schedule=String(config.schedule??'08:05');
const [hour,minute]=schedule.split(':').map(Number);
const minutes=Number(parts.slice(0,2))*60+Number(parts.slice(3,5)),scheduled=hour*60+minute;
if(execute && (minutes<scheduled-30 || minutes>scheduled+5)) throw Error(`V2 daily execute window is closed (${schedule}, now ${parts})`);
const registry=JSON.parse(fs.readFileSync(path.join(root,'outputs','v2-profile-registry.json'),'utf8'));
const migrationFiles=fs.readdirSync(path.join(root,'outputs')).filter(name=>/^migration-[A-Za-z0-9._-]+\.json$/.test(name));
const results=[];
for(const file of migrationFiles){
  const migration=JSON.parse(fs.readFileSync(path.join(root,'outputs',file),'utf8'));
  if(selectedAccount&&migration.accountKey!==selectedAccount)continue;
  if(!['candidate','active'].includes(migration.state)||!migration.origin||!migration.accountKey)continue;
  const profile=registry.profiles.find(item=>item.accountKey===migration.accountKey&&item.origin===migration.origin&&item.state==='ready');
  if(!profile){results.push({accountKey:migration.accountKey,state:'blocked',reason:'profile_not_ready'});continue;}
  const task=buildCanaryTask({profile,businessDate:day,planHash,adapterRule:migration.adapterRule??{}});
  const result=await runCanary({task,execute,root,legacyRoot,writeOutput:true});
  results.push({accountKey:migration.accountKey,origin:migration.origin,stage:result.stage,phase:result.phase,mutationCount:result.mutationCount,output:result.output??null});
  if(execute&&result.stage==='succeeded'&&result.mutationCount===1){
    const updated={...migration,state:'active',ownership:{...migration.ownership,current:'v2-worker',switchedAt:result.completedAt},lastSuccessAt:result.completedAt};
    fs.writeFileSync(path.join(root,'outputs',file),JSON.stringify(updated,null,2),'utf8');
  }
  if(execute&&result.output){
    await new Promise(resolve=>{const child=spawn(process.execPath,[path.join(root,'scripts','notify-canary-result.mjs'),result.output],{windowsHide:true,stdio:'ignore'});child.once('exit',()=>resolve());child.once('error',()=>resolve());});
  }
}
const report={schemaVersion:1,mode:execute?'v2_daily_execute':'v2_daily_read_only',businessDate:day,scheduledAt:schedule,observedAt:now.toISOString(),executionEnabled:execute,results};
const output=path.join(root,'outputs',`v2-daily-${day}.json`);fs.writeFileSync(output,JSON.stringify(report,null,2),'utf8');console.log(JSON.stringify(report,null,2));
