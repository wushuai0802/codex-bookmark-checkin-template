#!/usr/bin/env node
import path from 'node:path';
import {runDaily} from '../src/daily-runner.mjs';
import {loadRuntimeConfig} from '../src/runtime-config.mjs';

try {
  const root=path.resolve('.'),runtime=loadRuntimeConfig(root),nowArg=process.argv.find((value,index)=>process.argv[index-1]==='--now'),now=nowArg?new Date(nowArg):new Date(),accountArg=process.argv.find((value,index)=>process.argv[index-1]==='--account-key');
  const report=await runDaily({root,legacyRoot:runtime.legacyRoot,execute:process.argv.includes('--execute'),accountKey:accountArg?String(accountArg).trim():null,now,notifyAccount:async(file)=>{const {spawn}=await import('node:child_process');await new Promise(resolve=>{const child=spawn(process.execPath,[path.join(root,'scripts','notify-canary-result.mjs'),file],{windowsHide:true,stdio:'ignore'});child.once('exit',resolve);child.once('error',resolve);});}});
  console.log(JSON.stringify(report,null,2));
} catch(error) { console.error(`V2 daily error: ${error.message}`); process.exitCode=1; }
