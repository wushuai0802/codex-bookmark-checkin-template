#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {runCanary} from '../src/canary-runner.mjs';
import {assertPlanHash} from '../src/contracts.mjs';
import {loadRuntimeConfig} from '../src/runtime-config.mjs';

try {
  const taskFile=process.argv.find((value,index)=>process.argv[index-1]==='--task');
  if(!taskFile)throw Error('provide --task with an explicitly prepared current-day task');
  const task=JSON.parse(fs.readFileSync(path.resolve(taskFile),'utf8'));
  if(process.argv.includes('--execute')){
    const runtime=loadRuntimeConfig(path.resolve('.'));if(!runtime.legacyRoot)throw Error('legacyRoot is required');
    const planFile=path.join(runtime.legacyRoot,'data','last-valid-bookmark-plan.json');if(!fs.existsSync(planFile))throw Error('execution plan is missing; canary is refused');
    const plan=JSON.parse(fs.readFileSync(planFile,'utf8'));if(assertPlanHash(plan?.planFingerprint,'execution plan planFingerprint')!==task.planHash)throw Error('canary task plan does not match the current execution plan');
  }
  const report=await runCanary({task,execute:process.argv.includes('--execute')});
  console.log(JSON.stringify(report,null,2));
  if(process.argv.includes('--execute')&&report.output){
    const child=spawn(process.execPath,[path.join(path.resolve('.'),'scripts','notify-canary-result.mjs'),report.output],{windowsHide:true,stdio:'ignore'});
    const code=await new Promise((resolve,reject)=>{child.once('exit',resolve);child.once('error',reject);});
    if(code!==0)process.exitCode=2;
  }
} catch(error) {
  console.error(`V2 canary error: ${error.message}`);
  process.exitCode=1;
}
