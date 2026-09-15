#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import {buildCanaryTask} from '../src/canary-task.mjs';
import {assertPlanHash} from '../src/contracts.mjs';
import {loadRuntimeConfig} from '../src/runtime-config.mjs';
import {executionBindingForOrigin} from '../src/execution-adapter-registry.mjs';

const root=path.resolve('.');
const accountKey=process.argv[2]??'api42-20603';
const businessDate=process.argv[3]??new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai'}).format(new Date());
const registry=JSON.parse(fs.readFileSync(path.join(root,'outputs','v2-profile-registry.json'),'utf8'));
const profile=registry.profiles.find(item=>item.accountKey===accountKey);
if(!profile||profile.state!=='ready') throw Error('profile is not V2-ready');
const identity=String(profile.identity??profile.expectedIdentity);
if(identity!==String(profile.expectedIdentity)) throw Error('profile identity mismatch');
const legacyRoot=loadRuntimeConfig(root).legacyRoot;
if(!legacyRoot)throw Error('legacyRoot is required');
const legacyPlanFile=path.join(legacyRoot,'data','last-valid-bookmark-plan.json');
if(!fs.existsSync(legacyPlanFile)) throw Error('execution plan is missing; canary is refused');
let legacyPlan;
try { legacyPlan=JSON.parse(fs.readFileSync(legacyPlanFile,'utf8')); }
catch(error) { throw Error(`execution plan is invalid: ${error.message}`); }
const legacyConfigFile=path.join(legacyRoot,'config','config.json');
const legacyConfig=fs.existsSync(legacyConfigFile)?JSON.parse(fs.readFileSync(legacyConfigFile,'utf8')):{};
const planHash=assertPlanHash(legacyPlan?.planFingerprint,'execution plan planFingerprint');
const binding=executionBindingForOrigin({origin:profile.origin,config:legacyConfig});
const migrationFile=path.join(root,'outputs',`migration-${accountKey}.json`);
let ownershipState='candidate';
let migrationMeta=null;
if(fs.existsSync(migrationFile)){
  try { migrationMeta=JSON.parse(fs.readFileSync(migrationFile,'utf8')); if(['candidate','active'].includes(migrationMeta.state)) ownershipState=migrationMeta.state; }
  catch { /* the runner will report a corrupt migration record */ }
}
const adapterId=migrationMeta?.adapterId??binding.adapterId;
const adapterRule={...binding.adapterRule,...(migrationMeta?.adapterRule??{}),provider:profile.provider??binding.adapterRule.provider??null};
const output=buildCanaryTask({profile,businessDate,planHash,adapterId,adapterRule,ownershipState});
const file=path.join(root,'outputs',`canary-${accountKey}-${businessDate}.json`);
fs.writeFileSync(file,JSON.stringify(output,null,2),'utf8');
console.log(JSON.stringify({file,taskId:output.taskId,accountKey,businessDate,executionEnabled:false},null,2));
