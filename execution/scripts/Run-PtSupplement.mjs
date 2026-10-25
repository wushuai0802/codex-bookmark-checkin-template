#!/usr/bin/env node
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {runPtSupplement} from '../src/pt-supplement.mjs';
import {readBookmarkPlan} from '../src/bookmarks.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
try {
  const [origin,catalogFile,catalogHash,mode]=process.argv.slice(2);
  if(mode && !['--execute','--read-only','--verify-before-submit','--recover-login-only'].includes(mode))throw Error('unknown PT supplement mode');
  const workerArgument=process.argv[6];
  if(workerArgument!==undefined&&(!/^--worker-owner=[a-f0-9-]{36}$/.test(workerArgument)||
    workerArgument!=='--worker-owner='+process.env.CHECKIN_PT_CHILD_OWNER))throw Error('PT worker owner mismatch');
  const fallbackAttemptId=process.env.CHECKIN_PT_FALLBACK_ATTEMPT_ID;
  if(fallbackAttemptId!==undefined&&!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(fallbackAttemptId))throw Error('invalid PT fallback attempt');
  const integration=JSON.parse(fs.readFileSync(path.join(root,'data/v2-integration.json'),'utf8'));
  if(integration.executionEngine!=='v1'||!path.isAbsolute(integration.v2ProjectRoot))throw Error('execution lease unavailable');
  const {validateEngineLease}=await import(pathToFileURL(path.join(integration.v2ProjectRoot,'src/legacy-engine.mjs')).href);
  validateEngineLease({root:integration.v2ProjectRoot,legacyRoot:root});
  const {validateCurrentPtCatalog}=await import(pathToFileURL(path.join(integration.v2ProjectRoot,'src/monitor-catalog.mjs')).href);
  const config=JSON.parse(fs.readFileSync(path.join(root,'config/config.json'),'utf8'));
  const validateScope=async()=>{
    const bytes=fs.readFileSync(catalogFile);
    if(crypto.createHash('sha256').update(bytes).digest('hex')!==catalogHash.toLowerCase()){const error=Error('PT catalog changed during execution');error.code='PT_PREFLIGHT';error.preflightReason='catalog_hash_changed';throw error;}
    const catalog=JSON.parse(bytes);
    const currentConfig=JSON.parse(fs.readFileSync(path.join(root,'config/config.json'),'utf8'));
    const plan=catalog.registration==='current-execution-plan'?await readBookmarkPlan(currentConfig.bookmarksPath,currentConfig):undefined;
    return validateCurrentPtCatalog(catalog,{bookmarksPath:currentConfig.bookmarksPath,config:currentConfig,plan});
  };
  const result=await runPtSupplement({root,origin,catalogFile,catalogHash,readOnly:mode==='--read-only',verifyBeforeSubmit:['--verify-before-submit','--recover-login-only'].includes(mode),loginRecoveryOnly:mode==='--recover-login-only',validateScope,
    ...(fallbackAttemptId!==undefined?{fallbackAttemptId}:{})});
  console.log(JSON.stringify(result));
} catch (error) {
  const reasons=new Set(['catalog_stale','catalog_hash_changed','registration_invalid','execution_plan_missing',
    'execution_plan_changed','bookmark_source_changed','site_scope_changed','scope_unavailable']);
  console.error(JSON.stringify({error:['PT_PREFLIGHT','PT_READONLY_UNSAFE'].includes(error.code)?error.code:'PT_SUPPLEMENT_FAILED',
    ...(reasons.has(error.preflightReason)?{reason:error.preflightReason}:{})}));
  process.exitCode=/已有一个签到任务正在(?:运行|启动)/.test(String(error?.message??''))?3:
    ['PT_PREFLIGHT','PT_READONLY_UNSAFE'].includes(error.code)?4:1;
}
