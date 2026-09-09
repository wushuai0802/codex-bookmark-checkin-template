import fs from 'node:fs';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {assertPlanHash} from './contracts.mjs';

function openDb(file, legacyRoot) {
  const destination=path.resolve(file), legacy=path.resolve(legacyRoot);
  const canonical=value=>process.platform==='win32'?value.toLowerCase():value;
  if(canonical(destination)===canonical(legacy)||canonical(destination).startsWith(canonical(legacy)+path.sep))throw Error('execution journal cannot be inside V1');
  fs.mkdirSync(path.dirname(destination),{recursive:true});
  const db=new DatabaseSync(destination);
  db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;');
  db.exec(`CREATE TABLE IF NOT EXISTS execution_intents(
    idempotency_key TEXT PRIMARY KEY, task_id TEXT NOT NULL, plan_hash TEXT NOT NULL,
    account_key TEXT NOT NULL, origin TEXT NOT NULL, business_date TEXT NOT NULL,
    phase TEXT NOT NULL, intent_json TEXT NOT NULL, outcome_json TEXT,
    updated_at TEXT NOT NULL
  );`);
  return db;
}

function tx(db, fn) { db.exec('BEGIN IMMEDIATE'); try { const value=fn(); db.exec('COMMIT'); return value; } catch(error) { db.exec('ROLLBACK'); throw error; } }

export function openExecutionJournal(file, legacyRoot) { return openDb(file, legacyRoot); }

export function reserveExecution(db, {idempotencyKey,taskId,planHash,accountKey,origin,businessDate,now=new Date().toISOString()}={}) {
  assertPlanHash(planHash);
  return tx(db,()=>{
    const old=db.prepare('SELECT * FROM execution_intents WHERE idempotency_key=?').get(idempotencyKey);
    if(old){
      const same=old.task_id===taskId&&old.plan_hash===planHash&&old.account_key===accountKey&&old.origin===origin&&old.business_date===businessDate;
      if(!same)throw Error('execution intent binding conflict');
      return {state:old.phase,duplicate:true,record:old};
    }
    db.prepare('INSERT INTO execution_intents VALUES(?,?,?,?,?,?,?,?,?,?)').run(idempotencyKey,taskId,planHash,accountKey,origin,businessDate,'reserved',JSON.stringify({idempotencyKey,taskId,planHash,accountKey,origin,businessDate}),null,now);
    return {state:'reserved',duplicate:false};
  });
}

export function recordPrepared(db, intent, now=new Date().toISOString()) {
  return tx(db,()=>{
    const old=db.prepare('SELECT * FROM execution_intents WHERE idempotency_key=?').get(intent.idempotencyKey);
    if(!old||old.phase!=='reserved') throw Error('execution intent binding is not reserved');
    db.prepare('UPDATE execution_intents SET phase=?,intent_json=?,updated_at=? WHERE idempotency_key=?').run('prepared',JSON.stringify(intent),now,intent.idempotencyKey);
    return {state:'prepared'};
  });
}

export function cancelReservation(db, idempotencyKey) {
  return tx(db,()=>{
    const old=db.prepare('SELECT phase FROM execution_intents WHERE idempotency_key=?').get(idempotencyKey);
    if(!old) return false;
    if(old.phase!=='reserved') throw Error('only a reserved execution can be cancelled');
    db.prepare('DELETE FROM execution_intents WHERE idempotency_key=?').run(idempotencyKey);
    return true;
  });
}

export function recordOutcome(db, {idempotencyKey,phase,outcome,now=new Date().toISOString()}={}) {
  const allowed=new Set(['succeeded','submission_unknown','blocked','submit_rejected','already_done','not_available']);
  if(!allowed.has(phase)) throw Error('execution outcome phase invalid');
  return tx(db,()=>{
    const old=db.prepare('SELECT * FROM execution_intents WHERE idempotency_key=?').get(idempotencyKey);
    if(!old) throw Error('execution intent missing');
    const transitions={reserved:new Set(['blocked','already_done','not_available']),prepared:new Set(['blocked','submit_rejected','submission_unknown','succeeded'])};
    if(old.phase===phase)return {state:phase,duplicate:true};
    if(!transitions[old.phase]?.has(phase))throw Error('execution intent phase conflict');
    const mutationCount=Number(outcome?.mutationCount??0);
    if(phase==='succeeded'&&(mutationCount!==1||outcome?.evidence?.authoritative!==true))throw Error('successful execution outcome is not authoritative');
    if(['already_done','not_available'].includes(phase)&&(mutationCount!==0||outcome?.evidence?.authoritative!==true))throw Error('terminal no-mutation outcome is not authoritative');
    if(phase==='submission_unknown'&&mutationCount<1)throw Error('unknown submission must retain a possible mutation');
    if(['blocked','submit_rejected'].includes(phase)&&mutationCount!==0)throw Error('non-mutating outcome cannot contain a mutation');
    db.prepare('UPDATE execution_intents SET phase=?,outcome_json=?,updated_at=? WHERE idempotency_key=?').run(phase,JSON.stringify(outcome??{}),now,idempotencyKey);
    return {state:phase};
  });
}

export function getExecution(db, idempotencyKey) { return db.prepare('SELECT * FROM execution_intents WHERE idempotency_key=?').get(idempotencyKey)??null; }
