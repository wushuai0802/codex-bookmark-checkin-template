import fs from 'node:fs';
import path from 'node:path';
import {accountRef} from './contracts.mjs';

export function runtimeOwners(directory) {
  try{if(JSON.parse(fs.readFileSync(path.join(directory,'engine-selection.json'),'utf8')).executionEngine==='v1')return [];}catch{}
  return fs.readdirSync(directory).filter(name => /^migration-[a-z0-9-]+\.json$/.test(name)).flatMap(name => {
    try {
      const item=JSON.parse(fs.readFileSync(path.join(directory,name),'utf8'));
      const origin=new URL(item.origin);
      if(origin.protocol!=='https:'||origin.username||origin.password||origin.pathname!=='/'||origin.search||origin.hash) return [];
      if(!/^[a-z0-9-]+$/.test(item.accountKey)||item.state!=='active'||item.ownership?.current!=='v2-worker') return [];
      return [{origin:origin.origin,accountRef:accountRef(item.accountKey),owner:'v2-worker',switchedAt:item.ownership.switchedAt??null}];
    } catch { return []; }
  });
}

export function readDashboardRuntime(directory) {
  try {
    const file=path.join(directory,'dashboard-runtime.json');
    if(fs.statSync(file).size>4_000_000) return null;
    const value=JSON.parse(fs.readFileSync(file,'utf8'));
    if(value.schemaVersion!==1||!Number.isFinite(Date.parse(value.generatedAt))||!Array.isArray(value.owners)||!Array.isArray(value.results)) return null;
    if(value.executionEngine==='v1')return {...value,owners:[],results:[]};
    return {...value,owners:value.owners.filter(item=>item.owner==='v2-worker'&&/^acct_[a-f0-9]{16}$/.test(item.accountRef)&&typeof item.origin==='string')};
  } catch { return null; }
}
