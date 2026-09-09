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

function processIsAlive(pid) {
  if(!Number.isSafeInteger(pid)||pid<=0)return null;
  try { process.kill(pid,0); return true; }
  catch(error) { if(error?.code==='ESRCH')return false; return true; }
}

function lockIsActive(file) {
  let owner;
  try { owner=JSON.parse(fs.readFileSync(file,'utf8')); }
  catch { return true; }
  const alive=processIsAlive(Number(owner?.pid));
  return alive!==false;
}

function sleepSync(milliseconds) {
  const buffer=new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(buffer),0,0,milliseconds);
}

function withHandoffLock(file,action) {
  const lock=`${file}.lock`,deadline=Date.now()+5_000;
  fs.mkdirSync(path.dirname(file),{recursive:true});
  while(true){
    try { fs.mkdirSync(lock); break; }
    catch(error) {
      if(error?.code!=='EEXIST')throw error;
      const stat=fs.statSync(lock,{throwIfNoEntry:false});
      if(!stat||Date.now()-stat.mtimeMs>15_000){fs.rmSync(lock,{recursive:true,force:true});continue;}
      if(Date.now()>=deadline)throw Error('V2 account handoff is busy');
      sleepSync(25);
    }
  }
  try { return action(); }
  finally { fs.rmSync(lock,{recursive:true,force:true}); }
}

export function assertV1Idle(v1Root) {
  const root=path.resolve(v1Root), lock=path.join(root,'tmp','run.lock'), stateFile=path.join(root,'data','scheduler-state.json'), heartbeat=path.join(root,'data','scheduler-heartbeat.json');
  if(fs.existsSync(lock)&&lockIsActive(lock)) throw Error('V1 runner lock is active');
  for(const file of [stateFile,heartbeat]) if(fs.existsSync(file)) {
    try { const value=JSON.parse(fs.readFileSync(file,'utf8')); if(String(value.phase)==='running'||String(value.phase)==='running_checkin') throw Error('V1 scheduler is active'); } catch(error) { if(error.message==='V1 scheduler is active') throw error; throw Error('V1 scheduler state is unreadable'); }
  }
}

export function beginV2AccountHandoff({v1Root,accountKey,origin,expiresAt,now=new Date().toISOString()}={}) {
  assertV1Idle(v1Root); const file=handoffFile(v1Root), key=safeKey(accountKey), site=new URL(String(origin));
  if(site.protocol!=='https:'||site.username||site.password||site.pathname!=='/') throw Error('origin is invalid');
  const expiry=expiresAt??new Date(Date.parse(now)+15*60_000).toISOString(); if(!Number.isFinite(Date.parse(expiry))||Date.parse(expiry)<=Date.parse(now)) throw Error('handoff expiry is invalid');
  return withHandoffLock(file,()=>{ const current=read(file), accounts=current.accounts.filter(item=>item.accountKey!==key);
    accounts.push({schemaVersion:1,accountKey:key,origin:site.origin,state:'pending_v2',startedAt:new Date(now).toISOString(),expiresAt: new Date(expiry).toISOString()});
    write(file,{schemaVersion:1,accounts}); return {file,state:'pending_v2',accountKey:key,origin:site.origin,expiresAt:new Date(expiry).toISOString()}; });
}

export function completeV2AccountHandoff({v1Root,accountKey,now=new Date().toISOString()}={}) {
  const file=handoffFile(v1Root),key=safeKey(accountKey);
  return withHandoffLock(file,()=>{ const current=read(file),row=current.accounts.find(item=>item.accountKey===key);
    if(!row) throw Error('pending V2 handoff is missing');
    if(row.state==='v2_owned') return {file,state:'v2_owned',accountKey:key,alreadyComplete:true};
    if(row.state!=='pending_v2') throw Error('pending V2 handoff is missing');
    const accounts=current.accounts.map(item=>item.accountKey===key?{...item,state:'v2_owned',completedAt:new Date(now).toISOString(),expiresAt:null}:item);
    write(file,{schemaVersion:1,accounts}); return {file,state:'v2_owned',accountKey:key}; });
}

export function readV2AccountHandoff({v1Root,accountKey}={}) {
  const file=handoffFile(v1Root),key=safeKey(accountKey);
  return withHandoffLock(file,()=>{ const row=read(file).accounts.find(item=>item.accountKey===key); return row?{accountKey:key,origin:row.origin,state:row.state,expiresAt:row.expiresAt??null}:null; });
}

export function quarantineV2AccountHandoff({v1Root,accountKey,reason='submission_unknown',now=new Date().toISOString()}={}) {
  const file=handoffFile(v1Root),key=safeKey(accountKey);
  return withHandoffLock(file,()=>{ const current=read(file),row=current.accounts.find(item=>item.accountKey===key);
    if(!row) throw Error('pending V2 handoff is missing');
    if(row.state==='v2_owned') return {file,state:'v2_owned',accountKey:key,alreadyComplete:true};
    if(row.state!=='pending_v2') throw Error('pending V2 handoff is missing');
    const accounts=current.accounts.map(item=>item.accountKey===key?{...item,expiresAt:null,quarantine:{state:'submission_unknown',reason:String(reason).slice(0,120),at:new Date(now).toISOString()}}:item);
    write(file,{schemaVersion:1,accounts});return {file,state:'pending_v2',accountKey:key,quarantined:true}; });
}

export function rollbackV2AccountHandoff({v1Root,accountKey}={}) {
  const file=handoffFile(v1Root),key=safeKey(accountKey);
  return withHandoffLock(file,()=>{ const current=read(file); write(file,{schemaVersion:1,accounts:current.accounts.filter(item=>item.accountKey!==key)}); return {file,state:'legacy-checkin',accountKey:key}; });
}
