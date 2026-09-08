import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { buildSnapshot } from '../src/bridge.mjs';
import { validateLiveSnapshot } from './live-smoke.mjs';
import { runDryWorker } from '../src/dry-run-worker.mjs';

const [legacyArg, stateArg] = process.argv.slice(2);
if (!legacyArg || !stateArg) throw new Error('usage: worker-dry-smoke.mjs <legacy-root> <local-state-file>');
const legacyRoot = path.resolve(legacyArg);
// Read-only health probe. This script never invokes the V1 check-in runner.
const healthReport = JSON.parse(execFileSync('pwsh.exe', ['-NoProfile', '-File', path.join(legacyRoot, 'scripts', 'Test-CheckinHealth.ps1')], { encoding: 'utf8', windowsHide: true, timeout: 30_000 }));
const snapshot = buildSnapshot({ legacyRoot, healthReport });
validateLiveSnapshot(snapshot);
const worker = { workerId: 'worker_windows_dry_only', platform: 'windows', capabilities: ['browser_checkin', 'api_evidence'], allowedOrigins: [...new Set(snapshot.tasks.map(t => t.origin))], executionModes: ['dry_run'], profileIsolation: true, heartbeatAt: new Date().toISOString() };
const result = runDryWorker({ snapshot, worker, stateFile: stateArg, legacyRoot });
const counts = {};
for (const entry of result.outcomes ?? []) counts[entry.status] = (counts[entry.status] ?? 0) + 1;
console.log(JSON.stringify({ businessDate: snapshot.businessDate, executionUnits: snapshot.counts.executionUnits, mode: result.mode, executeEnabled: result.executeEnabled, browserActions: result.browserActions, businessSuccess: result.businessSuccess, counts }, null, 2));
