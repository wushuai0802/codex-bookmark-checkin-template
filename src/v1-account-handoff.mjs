import fs from 'node:fs';
import path from 'node:path';

function safeKey(value) {
  const key=String(value??'').trim();
  if(!/^[A-Za-z0-9._-]{1,80}$/.test(key)) throw Error('account key is invalid');
  return key;
}

function handoffFile(v1Root) {
  const root=path.resolve(String(v1Root??''));
  if(!root||root===path.parse(root).root) throw Error('V1 root is invalid');
  const data=path.join(root,'data'); fs.mkdirSync(data,{recursive:true}); return path.join(data,'v2-account-handoff.json');
}

function read(file) {
  if(!fs.existsSync(file)) return {schemaVersion:1,accounts:[]};
  const value=JSON.parse(fs.readFileSync(file,'utf8'));
  if(value?.schemaVersion!==1||!Array.isArray(value.accounts)) throw Error('invalid V2 account handoff');
  return {schemaVersion:1,accounts:value.accounts.filter(item=>item&&typeof item.accountKey==='string')};
}

function write(file,value) {
  const temp=`${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp,`${JSON.stringify(value,null,2)}\n`,'utf8');
  fs.renameSync(temp,file);
}

function assertV1Idle(v1Root) {
  const root=path.resolve(v1Root), lock=path.join(root,'tmp','run.lock'), stateFile=path.join(root,'data','scheduler-state.json'), heartbeat=path.join(root,'data','scheduler-heartbeat.json');
  if(fs.existsSync(lock)) throw Error('V1 runner lock is active');
  for(const file of [stateFile,heartbeat]) if(fs.existsSync(file)) {
    try { const value=JSON.parse(fs.readFileSync(file,'utf8')); if(String(value.phase)==='running'||String(value.phase)==='running_checkin') throw Error('V1 scheduler is active'); } catch(error) { if(error.message==='V1 scheduler is active') throw error; }
  }
}

export function beginV2AccountHandoff({v1Root,accountKey,origin,expiresAt,now=new Date().toISOString()}={}) {
  assertV1Idle(v1Root); const file=handoffFile(v1Root), key=safeKey(accountKey), site=new URL(String(origin));
  if(site.protocol!=='https:'||site.username||site.password||site.pathname!=='/') throw Error('origin is invalid');
  const expiry=expiresAt??new Date(Date.parse(now)+15*60_000).toISOString(); if(!Number.isFinite(Date.parse(expiry))) throw Error('handoff expiry is invalid');
  const current=read(file), accounts=current.accounts.filter(item=>item.accountKey!==key);
  accounts.push({schemaVersion:1,accountKey:key,origin:site.origin,state:'pending_v2',startedAt:new Date(now).toISOString(),expiresAt: new Date(expiry).toISOString()});
  write(file,{schemaVersion:1,accounts}); return {file,state:'pending_v2',accountKey:key,origin:site.origin,expiresAt:new Date(expiry).toISOString()};
}

export function completeV2AccountHandoff({v1Root,accountKey,now=new Date().toISOString()}={}) {
  const file=handoffFile(v1Root),key=safeKey(accountKey),current=read(file),row=current.accounts.find(item=>item.accountKey===key);
  if(!row||row.state!=='pending_v2') throw Error('pending V2 handoff is missing');
  const accounts=current.accounts.map(item=>item.accountKey===key?{...item,state:'v2_owned',completedAt:new Date(now).toISOString(),expiresAt:null}:item);
  write(file,{schemaVersion:1,accounts}); return {file,state:'v2_owned',accountKey:key};
}

export function rollbackV2AccountHandoff({v1Root,accountKey}={}) {
  const file=handoffFile(v1Root),key=safeKey(accountKey),current=read(file); write(file,{schemaVersion:1,accounts:current.accounts.filter(item=>item.accountKey!==key)}); return {file,state:'legacy-checkin',accountKey:key};
}
