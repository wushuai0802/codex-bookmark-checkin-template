import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPtStatus, normalizePtStatusReport } from '../src/pt-status.mjs';

const accountRef = 'acct_0123456789abcdef';
const taskId = 'task_0123456789abcdef01234567';

test('Harvest OpenCD www receipt matches the canonical bookmark and regular task',()=>{
  const result=buildPtStatus({generatedAt:'2026-10-02T02:00:00Z',businessDate:'2026-10-02',
    monitorCatalog:{sites:[{origin:'https://open.cd'}]},planTargets:[{origin:'https://open.cd'}],
    tasks:[{taskId,origin:'https://open.cd',observedStatus:'deferred'}],
    externalReport:{source:'harvest',businessDate:'2026-10-02',sites:[{origin:'https://www.open.cd',status:'signed',
      observedAt:'2026-10-02T01:59:00Z',evidence:{source:'harvest',authoritative:true,summary:'签到成功'}}]}});
  assert.equal(result.sites.length,1);assert.equal(result.sites[0].origin,'https://open.cd');
  assert.equal(result.sites[0].effective.status,'signed');assert.equal(result.sites[0].effective.authoritative,true);
});

test('historical uncertainty preserves today evidence and maintenance without certifying completion',()=>{
  const origin='https://pt.example',businessDate='2026-10-02';
  const base={generatedAt:'2026-10-02T02:00:00Z',businessDate,
    planTargets:[{origin,folderNames:['PT白名单']}],
    tasks:[{taskId,origin,accountRef,observedStatus:'needs_attention',failureCode:'submission_outcome_unknown'}],
    receipts:[{taskId,observedAt:'2026-10-02T01:50:00Z',evidence:{source:'none',authoritative:false,summary:'今日结果尚待核验'}}],
    recoveryReport:{businessDate,sites:[{origin,code:'prior_outcome_unknown',blockedSince:'2026-09-25',summary:'历史执行结果未确认'}]}};
  const unresolved=buildPtStatus(base).sites[0];
  assert.equal(unresolved.effective.evidence.summary,'今日结果尚待核验');
  assert.equal(unresolved.recovery.blockedSince,'2026-09-25');
  const maintenanceReport={source:'execution-supplement',businessDate,sites:[{origin,status:'unknown',siteCondition:'site_maintenance',
    observedAt:'2026-10-02T01:40:00Z',evidence:{source:'pt_page',authoritative:false,summary:'站点公告正在维护，等待恢复'}}]};
  const maintenance=buildPtStatus({...base,fallbackReport:maintenanceReport}).sites[0];
  assert.equal(maintenance.effective.siteCondition,'site_maintenance');
  assert.equal(maintenance.effective.evidence.summary,'站点公告正在维护，等待恢复');
  assert.equal(maintenance.effective.authoritative,false);
  assert.equal(maintenance.effective.status,'needs_attention');
  assert.equal(maintenance.recovery.code,'prior_outcome_unknown');
  const staleReport={...maintenanceReport,sites:maintenanceReport.sites.map(site=>({...site,observedAt:'2026-10-01T01:40:00Z'}))};
  assert.equal(buildPtStatus({...base,fallbackReport:staleReport}).sites[0].effective.siteCondition,undefined);
  const completed=buildPtStatus({...base,tasks:[{...base.tasks[0],observedStatus:'already_signed'}],
    receipts:[{taskId,observedAt:'2026-10-02T01:50:00Z',evidence:{source:'pt_page',authoritative:true,summary:'今日已签到'}}],
    fallbackReport:maintenanceReport}).sites[0];
  assert.equal(completed.effective.status,'already_signed');
  assert.equal(completed.effective.authoritative,true);
  assert.equal(completed.effective.evidence.summary,'今日已签到');
});

test('PT status merges legacy plan sites with Harvest-only observations', () => {
  const result = buildPtStatus({
    generatedAt: '2026-09-04T04:00:00.000Z',
    businessDate: '2026-09-04',
    planTargets: [
      { origin: 'https://kylin.example/checkin', title: '麒麟', folderNames: ['PT白名单'] }
    ],
    tasks: [{ taskId, origin: 'https://kylin.example', accountRef, observedStatus: 'signed' }],
    receipts: [{ taskId, observedAt: '2026-09-04T03:00:00.000Z', evidence: { source: 'page_text', authoritative: true, summary: '今日已签到', redacted: true } }],
    externalReport: {
      generatedAt: '2026-09-04T04:00:00.000Z', source: 'harvest', businessDate: '2026-09-04',
      sites: [{ origin: 'https://baozi.example/', displayName: '包子', status: 'not_signed', observedAt: '2026-09-04T03:30:00.000Z', evidence: { source: 'api', authoritative: true, summary: '今日未签到' } }]
    }
  });
  assert.equal(result.mode, 'status_observe_only');
  assert.equal(result.executionEnabled, false);
  assert.equal(result.counts.sites, 2);
  assert.equal(result.counts.inLegacyPlan, 1);
  assert.equal(result.counts.externalOnly, 1);
  assert.equal(result.counts.supplementCandidates, 1);
  const harvest = result.sites.find((site) => site.origin === 'https://baozi.example');
  assert.equal(harvest.effective.status, 'not_signed');
  assert.equal(harvest.supplementCandidate, true);
  assert.equal(harvest.supplementAction, 'manual_review_only');
  const legacy = result.sites.find((site) => site.origin === 'https://kylin.example');
  assert.equal(legacy.inLegacyPlan, true);
  assert.equal(legacy.effective.status, 'signed');
});

test('a newer weak signed report cannot replace earlier authoritative same-day completion',()=>{
  const origin='https://ourbits.club';
  const result=buildPtStatus({generatedAt:'2026-10-01T10:30:00Z',businessDate:'2026-10-01',
    planTargets:[{origin,title:'我堡',folderNames:['PT白名单']}],
    tasks:[{taskId,origin,accountRef,observedStatus:'signed'}],
    receipts:[{taskId,observedAt:'2026-10-01T10:22:00Z',evidence:{source:'none',authoritative:false}}],
    monitorCatalog:{sites:[{origin,displayName:'我堡'}]},
    fallbackReport:{source:'execution-supplement',businessDate:'2026-10-01',generatedAt:'2026-10-01T10:21:00Z',
      sites:[{origin,status:'already_signed',observedAt:'2026-10-01T10:21:00Z',evidence:{source:'pt_page',authoritative:true,businessDate:'2026-10-01'}}]}});
  assert.equal(result.sites[0].effective.status,'already_signed');
  assert.equal(result.sites[0].effective.authoritative,true);
  assert.equal(result.sites[0].displayName,'我堡');
});

test('a supplement keeps the bookmark display name for monitoring-only sites',()=>{
  const origin='https://pt.example';
  const result=buildPtStatus({generatedAt:'2026-10-01T10:30:00Z',businessDate:'2026-10-01',
    monitorCatalog:{sites:[{origin,displayName:'PT Name'}]},
    fallbackReport:{source:'execution-supplement',businessDate:'2026-10-01',generatedAt:'2026-10-01T10:21:00Z',
      sites:[{origin,status:'already_signed',observedAt:'2026-10-01T10:21:00Z',evidence:{source:'pt_page',authoritative:true}}]}});
  assert.equal(result.sites[0].displayName,'PT Name');
});

test('a monitored PT site is joined to the full execution plan across a non-PT folder label',()=>{
  const result=buildPtStatus({
    generatedAt:'2026-09-04T04:00:00.000Z',businessDate:'2026-09-04',
    planTargets:[{origin:'https://open.cd',title:'OpenCD',folderNames:['公益站']}],
    tasks:[{taskId:'open-task',origin:'https://open.cd/index.php',accountRef:null,observedStatus:'signed'}],
    receipts:[{taskId:'open-task',observedAt:'2026-09-04T03:00:00.000Z',evidence:{source:'page_text',authoritative:true,summary:'今日已签到'}}],
    monitorCatalog:{sites:[{origin:'https://open.cd',displayName:'OpenCD'}]},
    externalReport:{source:'harvest',businessDate:'2026-09-04',sites:[{origin:'https://open.cd',status:'unknown',observedAt:null}]}
  });
  assert.equal(result.counts.inLegacyPlan,1);
  assert.equal(result.sites[0].origin,'https://open.cd');
  assert.equal(result.sites[0].effective.status,'signed');
  assert.equal(result.sites[0].effective.source,'legacy-checkin');
});

test('conflicting sources are visible and stale observations are never supplement candidates', () => {
  const result = buildPtStatus({
    generatedAt: '2026-09-04T04:00:00.000Z', businessDate: '2026-09-04',
    planTargets: [{ origin: 'https://piggo.example', title: '猪猪', folderNames: ['PT白名单'] }],
    tasks: [{ taskId, origin: 'https://piggo.example', accountRef: null, observedStatus: 'signed' }],
    receipts: [{ taskId, observedAt: '2026-09-04T03:00:00.000Z', evidence: { source: 'page_text', authoritative: true, summary: '已签到', redacted: true } }],
    externalReport: {
      generatedAt: '2026-09-04T04:00:00.000Z', source: 'harvest', sites: [
        { origin: 'https://piggo.example', status: 'not_signed', observedAt: '2026-09-03T03:00:00.000Z', evidence: { source: 'api', authoritative: true, summary: '旧状态' } }
      ]
    }
  });
  const site = result.sites[0];
  assert.equal(site.discrepancy, false);
  assert.equal(site.supplementCandidate, false);
  assert.equal(site.effective.fresh, true);
  assert.equal(site.sourceStatuses.length, 2);
});

test('a later unverified unknown cannot hide same-day authoritative V1 completion', () => {
  const base = {
    generatedAt: '2026-09-20T03:00:00.000Z', businessDate: '2026-09-20',
    planTargets: [{ origin: 'https://pt.example', folderNames: ['PT白名单'] }],
    tasks: [{ taskId, origin: 'https://pt.example', accountRef: null, observedStatus: 'signed' }],
    receipts: [{ taskId, observedAt: '2026-09-20T00:00:00.000Z', evidence: { source: 'page_text', authoritative: true, summary: '今日已签到' } }],
    externalReport: { source: 'harvest', businessDate: '2026-09-20', sites: [
      { origin: 'https://pt.example', status: 'unknown', observedAt: '2026-09-20T01:00:00.000Z', evidence: { source: 'harvest', authoritative: false } }
    ] }
  };
  const site = buildPtStatus(base).sites[0];
  assert.equal(site.effective.status, 'signed');
  assert.equal(site.effective.source, 'legacy-checkin');
  assert.equal(site.sourceStatuses.length, 2);

  base.externalReport.sites[0].status = 'not_signed';
  base.externalReport.sites[0].evidence.authoritative = true;
  const conflict = buildPtStatus(base).sites[0];
  assert.equal(conflict.effective.status, 'not_signed');
  assert.equal(conflict.discrepancy, true);
});

test('a newer non-authoritative execution failure cannot hide an authoritative OpenCD read-only receipt',()=>{
  const result=buildPtStatus({generatedAt:'2026-09-29T03:00:00Z',businessDate:'2026-09-29',
    planTargets:[{origin:'https://open.cd',folderNames:['公益站']}],
    tasks:[{taskId:'open',origin:'https://open.cd',accountRef:null,observedStatus:'failed'}],
    receipts:[{taskId:'open',observedAt:'2026-09-29T02:55:00Z',evidence:{source:'none',authoritative:false,summary:'提交结果不明'}}],
    monitorCatalog:{sites:[{origin:'https://open.cd'}]},
    fallbackReport:{source:'execution-supplement',businessDate:'2026-09-29',sites:[{origin:'https://open.cd',status:'already_signed',observedAt:'2026-09-29T02:00:00Z',evidence:{source:'pt_page',authoritative:true,summary:'顶部显示查看签到记录'}}]},
  });
  assert.equal(result.sites[0].effective.status,'already_signed');
  assert.equal(result.sites[0].effective.source,'execution-supplement');
  assert.equal(result.sites[0].discrepancy,false);
});

test('PT status rejects credential-bearing reports and normalizes safe aliases', () => {
  assert.throws(() => normalizePtStatusReport({ source: 'harvest', sites: [{ origin: 'https://example.com', status: 'signed', password: 'TEST' }] }), /sensitive field/);
  const report = normalizePtStatusReport({ generatedAt: '2026-09-04T04:00:00.000Z', source: 'harvest', sites: [{ origin: 'https://example.com', status: 'checked_in', observedAt: '2026-09-04T03:00:00.000Z', evidence: { source: 'api', authoritative: true, summary: 'ok' } }] });
  assert.equal(report.sites[0].status, 'signed');
  assert.equal(report.sites[0].evidence.redacted, true);
});

test('same-day site supplement is visible without adding a daily task',()=>{
  const generatedAt='2026-09-20T02:30:00Z',origin='https://pt.example';
  const pt=buildPtStatus({generatedAt,businessDate:'2026-09-20',monitorCatalog:{sites:[{origin}]},fallbackOnlyEnabled:true,
    externalReport:{source:'harvest',businessDate:'2026-09-20',sites:[{origin,status:'unknown',observedAt:null}]},
    fallbackReport:{source:'execution-supplement',businessDate:'2026-09-20',sites:[{origin,status:'signed',observedAt:'2026-09-20T02:20:00Z',evidence:{source:'page_text',authoritative:true,summary:'今日已签到'}}]}});
  assert.equal(pt.counts.sites,1);assert.equal(pt.counts.inLegacyPlan,0);
  assert.equal(pt.counts.fallbackOnly,1);assert.equal(pt.sites[0].fallbackEnabled,true);
  assert.equal(pt.sites[0].effective.status,'signed');
  assert.equal(pt.sites[0].effective.source,'execution-supplement');
  assert.throws(()=>buildPtStatus({generatedAt,businessDate:'2026-09-20',monitorCatalog:{sites:[{origin}]},
    fallbackReport:{source:'execution-supplement',businessDate:'2026-09-19',sites:[]}}),/wrong source or date/);
});

test('yesterday completion stays in source history but cannot count as today completed',()=>{
  const origin='https://pt.example',base={generatedAt:'2026-09-30T00:55:00+08:00',businessDate:'2026-09-30',
    planTargets:[{origin,folderNames:['PT白名单']}],
    tasks:[{taskId,origin,accountRef:null,observedStatus:'signed'}],
    receipts:[{taskId,observedAt:'2026-09-29T10:00:00+08:00',evidence:{source:'page_text',authoritative:true,summary:'昨日已签到'}}],
    monitorCatalog:{sites:[{origin}]}};
  const before=buildPtStatus(base);
  assert.equal(before.counts.status.signed,0);
  assert.equal(before.counts.status.unknown,1);
  assert.equal(before.sites[0].sourceStatuses[0].status,'signed');
  assert.equal(before.sites[0].sourceStatuses[0].fresh,false);
  const after=buildPtStatus({...base,externalReport:{source:'harvest',businessDate:'2026-09-30',sites:[
    {origin,status:'signed',observedAt:'2026-09-30T09:50:00+08:00',evidence:{source:'harvest',authoritative:true}}
  ]},generatedAt:'2026-09-30T10:00:00+08:00'});
  assert.equal(after.counts.status.signed,1);
  assert.equal(after.sites[0].effective.source,'harvest');
});
