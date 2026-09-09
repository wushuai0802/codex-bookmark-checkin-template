#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const accountKey=process.argv[2]??'api42-20603';
const registry=JSON.parse(fs.readFileSync('outputs/v2-profile-registry.json','utf8'));
const profile=registry.profiles.find(item=>item.accountKey===accountKey);
if(!profile||profile.state!=='ready') throw Error('account profile is not ready');
const record={schemaVersion:1,mode:'staged_migration',state:'candidate',accountKey,origin:profile.origin,accountId:profile.identity,
  adapterId:'new-api.execute.v1',profileDir:profile.profileDir,v1Fallback:{enabled:true,owner:'legacy-checkin'},
  ownership:{current:'legacy-checkin',next:'v2-worker',switchAfter:'authoritative_v2_success',rollback:'legacy-checkin'},
  preconditions:{v1TaskMustBeDrained:true,firstMutationNotPerformed:true,manualLoginRequired:false},stagedAt:new Date().toISOString()};
const file=path.join('outputs',`migration-${accountKey}.json`); fs.writeFileSync(file,JSON.stringify(record,null,2),'utf8');
console.log(JSON.stringify({file,state:record.state,accountKey,origin:record.origin,manualLoginRequired:false},null,2));
