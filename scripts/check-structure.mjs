#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const root=path.resolve('src');
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
const errors=[];
for(const file of fs.readdirSync(root).filter(name=>name.endsWith('.mjs'))){
  const source=fs.readFileSync(path.join(root,file),'utf8'),from=layer(file);
  for(const match of source.matchAll(/from ['\"](\.\/[^'\"]+)['\"]/g)){
    const target=match[1].slice(2),targetFile=target.endsWith('.mjs')?target:`${target}.mjs`;
    if(!fs.existsSync(path.join(root,targetFile))) errors.push(`${file}: missing ${targetFile}`);
    const to=layer(path.basename(targetFile));
    if(forbidden[from]?.has(to) && !allowedEdges.has(`${file}->${targetFile}`)) errors.push(`${file}: ${from} layer cannot import ${to} layer (${targetFile})`);
  }
}
if(errors.length){console.error(errors.join('\n'));process.exitCode=1;}else console.log(`Structure check passed: ${fs.readdirSync(root).filter(name=>name.endsWith('.mjs')).length} source modules`);
