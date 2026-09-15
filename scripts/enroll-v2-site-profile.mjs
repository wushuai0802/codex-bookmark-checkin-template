#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {appendFreshProfile} from '../src/v2-profile-registry.mjs';

const root=fileURLToPath(new URL('../',import.meta.url));
const [accountKey,origin,expectedIdentity,provider]=process.argv.slice(2);
if(!accountKey||!origin||!expectedIdentity)throw Error('Usage: enroll-v2-site-profile ACCOUNT_KEY ORIGIN EXPECTED_ID [PROVIDER]');
const file=path.join(root,'outputs','v2-profile-registry.json');
const registry=JSON.parse(fs.readFileSync(file,'utf8'));
const result=appendFreshProfile(registry,{v2Root:root,accountKey,origin,expectedIdentity,provider});
if(!result.reused){const temp=`${file}.${process.pid}.${Date.now()}.tmp`;fs.writeFileSync(temp,JSON.stringify(result.registry,null,2),'utf8');fs.renameSync(temp,file);}
console.log(JSON.stringify({accountKey:result.profile.accountKey,origin:result.profile.origin,expectedIdentity:result.profile.expectedIdentity,state:result.profile.state,reused:result.reused,manualLoginRequired:true},null,2));
