#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import {buildCanaryTask} from '../src/canary-task.mjs';
import {loadRuntimeConfig} from '../src/runtime-config.mjs';

const root=path.resolve('.');
const accountKey=process.argv[2]??'api42-20603';
const businessDate=process.argv[3]??new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai'}).format(new Date(Date.now()+86_400_000));
const registry=JSON.parse(fs.readFileSync(path.join(root,'outputs','v2-profile-registry.json'),'utf8'));
const profile=registry.profiles.find(item=>item.accountKey===accountKey);
if(!profile||profile.state!=='ready') throw Error('profile is not V2-ready');
const identity=String(profile.identity??profile.expectedIdentity);
if(identity!==String(profile.expectedIdentity)) throw Error('profile identity mismatch');
const legacyRoot=loadRuntimeConfig(root).legacyRoot;
if(!legacyRoot)throw Error('legacyRoot is required');
const legacyPlanFile=path.join(legacyRoot,'data','last-valid-bookmark-plan.json');
const legacyPlan=fs.existsSync(legacyPlanFile)?JSON.parse(fs.readFileSync(legacyPlanFile,'utf8')):null;
const legacyConfigFile=path.join(legacyRoot,'config','config.json');
const legacyConfig=fs.existsSync(legacyConfigFile)?JSON.parse(fs.readFileSync(legacyConfigFile,'utf8')):{};
const planHash=/^[a-f0-9]{64}$/.test(String(legacyPlan?.planFingerprint??''))?legacyPlan.planFingerprint
  :'0'.repeat(64);
const configuredRule=legacyConfig.newApiSignInRules?.[profile.origin]??{};
const adapterRule={selfPath:configuredRule.selfPath??'/api/user/self',statusPath:configuredRule.statusPath??'/api/user/checkin',signInPath:configuredRule.signInPath??'/api/user/checkin',rewardAmount:configuredRule.rewardAmount??null};
const output=buildCanaryTask({profile,businessDate,planHash,adapterRule});
const file=path.join(root,'outputs',`canary-${accountKey}-${businessDate}.json`);
fs.writeFileSync(file,JSON.stringify(output,null,2),'utf8');
console.log(JSON.stringify({file,taskId:output.taskId,accountKey,businessDate,executionEnabled:false},null,2));
