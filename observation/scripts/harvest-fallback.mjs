#!/usr/bin/env node
import {fileURLToPath} from 'node:url';
import fs from 'node:fs';
import crypto from 'node:crypto';
import {planHarvestFallback,runHarvestFallback,loadHarvestFallbackInputs,pendingHarvestFallbackAttempts} from '../src/harvest-fallback.mjs';
import {loadRuntimeConfig} from '../src/runtime-config.mjs';
const root=fileURLToPath(new URL('../',import.meta.url)),args=process.argv.slice(2);
const value=name=>{const index=args.indexOf(name);return index<0?null:args[index+1];};
try{
  const reportFile=value('--report-file'),catalogFile=value('--catalog-file'),execute=args.includes('--apply');
  if(!reportFile||!catalogFile)throw Error('provide --report-file and --catalog-file');
  if(execute){
    for(const [file,flag] of [[reportFile,'--report-sha256'],[catalogFile,'--catalog-sha256']]){
      const expected=value(flag);
      if(!/^[a-f0-9]{64}$/i.test(expected??''))throw Error(`missing ${flag}`);
      const actual=crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
      if(actual.toLowerCase()!==expected.toLowerCase())throw Error('Harvest input changed after scheduling');
    }
  }
  const inputs=loadHarvestFallbackInputs({root,reportFile,catalogFile});
  const fallbackOnlyEnabled=loadRuntimeConfig(root).ptFallbackOnlyEnabled;
  const result=execute?await runHarvestFallback({root,...inputs,execute:true,catalogFile,catalogHash:value('--catalog-sha256'),fallbackOnlyEnabled}):planHarvestFallback({...inputs,fallbackOnlyEnabled});
  const newAttempts=execute?null:pendingHarvestFallbackAttempts(root,result).length;
  const assessmentStates=Object.fromEntries([...new Set(result.assessments.map(item=>item.state))].sort().map(state=>[state,result.assessments.filter(item=>item.state===state).length]));
  const blockedReasons=Object.fromEntries([...new Set(result.blocked.map(item=>item.reason))].sort().map(reason=>[reason,result.blocked.filter(item=>item.reason===reason).length]));
  console.log(JSON.stringify({businessDate:result.businessDate,mode:execute?'executed':'preview',registeredCount:result.registeredCount,fallbackOnlyCount:result.fallbackOnlyCount,
    observedSuccess:result.observedSuccess,eligibleCount:result.eligible.length,newAttempts,blockedCount:result.blocked.length,assessmentStates,blockedReasons,outcomes:result.outcomes??[]}));
}catch(error){console.error(`Harvest fallback: ${error.message}`);process.exitCode=1;}
