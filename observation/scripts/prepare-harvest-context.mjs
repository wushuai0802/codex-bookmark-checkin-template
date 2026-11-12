import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {retainHarvestObservation,latestHarvestObservation} from '../src/harvest-observations.mjs';

// Called after a bounded observer probe, even when it failed. No network or browser.
const root=fileURLToPath(new URL('../',import.meta.url)),args=process.argv.slice(2);
const value=key=>args[args.indexOf(key)+1];
try{
  let report=null,observation=null;
  if(args.includes('--report-file'))try{
    const input=JSON.parse(fs.readFileSync(value('--report-file'),'utf8'));
    observation=retainHarvestObservation(root,input);
    // The dispatch envelope is temporary. It carries only allowlisted facts,
    // never Harvest's database owner IDs, names, or response text.
    report={schemaVersion:1,source:'harvest',businessDate:input.businessDate,generatedAt:input.generatedAt,
      checkinInventoryComplete:input.checkinInventoryComplete===true,taskCompletion:input.taskCompletion,taskSchedule:input.taskSchedule,
      sites:input.sites.map(site=>({origin:site.origin,checkinEnabled:site.checkinEnabled,status:site.status,
        observedAt:site.observedAt,lastReceiptDay:site.lastReceiptDay,siteCondition:site.siteCondition,failureCode:site.failureCode,
        evidence:{source:'harvest',authoritative:site.evidence?.authoritative===true}}))};
  }catch{/* Invalid observations never replace the last valid day's summary. */}
  observation??=latestHarvestObservation(root);
  const out=path.resolve(value('--out'));
  fs.writeFileSync(out,JSON.stringify({schemaVersion:1,source:'harvest-context',report,observation}),{mode:0o600});
  console.log(JSON.stringify({available:Boolean(report),knownSites:observation?.sites.length??0}));
}catch{console.error('Harvest context preparation failed');process.exitCode=1;}
