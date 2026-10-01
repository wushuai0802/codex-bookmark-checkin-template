import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSnapshot } from '../src/bridge.mjs';
import { createDashboardServer } from '../src/dashboard-server.mjs';
import { createLedgerRecord } from '../src/shadow-ledger.mjs';
import { taskIdentity, planHash, accountRef } from '../src/contracts.mjs';

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
const mode = process.argv.includes('--showcase') ? 'showcase' : process.argv.includes('--stress') ? 'stress' : process.argv.includes('--empty') ? 'empty' : 'normal';
if (mode === 'showcase') {
  const original=snapshot.tasks[0],receipt=snapshot.receipts[0];
  const names=['枫叶社区','星河工坊','云端书屋','清风论坛','蓝鲸空间','远山笔记','晨光站','海盐社区','流云服务','月光书签','山海驿站','松林计划','晴空实验室'];
  snapshot.tasks=Array.from({length:26},(_,index)=>{
    const status=index<15?'signed':index<18?'already_signed':index<22?'not_available':['login_required','deferred','needs_attention','failed'][index-22];
    const origin='https://site-'+(index%13+1)+'.example',accountKey='demo-account-'+(index+1);
    const identity=taskIdentity({businessDate,logicalSiteKey:origin,accountKey});
    return {...original,taskId:identity.taskId,planUnitId:identity.planUnitId,
      businessDate,origin,logicalSiteKey:origin,accountKey,
      displayName:names[index%13],accountRef:accountRef(accountKey),
      identity:{username:'演示账号 '+String(index+1).padStart(2,'0'),userId:String(1000+index),source:'configuration'},
      observedStatus:status};
  });
  snapshot.receipts=snapshot.tasks.map((task,index)=>({
    ...receipt,taskId:task.taskId,status:task.observedStatus,observedAt:snapshot.generatedAt,
    evidence:{source:'api',authoritative:index!==0&&index!==9,redacted:true,
      verification:index===0||index===9?'unverified_source':'verified',
      summary:task.observedStatus==='login_required'?'登录状态已失效，请在执行电脑完成身份校验。'
        :task.observedStatus==='deferred'?'站点响应较慢，等待既有重试窗口。'
        :task.observedStatus==='needs_attention'?'需要复核当前账号与预期身份是否一致。'
        :task.observedStatus==='failed'?'本轮未取得权威成功回执，可先查看证据详情。'
        :task.observedStatus==='not_available'?'站点本日未开放签到功能。'
        :index===0||index===9?'执行已报成功，等待补充当日证据。':'当日回执已确认，账号身份匹配。'}
  }));
  snapshot.health={...snapshot.health,healthy:true,sourceCheckedAt:snapshot.generatedAt,
    freshness:{fresh:true,ageHours:0,maxAgeHours:26},failedCheckCount:0};
} else if (mode === 'stress') {
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
  snapshot.planHash=planHash(snapshot.tasks);
  snapshot.snapshotId='snap_'+snapshot.planHash.slice(0,24);
  snapshot.counts = { ...snapshot.counts, executionUnits: snapshot.tasks.length,
    logicalSites: new Set(snapshot.tasks.map(task => task.origin)).size,
    status: snapshot.tasks.reduce((counts, task) => {
      counts[task.observedStatus] = (counts[task.observedStatus] ?? 0) + 1; return counts;
    }, {}) };
}
if (mode === 'normal' || mode === 'showcase') {
  const site = (name, status, authoritative) => ({
    origin: 'https://' + name + '.example', displayName: name, fallbackEnabled: true,
    effective: { source: authoritative ? 'harvest' : 'execution-supplement',
      status, observedAt: snapshot.generatedAt, fresh: true, authoritative,
      evidence: { source: authoritative ? 'harvest' : 'page_text',
        authoritative, summary: authoritative ? '今日已完成' : '执行回执待补证' } },
    sourceStatuses: [], observations: []
  });
  snapshot.ptStatus.sites = mode==='showcase'
    ? Array.from({length:30},(_,index)=>({...site('pt-demo-'+(index+1),index<26?'signed':'unknown',index<23),
      displayName:'演示 PT '+String(index+1).padStart(2,'0'),inLegacyPlan:index<20}))
    : [site('confirmed','signed',true),site('reported','signed',false),site('unknown','unknown',false)];
  snapshot.ptStatus.counts = { ...snapshot.ptStatus.counts, sites:snapshot.ptStatus.sites.length,
    inLegacyPlan:mode==='showcase'?20:0,fallbackOnly:mode==='showcase'?10:3,
    status:{ ...snapshot.ptStatus.counts.status, signed:mode==='showcase'?26:2, unknown:mode==='showcase'?4:1 } };
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
