#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {analyzeRepository} from '../../tools/module-reachability.mjs';

const layer=file=>{
  if (/^(contracts|task-state|evidence-contract|freshness|display-identity)\.mjs$/.test(file)) return 'core';
  if (/^(bridge|effective-config|desired-plan|v1-.*|monitor-catalog|pt-status)\.mjs$/.test(file)) return 'planning';
  if (/adapter|readonly|new-api|anyrouter/.test(file)) return 'adapter';
  if (/^(task-coordinator|isolated-browser-worker|profile-handoff|v2-profile-registry)\.mjs$/.test(file)) return 'execution';
  if (/^(candidate|dry-|transport-store|worker-gateway)/.test(file)) return 'transport';
  if (file==='dashboard-server.mjs'||file.startsWith('public')) return 'presentation';
  return 'other';
};
const forbidden={adapter:new Set(['presentation','transport']),presentation:new Set(['adapter','execution','transport']),planning:new Set(['execution','transport'])};
const allowedEdges=new Set(['dashboard-server.mjs->worker-gateway.mjs','dashboard-server.mjs->adapter-observations.mjs','dashboard-server.mjs->adapter-registry.mjs']);

// No existing production -> historical import was found. Future exceptions
// must be exact {from,to,reason} entries; a broad directory exception is invalid.
export const historicalImportExceptions=[];

export function readModuleStatuses(markdown){
  const records=new Map();
  for(const match of markdown.matchAll(/^\| `((?:execution|observation)\/(?:src|scripts|public)\/[^`]+)` \| (现役|运维手动|历史审计|待确认) \|/gm)){
    if(records.has(match[1]))throw Error('duplicate module status: '+match[1]);
    records.set(match[1],match[2]);
  }
  if(!records.size)throw Error('module status inventory missing or unreadable');
  return records;
}

export function historicalImportErrors(report,statuses,exceptions=historicalImportExceptions){
  const errors=[],allowed=new Set();
  for(const exception of exceptions){
    if(!exception.from||!exception.to||!exception.reason?.trim()||/[*]/.test(exception.from+exception.to)){
      errors.push('historical import exception requires exact paths and a reason');continue;
    }
    allowed.add(exception.from+'->'+exception.to);
  }
  const active=new Set(report.entrypoints.map(entry=>entry.file));
  // Recompute callers, but keep the reviewed historical target set fixed.
  // Otherwise a new import would relabel its target active and evade the rule.
  for(const record of report.records)if(record.status==='现役')active.add(record.file);
  let changed=true;
  while(changed){changed=false;for(const edge of report.edges)if(active.has(edge.from)&&!active.has(edge.to)){active.add(edge.to);changed=true;}}
  for(const edge of report.edges){
    if(!edge.kind.startsWith('esm-')||!active.has(edge.from)||statuses.get(edge.to)!=='历史审计')continue;
    if(!allowed.has(edge.from+'->'+edge.to))errors.push(`${edge.from}:${edge.line}: active code cannot import historical module ${edge.to}`);
  }
  for(const item of report.unresolved??[]){
    if(!item.kind.startsWith('esm-')||!active.has(item.from))continue;
    for(const target of item.candidates)if(statuses.get(target)==='历史审计'&&!allowed.has(item.from+'->'+target))
      errors.push(`${item.from}:${item.line}: unresolved active import may reference historical module ${target}`);
  }
  return [...new Set(errors)];
}

export function checkStructure({repositoryRoot=fileURLToPath(new URL('../..',import.meta.url)),exceptions=historicalImportExceptions}={}){
  const root=path.join(repositoryRoot,'observation/src'),errors=[];
  const sourceFiles=fs.readdirSync(root).filter(name=>name.endsWith('.mjs'));
  for(const file of sourceFiles){
    const source=fs.readFileSync(path.join(root,file),'utf8'),from=layer(file);
    for(const match of source.matchAll(/from ['\"](\.\/[^'\"]+)['\"]/g)){
      const target=match[1].slice(2),targetFile=target.endsWith('.mjs')?target:`${target}.mjs`;
      if(!fs.existsSync(path.join(root,targetFile)))errors.push(`${file}: missing ${targetFile}`);
      const to=layer(path.basename(targetFile));
      if(forbidden[from]?.has(to)&&!allowedEdges.has(`${file}->${targetFile}`))errors.push(`${file}: ${from} layer cannot import ${to} layer (${targetFile})`);
    }
  }
  try{
    const statuses=readModuleStatuses(fs.readFileSync(path.join(repositoryRoot,'docs/module-status.md'),'utf8'));
    errors.push(...historicalImportErrors(analyzeRepository({root:repositoryRoot}),statuses,exceptions));
  }catch(error){errors.push('module history fence: '+error.message);}
  return {errors,sourceCount:sourceFiles.length};
}

if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
  const result=checkStructure();
  if(result.errors.length){console.error(result.errors.join('\n'));process.exitCode=1;}
  else console.log(`Structure check passed: ${result.sourceCount} source modules; active -> historical import fence passed`);
}
