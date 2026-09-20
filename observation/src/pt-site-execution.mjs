import {spawn} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {loadRuntimeConfig} from './runtime-config.mjs';
import {acquireExecutionLock,releaseExecutionLock} from './execution-lock.mjs';

const statuses=new Set(['signed','already_signed','unknown','login_required','needs_attention','not_available']);
const sources=new Set(['api','page_text','usage_log','pt_page','none']);

export function projectPtSiteResult(value,origin){
  if(value?.origin!==origin||!statuses.has(value.status)||!Number.isFinite(Date.parse(value.observedAt)))throw Error('invalid PT site result');
  const evidence=value.evidence??{};
  const status=value.submissionOutcomeUnknown===true?'needs_attention':
    ['signed','already_signed'].includes(value.status)&&evidence.authoritative!==true?'unknown':value.status;
  return {origin,status,observedAt:new Date(value.observedAt).toISOString(),
    evidence:{source:sources.has(evidence.source)?evidence.source:'none',authoritative:evidence.authoritative===true,
      summary:typeof evidence.summary==='string'?evidence.summary.slice(0,160):''},
    ...(value.submissionOutcomeUnknown===true?{submissionOutcomeUnknown:true}:{})};
}

export async function spawnPtSiteChild({legacyRoot,origin,catalogFile,catalogHash,root,lease,spawnChild=spawn,timeoutMs=600_000}){
  const script=path.join(legacyRoot,'scripts/Run-PtSupplement.mjs');
  if(!fs.existsSync(script))throw Error('PT site execution helper is missing');
  const command=[script,origin,catalogFile,catalogHash];
  const output=await new Promise((resolve,reject)=>{
    const child=spawnChild(process.execPath,command,{cwd:legacyRoot,windowsHide:true,shell:false,
      stdio:['ignore','pipe','pipe'],env:{...process.env,CHECKIN_V2_ENGINE_ROOT:root,CHECKIN_V2_ENGINE_LEASE:lease.owner.nonce}});
    let stdout='',stderr='';
    const timer=setTimeout(()=>{child.kill();reject(Error('PT site execution timed out'));},timeoutMs);
    const append=(current,chunk)=>{
      if(current.length+chunk.length>64_000){child.kill();reject(Error('PT site output exceeded limit'));return current;}
      return current+chunk;
    };
    child.stdout.on('data',chunk=>{stdout=append(stdout,chunk.toString('utf8'));});
    child.stderr.on('data',chunk=>{stderr=append(stderr,chunk.toString('utf8'));});
    child.once('error',error=>{clearTimeout(timer);reject(error);});
    child.once('exit',(code,signal)=>{clearTimeout(timer);if(code===3){reject(Error('V2 runner is already active'));return;}if(signal||code!==0){reject(Error('PT site execution failed'));return;}resolve(stdout);});
  });
  const line=output.trim().split(/\r?\n/).at(-1);
  return projectPtSiteResult(JSON.parse(line),origin);
}

export async function runPtSite({root=path.resolve('.'),origin,catalogFile,catalogHash,
  acquire=acquireExecutionLock,release=releaseExecutionLock,execute=spawnPtSiteChild}={}){
  const runtime=loadRuntimeConfig(root);
  if(runtime.executionEngine!=='v1'||!runtime.legacyRoot)throw Error('PT site fallback requires the execution layer');
  const integration=JSON.parse(fs.readFileSync(path.join(runtime.legacyRoot,'data/v2-integration.json'),'utf8'));
  if(integration.executionEngine!=='v1'||path.resolve(integration.v2ProjectRoot).toLowerCase()!==path.resolve(root).toLowerCase())throw Error('PT site gateway binding mismatch');
  const lease=acquire(root);
  try {
    const value=await execute({legacyRoot:runtime.legacyRoot,origin,catalogFile,catalogHash,root,lease});
    return projectPtSiteResult(value,origin);
  } finally {release(lease);}
}
