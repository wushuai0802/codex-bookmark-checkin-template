import fs from 'node:fs';
import {evaluateCanaryGate} from '../src/canary-gate.mjs';
const snapshot=JSON.parse(fs.readFileSync(process.argv[2]??'outputs/shadow-beta-snapshot.json','utf8'));
const acceptance=JSON.parse(fs.readFileSync(process.argv[3]??'../ops/checkin-fabric-v2-shadow-sync/outputs/shadow-acceptance.json','utf8'));
const worker={profileIsolation:true,executionModes:['dry_run'],allowedOrigins:snapshot.tasks.map(task=>task.origin)};
const task=snapshot.tasks.find(item=>!['signed','already_signed','not_available'].includes(item.observedStatus))??snapshot.tasks[0];
console.log(JSON.stringify(evaluateCanaryGate({snapshot,acceptance,worker,taskId:task?.taskId}),null,2));
