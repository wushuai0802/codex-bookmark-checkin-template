#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import {runIsolatedBrowserTask} from '../src/isolated-browser-worker.mjs';
import {createNewApiExecutionAdapter} from '../src/new-api-execution-adapter.mjs';

const args=new Set(process.argv.slice(2));
const taskFile=process.argv.find((value,index)=>process.argv[index-1]==='--task')??'outputs/canary-api42-20603-2026-09-10.json';
const task=JSON.parse(fs.readFileSync(path.resolve(taskFile),'utf8'));
if(task.executionEnabled!==false) throw Error('canary task must start disabled');
if(!task.preconditions?.profileReady||!task.preconditions?.identityVerified) throw Error('canary preconditions are incomplete');
if(args.has('--execute') && task.preconditions?.v1MustBeStoppedBeforeMutation!==true) throw Error('V1 drain precondition is missing');
const today=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai'}).format(new Date());
if(args.has('--execute') && task.businessDate!==today) throw Error('execute is allowed only for today task');
const root=path.resolve('.');
const req=createRequire(path.join(root,'package.json'));
let chromium;
try { ({chromium}=req('playwright-core')); } catch { throw Error('playwright-core dependency is required'); }
const executablePath=process.env.CHECKIN_CHROME_EXECUTABLE??'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const adapter=createNewApiExecutionAdapter({origin:task.origin,rule:{}});
const result=await runIsolatedBrowserTask({task,adapterDefinition:adapter,profileDir:task.profileDir,dedicatedRoot:root,executablePath,windowMode:'offscreen',launchPersistentContext:(profile,options)=>chromium.launchPersistentContext(profile,options)});
if(args.has('--execute') && result.mutationCount===0 && result.stage==='status') throw Error('execute requested but no mutation was performed');
const report={schemaVersion:1,mode:args.has('--execute')?'canary_execute':'canary_read_only',taskId:task.taskId,businessDate:task.businessDate,origin:task.origin,accountKey:task.accountKey,stage:result.stage,phase:result.task.phase,mutationCount:result.mutationCount,windowMode:result.worker.windowMode,profileBound:result.worker.profileBound,completedAt:result.worker.completedAt};
const output=path.join(root,'outputs',`canary-result-${task.accountKey}-${task.businessDate}.json`);
fs.writeFileSync(output,JSON.stringify(report,null,2),'utf8');
console.log(JSON.stringify(report,null,2));
