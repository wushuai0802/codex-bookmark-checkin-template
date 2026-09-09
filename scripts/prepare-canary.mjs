#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import {taskIdentity} from '../src/contracts.mjs';

const root=path.resolve('.');
const accountKey=process.argv[2]??'api42-20603';
const businessDate=process.argv[3]??new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai'}).format(new Date(Date.now()+86_400_000));
const registry=JSON.parse(fs.readFileSync(path.join(root,'outputs','v2-profile-registry.json'),'utf8'));
const profile=registry.profiles.find(item=>item.accountKey===accountKey);
if(!profile||profile.state!=='ready') throw Error('profile is not V2-ready');
const identity=String(profile.identity??profile.expectedIdentity);
if(identity!==String(profile.expectedIdentity)) throw Error('profile identity mismatch');
const {taskId,planUnitId}=taskIdentity({businessDate,logicalSiteKey:profile.origin,accountKey,actionType:'checkin',scheduleOccurrence:'daily'});
const output={schemaVersion:1,mode:'candidate_execute_pending',executionEnabled:false,taskId,planUnitId,businessDate,origin:profile.origin,accountKey,accountId:identity,profileDir:profile.profileDir,adapterId:'new-api.execute.v1',executionOwner:'legacy-checkin',v1Fallback:{enabled:true,owner:'legacy-checkin'},preconditions:{profileReady:true,identityVerified:true,v1MustBeStoppedBeforeMutation:true,firstMutationNotPerformed:true}};
const file=path.join(root,'outputs',`canary-${accountKey}-${businessDate}.json`);
fs.writeFileSync(file,JSON.stringify(output,null,2),'utf8');
console.log(JSON.stringify({file,taskId,accountKey,businessDate,executionEnabled:false},null,2));
