import fs from 'node:fs';
import path from 'node:path';
import {shortLabel} from './display-identity.mjs';
import {readDashboardRuntime} from './dashboard-runtime.mjs';

function safeOrigin(value){try{const url=new URL(String(value));if(url.protocol!=='https:'||url.username||url.password||url.pathname!=='/'||url.search||url.hash)return null;return url.origin;}catch{return null;}}

export function publicCanaryResults(directory, {useBundle=true} = {}) {
  if(!fs.existsSync(directory)) return [];
  try{if(JSON.parse(fs.readFileSync(path.join(directory,'engine-selection.json'),'utf8')).executionEngine==='v1')return [];}catch{}
  const bundle=useBundle?readDashboardRuntime(directory):null;
  if(bundle) return bundle.results.flatMap(result=>projectResult(result)).sort((a,b)=>String(b.completedAt).localeCompare(String(a.completedAt))).slice(0,400);
  const names=fs.readdirSync(directory), deliveries=new Map();
  for(const name of names.filter(name=>/^notification-notice_[a-f0-9]+\.json$/.test(name)).slice(-100)) {
    try { const file=path.join(directory,name); if(fs.statSync(file).size>65536)continue; const item=JSON.parse(fs.readFileSync(file,'utf8'));
      deliveries.set(item.taskId,{state:['pending','delivered','failed'].includes(item.state)?item.state:'unknown',attempts:Number(item.attempts)||0});
    } catch { /* invalid reports never affect execution */ }
  }
  return names.filter(name=>/^(?:canary-result|canary-observation)-[a-zA-Z0-9._-]+\.json$/.test(name)).sort((a,b)=>fs.statSync(path.join(directory,b)).mtimeMs-fs.statSync(path.join(directory,a)).mtimeMs).slice(0,1000).flatMap(name=>{
    try { const file=path.join(directory,name); if(fs.statSync(file).size>65536)return []; const result=JSON.parse(fs.readFileSync(file,'utf8'));
      return projectResult({...result,notification:deliveries.get(result.taskId)??null});
    } catch { return []; }
  }).sort((a,b)=>String(b.completedAt).localeCompare(String(a.completedAt))).slice(0,400);
}

function projectResult(result) {
      if(!result||!/^task_[a-f0-9]{24}$/.test(result.taskId)||!['canary_read_only','canary_execute'].includes(result.mode))return [];
      return [{taskId:result.taskId,accountKey:shortLabel(result.accountKey),businessDate:shortLabel(result.businessDate),origin:safeOrigin(result.origin),mode:result.mode,
        stage:shortLabel(result.stage),phase:shortLabel(result.phase),mutationCount:Number.isInteger(result.mutationCount)?result.mutationCount:null,
        reason:shortLabel(result.reason,240),evidence:result.evidence&&typeof result.evidence==='object'?{source:shortLabel(result.evidence.source,64),authoritative:result.evidence.authoritative===true,summary:shortLabel(result.evidence.summary,240)}:null,
        completedAt:shortLabel(result.completedAt),notification:result.notification?{state:['pending','delivered','failed'].includes(result.notification.state)?result.notification.state:'unknown',attempts:Number(result.notification.attempts)||0}:null}];
}
