#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import {runCanary} from '../src/canary-runner.mjs';

try {
  const taskFile=process.argv.find((value,index)=>process.argv[index-1]==='--task')??'outputs/canary-api42-20603-2026-09-10.json';
  const task=JSON.parse(fs.readFileSync(path.resolve(taskFile),'utf8'));
  const report=await runCanary({task,execute:process.argv.includes('--execute')});
  console.log(JSON.stringify(report,null,2));
} catch(error) {
  console.error(`V2 canary error: ${error.message}`);
  process.exitCode=1;
}
