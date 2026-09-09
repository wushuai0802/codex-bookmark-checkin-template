#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import {enrollFreshProfile} from '../src/v2-profile-registry.mjs';

const input=process.argv[2]??'outputs/v1-runtime-import.json';
const output=process.argv[3]??'outputs/v2-profile-registry.json';
const imported=JSON.parse(fs.readFileSync(input,'utf8'));
const root=path.resolve('.');
const profiles=(imported.accounts??[]).map(account=>enrollFreshProfile({v2Root:root,accountKey:account.accountKey,origin:account.origin,expectedIdentity:account.identity.userId,provider:account.identity.provider}));
fs.writeFileSync(output,JSON.stringify({schemaVersion:1,mode:'fresh_v2_profiles',executionEnabled:false,profiles},null,2),'utf8');
console.log(`Fresh V2 profiles enrolled: ${profiles.length}`);
