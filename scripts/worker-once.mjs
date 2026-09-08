// Credential arrives via stdin from the local OS-secret-store launcher, never CLI.
import fs from 'node:fs';
import {runTransportWorker} from '../src/dry-transport-worker.mjs';
const [configFile]=process.argv.slice(2);
try{
  const config=JSON.parse(fs.readFileSync(configFile,'utf8'));
  if(config.mode!=='dry_run'||new URL(config.baseUrl).protocol!=='https:')throw Error('unapproved worker deployment');
  const credential=fs.readFileSync(0,'utf8').trim();
  const result=await runTransportWorker({...config,credential});
  fs.writeFileSync(config.statusFile,JSON.stringify({at:new Date().toISOString(),...result},null,2));
  console.log(JSON.stringify(result));
  if(['transport_unavailable','outbox_pending','receipt_review','interrupted_requires_review','binding_conflict'].includes(result.outcome))process.exitCode=2;
}catch{console.error('Worker transport check failed; no site action performed.');process.exitCode=1;}
