#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import {chromium} from 'playwright-core';
import {assertPlanHash} from '../src/contracts.mjs';
import {loadRuntimeConfig} from '../src/runtime-config.mjs';
import {verifyProfile} from '../src/profile-verifier.mjs';

const root=path.resolve('.'),accountKey=process.argv[2];if(!/^[A-Za-z0-9._-]{1,80}$/.test(String(accountKey??'')))throw Error('provide account key');
const file=path.join(root,'outputs','v2-profile-registry.json'),registry=JSON.parse(fs.readFileSync(file,'utf8')),index=registry.profiles.findIndex(item=>item.accountKey===accountKey);if(index<0)throw Error('profile not registered');
const runtime=loadRuntimeConfig(root);if(!runtime.chromeExecutable)throw Error('chromeExecutable is required');if(!runtime.legacyRoot)throw Error('legacyRoot is required');
const planFile=path.join(runtime.legacyRoot,'data','last-valid-bookmark-plan.json');if(!fs.existsSync(planFile))throw Error('execution plan is missing; profile verification is refused');
let plan;try { plan=JSON.parse(fs.readFileSync(planFile,'utf8')); } catch(error) { throw Error(`execution plan is invalid: ${error.message}`); }
const verified=await verifyProfile({profile:registry.profiles[index],root,planHash:assertPlanHash(plan?.planFingerprint,'profile verification planHash'),executablePath:runtime.chromeExecutable,launchPersistentContext:(profile,options)=>chromium.launchPersistentContext(profile,options)});
registry.profiles[index]=verified;const temp=`${file}.${process.pid}.tmp`;fs.writeFileSync(temp,JSON.stringify(registry,null,2),'utf8');fs.renameSync(temp,file);console.log(JSON.stringify({accountKey,state:verified.state,identity:verified.identity??null,statusVerified:verified.statusVerified??null},null,2));
