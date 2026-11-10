import fs from 'node:fs';
import path from 'node:path';
import {canonicalPtOrigin} from './pt-coordination.generated.mjs';
import {currentHarvestReport,harvestDay} from '../public/harvest-overdue.mjs';
import {projectHarvestWindow,copyHarvestWindow} from '../public/harvest-window.mjs';

const date=value=>/^\d{4}-\d{2}-\d{2}$/.test(value??'')&&Number.isFinite(Date.parse(value))&&new Date(value).toISOString().slice(0,10)===value;
export function summarizeHarvest(report,{now=new Date()}={}){
  if(!currentHarvestReport(report,now.getTime()))throw Error('Harvest observation unavailable');
  const seen=new Set(),observedAt=new Date(report.generatedAt).toISOString();
  const taskStatus=['completed','failed','running'].includes(report.taskCompletion?.status)?report.taskCompletion.status:null;
  const sites=report.sites.map(site=>{
    const origin=canonicalPtOrigin(site?.origin);
    if(!origin||seen.has(origin))throw Error('Harvest observation origin invalid or duplicate');
    seen.add(origin);
    const at=Date.parse(site.observedAt??''),lastReceiptDay=date(site.lastReceiptDay)&&site.lastReceiptDay<=report.businessDate?site.lastReceiptDay:null;
    return {origin,checkinEnabled:typeof site.checkinEnabled==='boolean'?site.checkinEnabled:null,
      hasTodayReceipt:lastReceiptDay===report.businessDate||Number.isFinite(at)&&at<=now.getTime()+60_000&&
        harvestDay(at)===report.businessDate&&['signed','already_signed','failed','not_signed'].includes(site.status),
      lastReceiptDay,taskCompletion:{status:taskStatus},observedAt};
  }).sort((a,b)=>a.origin.localeCompare(b.origin));
  return {schemaVersion:1,source:'harvest-observation-summary',businessDate:report.businessDate,observedAt,
    harvestWindow:projectHarvestWindow(report,now.getTime()),sites};
}
function validSummary(summary,now){
  if(summary?.schemaVersion!==1||summary.source!=='harvest-observation-summary'||!date(summary.businessDate)||
    !Number.isFinite(Date.parse(summary.observedAt))||Date.parse(summary.observedAt)>now.getTime()+60_000||
    harvestDay(summary.observedAt)!==summary.businessDate||summary.businessDate>harvestDay(now)||!Array.isArray(summary.sites))return null;
  const seen=new Set();
  const sites=summary.sites.map(site=>{
    const origin=canonicalPtOrigin(site.origin);
    if(!origin||seen.has(origin)||![true,false,null].includes(site.checkinEnabled)||typeof site.hasTodayReceipt!=='boolean')throw Error('invalid Harvest summary');
    seen.add(origin);
    return {origin,checkinEnabled:site.checkinEnabled,hasTodayReceipt:site.hasTodayReceipt,
      lastReceiptDay:date(site.lastReceiptDay)&&site.lastReceiptDay<=summary.businessDate?site.lastReceiptDay:null,
      taskCompletion:{status:['completed','failed','running'].includes(site.taskCompletion?.status)?site.taskCompletion.status:null},
      observedAt:summary.observedAt};
  });
  return {schemaVersion:1,source:summary.source,businessDate:summary.businessDate,observedAt:summary.observedAt,
    harvestWindow:copyHarvestWindow(summary.harvestWindow),sites};
}
export function latestHarvestObservation(root,{now=new Date()}={}){
  const directory=path.join(root,'outputs');
  if(!fs.existsSync(directory))return null;
  for(const name of fs.readdirSync(directory).filter(name=>/^harvest-observations-\d{4}-\d{2}-\d{2}\.json$/.test(name)).sort().reverse()){
    try{const value=validSummary(JSON.parse(fs.readFileSync(path.join(directory,name),'utf8')),now);if(value)return value;}catch{}
  }
  return null;
}
export function retainHarvestObservation(root,report,{now=new Date()}={}){
  const summary=summarizeHarvest(report,{now}),file=path.join(root,'outputs',`harvest-observations-${summary.businessDate}.json`);
  if(fs.existsSync(file)){
    try{const previous=validSummary(JSON.parse(fs.readFileSync(file,'utf8')),now);
      if(previous&&Date.parse(previous.observedAt)>Date.parse(summary.observedAt))return previous;
    }catch{/* Replace a corrupt summary only with a valid observation. */}
  }
  fs.mkdirSync(path.dirname(file),{recursive:true});
  const temporary=file+'.'+process.pid+'.tmp';
  try{fs.writeFileSync(temporary,JSON.stringify(summary,null,2),{mode:0o600});fs.renameSync(temporary,file);}
  finally{if(fs.existsSync(temporary))fs.unlinkSync(temporary);}
  return summary;
}
