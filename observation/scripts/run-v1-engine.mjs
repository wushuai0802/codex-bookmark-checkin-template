#!/usr/bin/env node
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {runLegacyEngine,validateEngineLease,publishEngineReport} from '../src/legacy-engine.mjs';
import {loadRuntimeConfig} from '../src/runtime-config.mjs';
const root=fileURLToPath(new URL('../',import.meta.url));
try{
  const args=process.argv.slice(2),values={accountKeys:[],origins:[]};let mode='dry-run',validate=false,legacyRoot=null,refresh=false;
  for(let i=0;i<args.length;i++){
    const a=args[i];
    if(a==='--execute')mode='execute';else if(a==='--scheduled')mode='scheduled';else if(a==='--dry-run')mode='dry-run';
    else if(a==='--account-key')values.accountKeys.push(...String(args[++i]??'').split(','));
    else if(a==='--origin')values.origins.push(...String(args[++i]??'').split(','));
    else if(a==='--notify')values.notify=true;else if(a==='--validate-lease')validate=true;
    else if(a==='--legacy-root')legacyRoot=args[++i];else if(a==='--refresh')refresh=true;
    else throw Error('unknown engine argument');
  }
  if(validate){validateEngineLease({root,legacyRoot});console.log('lease-valid');}
  else if(refresh){const r=publishEngineReport({root,legacyRoot:loadRuntimeConfig(root).legacyRoot});console.log(JSON.stringify({mode:r.mode,counts:r.counts}));}
  else{const r=await runLegacyEngine({root,mode,...values});console.log(JSON.stringify({mode:r.mode,skipped:r.skipped===true,reason:r.reason,runId:r.runId,counts:r.counts,exitCode:r.exitCode,executionComplete:r.executionComplete,businessComplete:r.businessComplete,logFile:r.logFile}));if(r.exitCode!==0)process.exitCode=r.exitCode??1;}
}catch(error){console.error('V2 V1-engine: '+error.message);process.exitCode=1;}
