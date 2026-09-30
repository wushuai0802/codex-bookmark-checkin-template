#!/usr/bin/env node
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {runPtSite} from '../src/pt-site-execution.mjs';
import {recordPtVerification} from '../src/pt-verification.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
try{
  const [origin,catalogFile,catalogHash]=process.argv.slice(2);
  if(!origin||!catalogFile||!/^[a-f0-9]{64}$/i.test(catalogHash??''))throw Error('provide exact origin, catalog and SHA-256');
  const result=await runPtSite({root,origin,catalogFile,catalogHash,readOnly:true});
  const saved=recordPtVerification(root,result);
  console.log(JSON.stringify({origin,status:result.status,authoritative:result.evidence.authoritative,
    failureCode:result.failureCode,summary:result.evidence.summary,recorded:saved.recorded}));
}catch(error){console.error('PT verification: '+error.message);process.exitCode=1;}
