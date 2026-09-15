#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import {executionBindingForOrigin} from '../src/execution-adapter-registry.mjs';

const accountKey=process.argv[2]??'api42-20603';
const registry=JSON.parse(fs.readFileSync('outputs/v2-profile-registry.json','utf8'));
const profile=registry.profiles.find(item=>item.accountKey===accountKey);
if(!profile||profile.state!=='ready') throw Error('account profile is not ready');
let legacyConfig={};
try {
  const runtimeFile=path.join(path.resolve('.'),'config','runtime.local.json');
  const runtime=fs.existsSync(runtimeFile)?JSON.parse(fs.readFileSync(runtimeFile,'utf8')):{};
  const legacyConfigFile=runtime.legacyRoot?path.join(runtime.legacyRoot,'config','config.json'):null;
  if(legacyConfigFile&&fs.existsSync(legacyConfigFile))legacyConfig=JSON.parse(fs.readFileSync(legacyConfigFile,'utf8'));
} catch { legacyConfig={}; }
const binding=executionBindingForOrigin({origin:profile.origin,config:legacyConfig});
const file=path.join('outputs',`migration-${accountKey}.json`);
if(fs.existsSync(file)) {
  const existing=JSON.parse(fs.readFileSync(file,'utf8'));
  if(existing.state==='active'&&existing.ownership?.current==='v2-worker') {
    console.log(JSON.stringify({file,state:existing.state,accountKey,origin:existing.origin,manualLoginRequired:false,reusedActive:true},null,2));
    process.exit(0);
  }
}
const record={schemaVersion:1,mode:'staged_migration',state:'candidate',accountKey,origin:profile.origin,accountId:profile.identity,
  adapterId:binding.adapterId,adapterRule:{...binding.adapterRule,provider:profile.provider??binding.adapterRule.provider??null},profileDir:profile.profileDir,v1Fallback:{enabled:true,owner:'legacy-checkin'},
  ownership:{current:'legacy-checkin',next:'v2-worker',switchAfter:'authoritative_v2_success',rollback:'legacy-checkin'},
  preconditions:{v1TaskMustBeDrained:true,firstMutationNotPerformed:true,manualLoginRequired:false},stagedAt:new Date().toISOString()};
fs.writeFileSync(file,JSON.stringify(record,null,2),'utf8');
console.log(JSON.stringify({file,state:record.state,accountKey,origin:record.origin,manualLoginRequired:false},null,2));
