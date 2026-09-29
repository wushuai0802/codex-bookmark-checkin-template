#!/usr/bin/env node
import {fileURLToPath} from 'node:url';
import fs from 'node:fs';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {planHarvestFallback,runHarvestFallback,loadHarvestFallbackInputs,pendingHarvestFallbackAttempts} from '../src/harvest-fallback.mjs';
import {loadRuntimeConfig} from '../src/runtime-config.mjs';
const root=fileURLToPath(new URL('../',import.meta.url)),args=process.argv.slice(2);
const value=name=>{const index=args.indexOf(name);return index<0?null:args[index+1];};
function liveHarvestProbe(target,database){
  if(!/^[A-Za-z0-9._@-]{1,120}$/.test(target??'')||
     !/^[/]volume3[/]docker[/][A-Za-z0-9._/-]{1,200}$/.test(database??'')||
     database.split('/').includes('..'))throw Error('Harvest probe target or path is invalid');
  const source=fs.readFileSync(new URL('./harvest-observe.py',import.meta.url),'utf8');
  return ()=>{
    const child=spawnSync('ssh',['-o','BatchMode=yes','-o','ConnectTimeout=15',target,
      'sudo -n python3 - '+database],{input:source,encoding:'utf8',timeout:25_000,maxBuffer:2_000_000,windowsHide:true});
    if(child.error||child.status!==0||!child.stdout)throw Error('live Harvest probe unavailable');
    return JSON.parse(child.stdout);
  };
}
try{
  const reportFile=value('--report-file'),catalogFile=value('--catalog-file'),execute=args.includes('--apply');
  if(!reportFile||!catalogFile)throw Error('provide --report-file and --catalog-file');
  const recoveredOrigin=value('--login-recovered-origin');
  const recoveredAccount=value('--login-recovered-account')??'site-default';
  let recoveredAtByAccount={};
  if(recoveredOrigin){
    if(!execute)throw Error('login recovery requires --apply');
    const parsed=new URL(recoveredOrigin);
    if(parsed.protocol!=='https:'||parsed.origin!==recoveredOrigin||parsed.username||parsed.password)
      throw Error('login recovery requires one exact HTTPS origin');
    if(!/^[A-Za-z0-9._-]{1,80}$/.test(recoveredAccount))throw Error('invalid login recovery account key');
    recoveredAtByAccount={
      [`${recoveredOrigin}#account=${encodeURIComponent(recoveredAccount)}`]:new Date().toISOString()
    };
  }else if(args.includes('--login-recovered-account'))throw Error('login recovery account needs an origin');
  if(execute){
    if(!value('--harvest-ssh-target')||!value('--harvest-db-path'))
      throw Error('live Harvest probe required before fallback writes');
    for(const [file,flag] of [[reportFile,'--report-sha256'],[catalogFile,'--catalog-sha256']]){
      const expected=value(flag);
      if(!/^[a-f0-9]{64}$/i.test(expected??''))throw Error(`missing ${flag}`);
      const actual=crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
      if(actual.toLowerCase()!==expected.toLowerCase())throw Error('Harvest input changed after scheduling');
    }
  }
  const inputs=loadHarvestFallbackInputs({root,reportFile,catalogFile});
  const fallbackOnlyEnabled=loadRuntimeConfig(root).ptFallbackOnlyEnabled;
  const result=execute?await runHarvestFallback({root,...inputs,execute:true,catalogFile,catalogHash:value('--catalog-sha256'),fallbackOnlyEnabled,recoveredAtByAccount,
    refreshHarvest:liveHarvestProbe(value('--harvest-ssh-target'),value('--harvest-db-path'))}):planHarvestFallback({...inputs,fallbackOnlyEnabled});
  const newAttempts=execute?null:pendingHarvestFallbackAttempts(root,result).length;
  const assessmentStates=Object.fromEntries([...new Set(result.assessments.map(item=>item.state))].sort().map(state=>[state,result.assessments.filter(item=>item.state===state).length]));
  const blockedReasons=Object.fromEntries([...new Set(result.blocked.map(item=>item.reason))].sort().map(reason=>[reason,result.blocked.filter(item=>item.reason===reason).length]));
  console.log(JSON.stringify({businessDate:result.businessDate,mode:execute?'executed':'preview',registeredCount:result.registeredCount,fallbackOnlyCount:result.fallbackOnlyCount,
    observedSuccess:result.observedSuccess,eligibleCount:result.eligible.length,newAttempts,blockedCount:result.blocked.length,assessmentStates,blockedReasons,outcomes:result.outcomes??[]}));
}catch(error){console.error(`Harvest fallback: ${error.message}`);process.exitCode=1;}
