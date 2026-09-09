import fs from 'node:fs';
import {evaluateCanaryGate} from '../src/canary-gate.mjs';
const snapshotPath = process.argv[2] ?? process.env.CHECKIN_SHADOW_SNAPSHOT ?? 'outputs/shadow-beta-snapshot.json';
// The ops workspace is a sibling of `projects`, not a child of this repo.
const acceptancePath = process.argv[3] ?? process.env.CHECKIN_SHADOW_ACCEPTANCE
  ?? '../../ops/checkin-fabric-v2-shadow-sync/outputs/shadow-acceptance.json';
const snapshot=JSON.parse(fs.readFileSync(snapshotPath,'utf8'));
const acceptance=JSON.parse(fs.readFileSync(acceptancePath,'utf8'));
const worker={profileIsolation:true,executionModes:['dry_run'],allowedOrigins:snapshot.tasks.map(task=>task.origin)};
const task=snapshot.tasks.find(item=>!['signed','already_signed','not_available'].includes(item.observedStatus))??snapshot.tasks[0];
console.log(JSON.stringify(evaluateCanaryGate({snapshot,acceptance,worker,taskId:task?.taskId}),null,2));
