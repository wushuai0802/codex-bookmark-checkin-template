import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { evaluateCandidateDispatch, idempotencyKey } from './candidate-protocol.mjs';

function digest(value) { return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex'); }

function stateDestination(stateFile, legacyRoot) {
  if (!stateFile) throw new Error('state file is required');
  const file = path.resolve(stateFile);
  if (!legacyRoot) throw new Error('legacyRoot exclusion boundary is required');
  const legacy = path.resolve(legacyRoot).toLowerCase();
  if (file.toLowerCase() === legacy || file.toLowerCase().startsWith(legacy + path.sep)) throw new Error('worker state must not be under legacy root');
  for (let at = path.dirname(file); at !== path.dirname(at); at = path.dirname(at)) {
    if (fs.existsSync(at) && fs.lstatSync(at).isSymbolicLink()) throw new Error('worker state cannot use symlink ancestors');
  }
  if (fs.existsSync(file) && fs.lstatSync(file).isSymbolicLink()) throw new Error('worker state cannot be a symlink');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  return file;
}

function save(file, state) {
  const temporary = file + '.' + crypto.randomUUID() + '.tmp';
  try {
    fs.writeFileSync(temporary, JSON.stringify(state, null, 2) + '\n', { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    fs.renameSync(temporary, file);
  } finally { fs.rmSync(temporary, { force: true }); }
}

// Windows-capable one-shot worker harness. No network, shell, browser,
// credential, or notification adapter exists here, even behind a flag.
export function runDryWorker({ snapshot, worker, stateFile, legacyRoot, now = new Date().toISOString(), mode = 'dry_run', fault = null } = {}) {
  if (mode !== 'dry_run') throw new Error('this worker only supports dry_run');
  if (!snapshot || !worker) throw new Error('snapshot and capability manifest are required');
  if (!Array.isArray(snapshot.tasks) || snapshot.tasks.length > 1000) throw new Error('bounded task list is required');
  const file = stateDestination(stateFile, legacyRoot);
  const lock = file + '.lock';
  try { fs.writeFileSync(lock, String(process.pid), { flag: 'wx', mode: 0o600 }); }
  catch (error) {
    if (error.code === 'EEXIST') return { mode: 'dry_run', executeEnabled: false, browserActions: 0, busy: true };
    throw error;
  }
  try {
    const state = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { schemaVersion: 1, mode: 'dry_run', jobs: {} };
    if (state.schemaVersion !== 1 || state.mode !== 'dry_run' || !state.jobs || Array.isArray(state.jobs)) throw new Error('invalid dry-run journal');
    const outcomes = [];
    for (const task of snapshot.tasks) {
      const decision = evaluateCandidateDispatch({ snapshot, taskId: task.taskId, worker, requestedMode: 'dry_run', now });
      if (decision.decision !== 'dry_run') { outcomes.push({ taskId: task.taskId, status: 'denied', reasons: decision.reasons }); continue; }
      const key = idempotencyKey(task);
      const binding = digest({ planHash: snapshot.planHash, task, workerId: worker.workerId });
      const old = state.jobs[key];
      if (old) {
        outcomes.push({ taskId: task.taskId, status: old.binding !== binding ? 'binding_conflict' : old.phase === 'complete' ? 'duplicate' : 'interrupted_requires_review' });
        continue;
      }
      state.jobs[key] = { taskId: task.taskId, binding, phase: 'prepared', preparedAt: now, browserActionPerformed: false };
      save(file, state);
      // Faults are test-only states. A prepared item is not replayed on restart.
      if (fault === 'after_prepare') throw new Error('injected worker interruption');
      if (fault === 'timeout' || fault === 'offline') {
        state.jobs[key].phase = 'interrupted';
        state.jobs[key].diagnostic = fault;
        save(file, state);
        outcomes.push({ taskId: task.taskId, status: 'interrupted_requires_review' });
        continue;
      }
      state.jobs[key].phase = 'complete';
      state.jobs[key].completedAt = now;
      save(file, state);
      outcomes.push({ taskId: task.taskId, status: 'dry_run_complete' });
    }
    return { schemaVersion: 1, mode: 'dry_run', executeEnabled: false, browserActions: 0, businessSuccess: false, busy: false, outcomes };
  } finally { fs.rmSync(lock, { force: true }); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = {};
    for (let i = 2; i < process.argv.length; i += 2) {
      const key = process.argv[i];
      if (!['--snapshot', '--worker', '--state', '--legacy-root', '--mode'].includes(key) || !process.argv[i + 1]) throw new Error('invalid worker argument');
      args[key] = process.argv[i + 1];
    }
    const snapshot = JSON.parse(fs.readFileSync(args['--snapshot'], 'utf8'));
    const worker = JSON.parse(fs.readFileSync(args['--worker'], 'utf8'));
    console.log(JSON.stringify(runDryWorker({ snapshot, worker, stateFile: args['--state'], legacyRoot: args['--legacy-root'], mode: args['--mode'] ?? 'dry_run' }), null, 2));
  } catch (error) { console.error('dry-run worker: ' + error.message); process.exitCode = 1; }
}
