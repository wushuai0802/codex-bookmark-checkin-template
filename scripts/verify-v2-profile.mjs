#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import {chromium} from 'playwright-core';
import {loadRuntimeConfig} from '../src/runtime-config.mjs';
import {verifyProfile} from '../src/profile-verifier.mjs';

const root=path.resolve('.'),accountKey=process.argv[2];if(!/^[A-Za-z0-9._-]{1,80}$/.test(String(accountKey??'')))throw Error('provide account key');
const file=path.join(root,'outputs','v2-profile-registry.json'),registry=JSON.parse(fs.readFileSync(file,'utf8')),index=registry.profiles.findIndex(item=>item.accountKey===accountKey);if(index<0)throw Error('profile not registered');
const runtime=loadRuntimeConfig(root);if(!runtime.chromeExecutable)throw Error('chromeExecutable is required');
const planFile=path.join(runtime.legacyRoot??'', 'data','last-valid-bookmark-plan.json'),plan=fs.existsSync(planFile)?JSON.parse(fs.readFileSync(planFile,'utf8')):{};
const verified=await verifyProfile({profile:registry.profiles[index],root,planHash:/^[a-f0-9]{64}$/.test(String(plan.planFingerprint??''))?plan.planFingerprint:'0'.repeat(64),executablePath:runtime.chromeExecutable,launchPersistentContext:(profile,options)=>chromium.launchPersistentContext(profile,options)});
registry.profiles[index]=verified;const temp=`${file}.${process.pid}.tmp`;fs.writeFileSync(temp,JSON.stringify(registry,null,2),'utf8');fs.renameSync(temp,file);console.log(JSON.stringify({accountKey,state:verified.state,identity:verified.identity??null,statusVerified:verified.statusVerified??null},null,2));
