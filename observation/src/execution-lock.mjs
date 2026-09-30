import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

function processIsAlive(pid) {
  if(!Number.isSafeInteger(pid)||pid<=0)return null;
  try { process.kill(pid,0); return true; }
  catch(error) { if(error?.code==='ESRCH')return false; return true; }
}

function lockFile(root,name) {
  if(!['v2-run.lock','harvest-fallback.lock'].includes(name))throw Error('invalid execution lock name');
  return path.join(path.resolve(root),'data',name);
}

export function acquireExecutionLock(root,{name='v2-run.lock'}={}) {
  const file=lockFile(root,name);fs.mkdirSync(path.dirname(file),{recursive:true});
  const owner={schemaVersion:1,pid:process.pid,startedAt:new Date(Date.now()-Math.round(process.uptime()*1000)).toISOString(),nonce:crypto.randomUUID()};
  for(let attempt=0;attempt<2;attempt++){
    let created=false,handle=null;
    try { handle=fs.openSync(file,'wx',0o600);created=true;fs.writeFileSync(handle,`${JSON.stringify(owner)}\n`,'utf8');fs.closeSync(handle);handle=null;return {file,owner}; }
    catch(error) {
      try { if(handle!==null)fs.closeSync(handle); } catch {}
      if(created){try{fs.rmSync(file,{force:true});}catch{};throw error;}
      if(error?.code!=='EEXIST')throw error;
      let current;
      try { current=JSON.parse(fs.readFileSync(file,'utf8')); }
      catch {
        // Age alone cannot prove that a partial lock has no live owner.
        throw Error('V2 runner lock is unreadable');
      }
      const alive=processIsAlive(Number(current?.pid));
      if(alive!==false)throw Error('V2 runner is already active');
      // Serialize stale-owner reclamation. Two contenders must not both
      // unlink the old path, with the second removing the first's new lease.
      const guard=file+'.reclaim';
      let guardHandle;
      try{guardHandle=fs.openSync(guard,'wx',0o600);}
      catch(error){if(error.code==='EEXIST')throw Error('V2 runner is already active');throw error;}
      try{
        fs.writeFileSync(guardHandle,JSON.stringify(owner));
        const latest=JSON.parse(fs.readFileSync(file,'utf8'));
        if(JSON.stringify(latest)!==JSON.stringify(current)||processIsAlive(Number(latest.pid))!==false)throw Error('V2 runner is already active');
        fs.rmSync(file);
      }finally{
        fs.closeSync(guardHandle);
        if(JSON.parse(fs.readFileSync(guard,'utf8')).nonce===owner.nonce)fs.rmSync(guard);
      }
    }
  }
  throw Error('V2 runner lock could not be acquired');
}

export function releaseExecutionLock(lease) {
  if(!lease?.file||!lease.owner?.nonce)return false;
  let current;
  try { current=JSON.parse(fs.readFileSync(lease.file,'utf8')); } catch { return false; }
  if(current?.nonce!==lease.owner.nonce)return false;
  try { fs.rmSync(lease.file,{force:true});return true; } catch { return false; }
}
