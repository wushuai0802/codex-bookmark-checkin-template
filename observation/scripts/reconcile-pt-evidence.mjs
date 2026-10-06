import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {repairPtEvidence,rebuildDashboardAfterEvidence} from '../src/pt-evidence-repair.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
try{
  const [catalogFile,maxSites='1']=process.argv.slice(2);
  if(!catalogFile)throw Error('PT catalog required');
  const result=await repairPtEvidence({root,catalogFile:path.resolve(catalogFile),maxSites:Number(maxSites),
    rebuild:({now})=>rebuildDashboardAfterEvidence({root,catalogFile:path.resolve(catalogFile),now})});
  console.log(JSON.stringify(result));
  if(result.rebuild?.rebuilt===false&&result.rebuild.reason==='dashboard_rebuild_failed')process.exitCode=1;
}catch(error){console.error('PT evidence readback deferred: '+error.message);process.exitCode=/already active/.test(error.message)?0:1;}
