import fs from 'node:fs';
import path from 'node:path';
import {shortLabel} from './display-identity.mjs';

export function publicCanaryResults(directory) {
  if(!fs.existsSync(directory)) return [];
  const names=fs.readdirSync(directory), deliveries=new Map();
  for(const name of names.filter(name=>/^notification-notice_[a-f0-9]+\.json$/.test(name)).slice(-100)) {
    try { const file=path.join(directory,name); if(fs.statSync(file).size>65536)continue; const item=JSON.parse(fs.readFileSync(file,'utf8'));
      deliveries.set(item.taskId,{state:['pending','delivered','failed'].includes(item.state)?item.state:'unknown',attempts:Number(item.attempts)||0});
    } catch { /* invalid reports never affect execution */ }
  }
  return names.filter(name=>/^canary-result-[a-zA-Z0-9._-]+\.json$/.test(name)).slice(-100).flatMap(name=>{
    try { const file=path.join(directory,name); if(fs.statSync(file).size>65536)return []; const result=JSON.parse(fs.readFileSync(file,'utf8'));
      if(!/^task_[a-f0-9]{24}$/.test(result.taskId)||!['canary_read_only','canary_execute'].includes(result.mode))return [];
      return [{taskId:result.taskId,accountKey:shortLabel(result.accountKey),businessDate:shortLabel(result.businessDate),mode:result.mode,
        stage:shortLabel(result.stage),phase:shortLabel(result.phase),mutationCount:Number.isInteger(result.mutationCount)?result.mutationCount:null,
        completedAt:shortLabel(result.completedAt),notification:deliveries.get(result.taskId)??null}];
    } catch { return []; }
  }).sort((a,b)=>String(b.completedAt).localeCompare(String(a.completedAt))).slice(0,30);
}
