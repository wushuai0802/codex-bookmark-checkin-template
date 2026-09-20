import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLease, createNotificationOutboxItem, createReceipt, createTaskEnvelope, evaluateCandidateDispatch } from './candidate-protocol.mjs';

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { throw new Error(`invalid JSON in ${file}: ${error.message}`); }
}

/**
 * Simulate the candidate worker boundary without launching a browser or
 * granting an execute lease. A dry-run receipt explicitly says no action was
 * performed, so it can never be mistaken for a successful check-in.
 */
export function simulateCandidateRun({ snapshot, worker, now = new Date().toISOString() } = {}) {
  if (!snapshot || !worker) throw new Error('snapshot and worker are required');
  const decisions = [];
  const envelopes = [];
  const receipts = [];
  const notifications = [];
  for (const task of snapshot.tasks ?? []) {
    const decision = evaluateCandidateDispatch({ snapshot, taskId: task.taskId, worker, requestedMode: 'dry_run', now });
    decisions.push(decision);
    if (decision.decision !== 'dry_run') continue;
    const lease = createLease({ taskId: task.taskId, planHash: snapshot.planHash, owner: worker.workerId, issuedAt: now, ttlSeconds: 60 });
    const envelope = createTaskEnvelope({ snapshot, task, lease, mode: 'dry_run' });
    const receipt = createReceipt({
      taskId: task.taskId,
      leaseId: lease.leaseId,
      workerId: worker.workerId,
      businessDate: task.businessDate,
      status: 'deferred',
      observedAt: now,
      executionMode: 'dry_run',
      evidence: { source: 'none', authoritative: false, summary: 'dry-run: no browser action performed', redacted: true }
    });
    // Keep each envelope schema-valid. Simulation provenance lives on the
    // enclosing result rather than adding non-protocol fields to the envelope.
    envelopes.push(envelope);
    receipts.push(receipt);
    notifications.push(createNotificationOutboxItem({ receipt, createdAt: now }));
  }
  const denied = decisions.filter((decision) => decision.decision === 'deny');
  return {
    schemaVersion: 1,
    runId: `sim_${Date.now().toString(36)}`,
    simulatedAt: new Date(now).toISOString(),
    mode: 'dry_run',
    executeEnabled: false,
    simulation: { leaseSimulation: true, browserActionPerformed: false },
    summary: {
      taskCount: decisions.length,
      dryRunCount: envelopes.length,
      deniedCount: denied.length,
      executableCount: decisions.filter((decision) => decision.executable).length,
      notificationCount: notifications.length
    },
    decisions,
    envelopes,
    receipts,
    notifications
  };
}

function parseArgs(argv) {
  const args = {};
  for (let index = 2; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--snapshot') args.snapshot = argv[++index];
    else if (token === '--worker') args.worker = argv[++index];
    else if (token === '--out') args.out = argv[++index];
    else if (token === '--now') args.now = argv[++index];
    else if (token === '--help' || token === '-h') args.help = true;
    else throw new Error(`unknown argument: ${token}`);
  }
  return args;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  try {
    const args = parseArgs(process.argv);
    if (args.help) {
      console.log('Usage: node src/candidate-simulator.mjs --snapshot <json> --worker <json> [--out <json>] [--now <iso>]');
      process.exit(0);
    }
    if (!args.snapshot || !args.worker) throw new Error('provide --snapshot and --worker');
    const result = simulateCandidateRun({ snapshot: readJson(args.snapshot), worker: readJson(args.worker), now: args.now });
    const output = JSON.stringify(result, null, 2);
    if (args.out) {
      fs.mkdirSync(path.dirname(path.resolve(args.out)), { recursive: true });
      fs.writeFileSync(path.resolve(args.out), `${output}\n`, 'utf8');
    }
    console.log(output);
  } catch (error) {
    console.error(`candidate simulation error: ${error.message}`);
    process.exitCode = 1;
  }
}
