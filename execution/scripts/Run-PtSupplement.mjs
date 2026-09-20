#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {runPtSupplement} from '../src/pt-supplement.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
try {
  const [origin,catalogFile,catalogHash]=process.argv.slice(2);
  const integration=JSON.parse(fs.readFileSync(path.join(root,'data/v2-integration.json'),'utf8'));
  if(integration.executionEngine!=='v1'||!path.isAbsolute(integration.v2ProjectRoot))throw Error('execution lease unavailable');
  const {validateEngineLease}=await import(pathToFileURL(path.join(integration.v2ProjectRoot,'src/legacy-engine.mjs')).href);
  validateEngineLease({root:integration.v2ProjectRoot,legacyRoot:root});
  const result=await runPtSupplement({root,origin,catalogFile,catalogHash});
  console.log(JSON.stringify(result));
} catch (error) {
  console.error('PT supplement could not establish a verified result');
  process.exitCode=/已有一个签到任务正在(?:运行|启动)/.test(String(error?.message??''))?3:1;
}
