import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSnapshot } from '../src/bridge.mjs';
import { createDashboardServer } from '../src/dashboard-server.mjs';
import { createLedgerRecord } from '../src/shadow-ledger.mjs';

// Local, synthetic preview only. It never reads an installed check-in runtime.
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fabric-ui-preview-'));
const snapshot = buildSnapshot({
  legacyRoot: fileURLToPath(new URL('../tests/fixtures/legacy/', import.meta.url)),
  generatedAt: new Date().toISOString()
});
const businessDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date());
snapshot.businessDate = businessDate;
snapshot.tasks = snapshot.tasks.map(task => ({ ...task, businessDate }));
snapshot.ptStatus.businessDate = businessDate;
const mode = process.argv.includes('--stress') ? 'stress' : process.argv.includes('--empty') ? 'empty' : 'normal';
if (mode === 'stress') {
  const originals = snapshot.tasks;
  const receipts = new Map(snapshot.receipts.map(receipt => [receipt.taskId, receipt]));
  snapshot.tasks = Array.from({ length: 200 }, (_, index) => {
    const original = originals[index % originals.length];
    const origin = 'https://long-synthetic-' + index % 20 + '-' + 'a'.repeat(48) + '.example';
    return { ...original, taskId: 'task_' + (index + 1).toString(16).padStart(24, '0'),
      origin, displayName: '用于检查窄屏换行和卡片排版的较长合成站点名称'.repeat(3).slice(0, 78),
      observedStatus: index % 10 === 0 ? 'needs_attention' : original.observedStatus };
  });
  snapshot.receipts = snapshot.tasks.map((task, index) => {
    const source = receipts.get(originals[index % originals.length].taskId);
    return { ...source, taskId: task.taskId, status: task.observedStatus,
      evidence: { ...source.evidence, summary: '长文本压力检查：请查看合成任务的证据来源与账号绑定。'.repeat(8) } };
  });
} else if (mode === 'empty') {
  snapshot.tasks = [];
  snapshot.receipts = [];
}
if (mode !== 'normal') {
  snapshot.counts = { ...snapshot.counts, executionUnits: snapshot.tasks.length,
    logicalSites: new Set(snapshot.tasks.map(task => task.origin)).size,
    status: snapshot.tasks.reduce((counts, task) => {
      counts[task.observedStatus] = (counts[task.observedStatus] ?? 0) + 1; return counts;
    }, {}) };
}
if (mode === 'normal') {
  const site = (name, status, authoritative) => ({
    origin: 'https://' + name + '.example', displayName: name, fallbackEnabled: true,
    effective: { source: authoritative ? 'harvest' : 'execution-supplement',
      status, observedAt: snapshot.generatedAt, fresh: true, authoritative,
      evidence: { source: authoritative ? 'harvest' : 'page_text',
        authoritative, summary: authoritative ? '今日已完成' : '执行回执待补证' } },
    sourceStatuses: [], observations: []
  });
  snapshot.ptStatus.sites = [site('confirmed','signed',true),
    site('reported','signed',false), site('unknown','unknown',false)];
  snapshot.ptStatus.counts = { ...snapshot.ptStatus.counts, sites:3,
    status:{ ...snapshot.ptStatus.counts.status, signed:2, unknown:1 } };
  const current = createLedgerRecord(snapshot);
  const days = 86_400_000;
  const history = Array.from({length:5},(_,index)=>{
    const date = new Date(Date.parse(businessDate + 'T00:00:00Z') - (5-index)*days).toISOString().slice(0,10);
    return { ...current, businessDate:date, recordedAt:date + 'T12:00:00Z',
      recordId:'ledger_' + (index+1).toString(16).padStart(24,'0'),
      taskSummaries:current.taskSummaries.map(task=>({ ...task, businessDate:date })) };
  });
  fs.writeFileSync(path.join(dataDir,'shadow-ledger.jsonl'),
    [...history,current].map(record=>JSON.stringify(record)).join('\n') + '\n');
}
fs.writeFileSync(path.join(dataDir, 'shadow-beta-snapshot.json'), JSON.stringify(snapshot));
fs.writeFileSync(path.join(dataDir, 'control-state.json'), JSON.stringify({ schemaVersion: 1, sites: {}, audit: [] }));
const { server } = createDashboardServer({ dataDir, adminToken: '', bind: '127.0.0.1', port: 0 });
server.listen(0, '127.0.0.1', () => {
  console.log('Synthetic dashboard preview: http://127.0.0.1:' + server.address().port);
  console.log('Scenario: ' + mode);
  console.log('Fixture contains example domains and cannot execute check-ins. Ctrl+C stops the preview.');
});
