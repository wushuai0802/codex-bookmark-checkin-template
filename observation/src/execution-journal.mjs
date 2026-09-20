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
  db.exec(`CREATE TABLE IF NOT EXISTS execution_recovery_audit(
    idempotency_key TEXT PRIMARY KEY, previous_phase TEXT NOT NULL,
    previous_outcome_json TEXT NOT NULL, proof_json TEXT NOT NULL,
    recovered_at TEXT NOT NULL
  );`);
  db.exec(`CREATE TABLE IF NOT EXISTS execution_reconciliation_audit(
    idempotency_key TEXT PRIMARY KEY, previous_outcome_json TEXT NOT NULL,
    proof_json TEXT NOT NULL, reconciled_at TEXT NOT NULL
  );`);
  db.exec(`CREATE TABLE IF NOT EXISTS execution_adoption_audit(
    idempotency_key TEXT PRIMARY KEY, previous_outcome_json TEXT NOT NULL,
    proof_json TEXT NOT NULL, adopted_at TEXT NOT NULL
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
      let recovered=false;
      if(old.phase==='reserved'){
        try { recovered=JSON.parse(old.intent_json)?.recoveryApproved===true; } catch {}
      }
      if(recovered)return {state:'reserved',duplicate:false,recovered:true,record:old};
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

export function recoverExecutionForRetry(db,{idempotencyKey,taskId,accountKey,origin,businessDate,proof,now=new Date().toISOString()}={}){
  if(!proof||proof.authoritative!==true||proof.stage!=='not_signed')throw Error('authoritative not-signed proof is required');
  if(!Number.isFinite(Date.parse(now))||!Number.isFinite(Date.parse(proof.observedAt)))throw Error('recovery timestamp is invalid');
  return tx(db,()=>{
    const old=db.prepare('SELECT * FROM execution_intents WHERE idempotency_key=?').get(idempotencyKey);
    if(!old)throw Error('execution intent missing');
    if(old.task_id!==taskId||old.account_key!==accountKey||old.origin!==origin||old.business_date!==businessDate)throw Error('execution recovery binding conflict');
    if(!['blocked','submit_rejected','submission_unknown'].includes(old.phase))throw Error('execution phase is not recoverable');
    let outcome;try{outcome=JSON.parse(old.outcome_json??'{}');}catch{throw Error('execution outcome is unreadable');}
    const durableNonMutation=['blocked','submit_rejected'].includes(old.phase)&&Number(outcome?.mutationCount??0)===0&&proof.kind==='durable_non_mutating_failure';
    const reconciledUnknown=old.phase==='submission_unknown'&&proof.kind==='authoritative_not_signed';
    if(!durableNonMutation&&!reconciledUnknown)throw Error('execution recovery proof is invalid for its phase');
    if(proof.taskId!==taskId||proof.accountKey!==accountKey||proof.origin!==origin||proof.businessDate!==businessDate)throw Error('execution recovery proof mismatch');
    if(Date.parse(proof.observedAt)<Date.parse(old.updated_at))throw Error('execution recovery proof is stale');
    const existingAudit=db.prepare('SELECT * FROM execution_recovery_audit WHERE idempotency_key=?').get(idempotencyKey);
    let attempt=1;
    if(existingAudit){
      let priorProof={};try{priorProof=JSON.parse(existingAudit.proof_json??'{}');}catch{}
      attempt=Number(priorProof.attempt??1)+1;if(attempt>2)throw Error('execution recovery limit reached');
    }
    const safeProof={authoritative:true,stage:'not_signed',kind:proof.kind,attempt,previousPhase:old.phase,source:String(proof.source??'none').slice(0,64),taskId,accountKey,origin,businessDate,observedAt:new Date(proof.observedAt).toISOString(),reason:String(proof.reason??'operator_recovery').slice(0,120)};
    const previousOutcome=JSON.stringify(outcome??{});
    if(existingAudit)db.prepare('UPDATE execution_recovery_audit SET previous_phase=?,previous_outcome_json=?,proof_json=?,recovered_at=? WHERE idempotency_key=?').run(old.phase,previousOutcome,JSON.stringify(safeProof),new Date(now).toISOString(),idempotencyKey);
    else db.prepare('INSERT INTO execution_recovery_audit VALUES(?,?,?,?,?)').run(idempotencyKey,old.phase,previousOutcome,JSON.stringify(safeProof),new Date(now).toISOString());
    const recoveredIntent={idempotencyKey,taskId,planHash:old.plan_hash,accountKey,origin,businessDate,recoveryApproved:true,recoveryProof:safeProof};
    db.prepare('UPDATE execution_intents SET phase=?,intent_json=?,outcome_json=NULL,updated_at=? WHERE idempotency_key=?').run('reserved',JSON.stringify(recoveredIntent),new Date(now).toISOString(),idempotencyKey);
    return {state:'reserved',recovered:true,previousPhase:old.phase};
  });
}

export function getExecutionRecovery(db,idempotencyKey){return db.prepare('SELECT * FROM execution_recovery_audit WHERE idempotency_key=?').get(idempotencyKey)??null;}

export function reconcileUnknownExecution(db,{idempotencyKey,taskId,accountKey,origin,businessDate,proof,now=new Date().toISOString()}={}){
  if(!proof||proof.authoritative!==true||proof.stage!=='already_done'||!proof.evidence?.authoritative)throw Error('authoritative completed proof is required');
  if(!Number.isFinite(Date.parse(now))||!Number.isFinite(Date.parse(proof.observedAt)))throw Error('reconciliation timestamp is invalid');
  return tx(db,()=>{
    const old=db.prepare('SELECT * FROM execution_intents WHERE idempotency_key=?').get(idempotencyKey);if(!old)throw Error('execution intent missing');
    if(old.task_id!==taskId||old.account_key!==accountKey||old.origin!==origin||old.business_date!==businessDate)throw Error('execution reconciliation binding conflict');
    if(old.phase!=='submission_unknown')throw Error('execution phase is not reconcilable');
    let outcome;try{outcome=JSON.parse(old.outcome_json??'{}');}catch{throw Error('execution outcome is unreadable');}
    if(Number(outcome?.mutationCount??0)<1)throw Error('unknown execution has no possible mutation');
    if(proof.taskId!==taskId||proof.accountKey!==accountKey||proof.origin!==origin||proof.businessDate!==businessDate)throw Error('execution reconciliation proof mismatch');
    if(Date.parse(proof.observedAt)<Date.parse(old.updated_at))throw Error('execution reconciliation proof is stale');
    const evidence={source:String(proof.evidence.source??'none').slice(0,64),authoritative:true,summary:String(proof.evidence.summary??'').slice(0,240)};
    const safeProof={authoritative:true,stage:'already_done',taskId,accountKey,origin,businessDate,observedAt:new Date(proof.observedAt).toISOString(),evidence};
    db.prepare('INSERT INTO execution_reconciliation_audit VALUES(?,?,?,?)').run(idempotencyKey,JSON.stringify(outcome),JSON.stringify(safeProof),new Date(now).toISOString());
    const completed={stage:'succeeded',mutationCount:1,reason:'reconciled_after_submission_unknown',evidence,completedAt:safeProof.observedAt,reconciled:true};
    db.prepare('UPDATE execution_intents SET phase=?,outcome_json=?,updated_at=? WHERE idempotency_key=?').run('succeeded',JSON.stringify(completed),new Date(now).toISOString(),idempotencyKey);
    return {state:'succeeded',reconciled:true,completedAt:safeProof.observedAt,evidence};
  });
}

export function getExecutionReconciliation(db,idempotencyKey){return db.prepare('SELECT * FROM execution_reconciliation_audit WHERE idempotency_key=?').get(idempotencyKey)??null;}

// A task blocked before submission can later be observed complete, for
// example after a separately audited V2 session repair. Keep that distinction:
// this is already_done, not a claim that the blocked attempt submitted.
export function reconcileBlockedCompletion(db,{idempotencyKey,taskId,accountKey,origin,businessDate,expectedIdentity,proof,now=new Date().toISOString()}={}){
  const observed=Date.parse(proof?.observedAt),current=Date.parse(now);
  if(proof?.stage!=='already_done'||proof?.authoritative!==true||proof?.evidence?.authoritative!==true||String(proof.evidence.accountId)!==String(expectedIdentity)||proof.evidence.businessDate!==businessDate)throw Error('account-bound completed proof required');
  if(!Number.isFinite(observed)||!Number.isFinite(current)||current-observed>300000||observed>current+30000)throw Error('completed proof is stale');
  for(const [key,value] of Object.entries({taskId,accountKey,origin,businessDate}))if(proof[key]!==value)throw Error('completed proof binding mismatch');
  return tx(db,()=>{
    const old=getExecution(db,idempotencyKey);if(!old||old.task_id!==taskId||old.account_key!==accountKey||old.origin!==origin||old.business_date!==businessDate)throw Error('execution binding mismatch');
    const prior=JSON.parse(old.outcome_json??'{}');
    if(!['blocked','submit_rejected'].includes(old.phase)||Number(prior.mutationCount??0)!==0)throw Error('execution is not a non-mutating failure');
    if(observed<Date.parse(old.updated_at))throw Error('completed proof predates failure');
    const evidence={source:String(proof.evidence.source).slice(0,64),authoritative:true,accountId:String(expectedIdentity),businessDate};
    const safeProof={taskId,accountKey,origin,businessDate,observedAt:new Date(observed).toISOString(),evidence};
    db.prepare('INSERT INTO execution_reconciliation_audit VALUES(?,?,?,?)').run(idempotencyKey,JSON.stringify(prior),JSON.stringify(safeProof),now);
    const outcome={stage:'already_done',mutationCount:0,reason:'confirmed_after_blocked_execution',evidence,completedAt:safeProof.observedAt};
    db.prepare('UPDATE execution_intents SET phase=?,outcome_json=?,updated_at=? WHERE idempotency_key=?').run('already_done',JSON.stringify(outcome),now,idempotencyKey);
    return outcome;
  });
}

export function adoptOperatorConfirmedCheckin(db,{idempotencyKey,taskId,accountKey,origin,businessDate,proof,operatorConfirmed=false,now=new Date().toISOString()}={}){
  if(operatorConfirmed!==true||!proof||proof.authoritative!==true||proof.stage!=='already_done')throw Error('operator-confirmed completed proof is required');
  if(!Number.isFinite(Date.parse(now))||!Number.isFinite(Date.parse(proof.observedAt)))throw Error('adoption timestamp is invalid');
  return tx(db,()=>{
    const old=db.prepare('SELECT * FROM execution_intents WHERE idempotency_key=?').get(idempotencyKey);if(!old)throw Error('execution intent missing');
    if(old.task_id!==taskId||old.account_key!==accountKey||old.origin!==origin||old.business_date!==businessDate)throw Error('execution adoption binding conflict');
    if(old.phase!=='already_done')throw Error('execution phase is not adoptable');
    let outcome;try{outcome=JSON.parse(old.outcome_json??'{}');}catch{throw Error('execution outcome is unreadable');}
    if(Number(outcome?.mutationCount??0)!==0)throw Error('already-done outcome is not adoptable');
    if(proof.taskId!==taskId||proof.accountKey!==accountKey||proof.origin!==origin||proof.businessDate!==businessDate)throw Error('execution adoption proof mismatch');
    if(Date.parse(proof.observedAt)<Date.parse(old.updated_at))throw Error('execution adoption proof is stale');
    const evidence={source:String(proof.evidence?.source??'none').slice(0,64),authoritative:true,summary:String(proof.evidence?.summary??'').slice(0,240)};
    const safeProof={authoritative:true,stage:'already_done',taskId,accountKey,origin,businessDate,observedAt:new Date(proof.observedAt).toISOString(),evidence,operatorConfirmed:true};
    db.prepare('INSERT INTO execution_adoption_audit VALUES(?,?,?,?)').run(idempotencyKey,JSON.stringify(outcome),JSON.stringify(safeProof),new Date(now).toISOString());
    const adopted={stage:'succeeded',mutationCount:1,reason:'operator_confirmed_v2_login',evidence,completedAt:new Date(now).toISOString(),operatorConfirmed:true};
    db.prepare('UPDATE execution_intents SET phase=?,outcome_json=?,updated_at=? WHERE idempotency_key=?').run('succeeded',JSON.stringify(adopted),new Date(now).toISOString(),idempotencyKey);
    return {state:'succeeded',adopted:true,completedAt:safeProof.observedAt,evidence};
  });
}

export function getExecutionAdoption(db,idempotencyKey){return db.prepare('SELECT * FROM execution_adoption_audit WHERE idempotency_key=?').get(idempotencyKey)??null;}
