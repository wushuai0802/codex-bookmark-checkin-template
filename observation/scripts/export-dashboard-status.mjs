import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {publicCanaryResults} from '../src/canary-report-view.mjs';
import {runtimeOwners} from '../src/dashboard-runtime.mjs';
import {loadRuntimeConfig} from '../src/runtime-config.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const output=path.resolve(process.argv[2]??path.join(root,'outputs','dashboard-runtime.json'));
let executionEngine='v1';try{executionEngine=loadRuntimeConfig(root).executionEngine??'v1';}catch{}
const data={schemaVersion:1,generatedAt:new Date().toISOString(),
  owners:executionEngine==='v1'?[]:runtimeOwners(path.join(root,'outputs')),
  results:executionEngine==='v1'?[]:publicCanaryResults(path.join(root,'outputs'),{useBundle:false})};
fs.writeFileSync(output,JSON.stringify({...data,executionEngine}),'utf8');
console.log(`Dashboard status exported: ${data.owners.length} owners, ${data.results.length} receipts`);
