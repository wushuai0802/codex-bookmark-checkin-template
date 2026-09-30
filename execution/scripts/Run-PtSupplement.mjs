#!/usr/bin/env node
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {runPtSupplement} from '../src/pt-supplement.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
try {
  const [origin,catalogFile,catalogHash,mode]=process.argv.slice(2);
  if(mode && mode!=='--read-only')throw Error('unknown PT supplement mode');
  const integration=JSON.parse(fs.readFileSync(path.join(root,'data/v2-integration.json'),'utf8'));
  if(integration.executionEngine!=='v1'||!path.isAbsolute(integration.v2ProjectRoot))throw Error('execution lease unavailable');
  const {validateEngineLease}=await import(pathToFileURL(path.join(integration.v2ProjectRoot,'src/legacy-engine.mjs')).href);
  validateEngineLease({root:integration.v2ProjectRoot,legacyRoot:root});
  const {validateCurrentPtCatalog}=await import(pathToFileURL(path.join(integration.v2ProjectRoot,'src/monitor-catalog.mjs')).href);
  const config=JSON.parse(fs.readFileSync(path.join(root,'config/config.json'),'utf8'));
  const validateScope=()=>{
    const bytes=fs.readFileSync(catalogFile);
    if(crypto.createHash('sha256').update(bytes).digest('hex')!==catalogHash.toLowerCase()){const error=Error('PT catalog changed during execution');error.code='PT_PREFLIGHT';throw error;}
    return validateCurrentPtCatalog(JSON.parse(bytes),{bookmarksPath:config.bookmarksPath});
  };
  const result=await runPtSupplement({root,origin,catalogFile,catalogHash,readOnly:mode==='--read-only',validateScope});
  console.log(JSON.stringify(result));
} catch (error) {
  console.error('PT supplement could not establish a verified result');
  process.exitCode=/已有一个签到任务正在(?:运行|启动)/.test(String(error?.message??''))?3:
    ['PT_PREFLIGHT','PT_READONLY_UNSAFE'].includes(error.code)?4:1;
}
