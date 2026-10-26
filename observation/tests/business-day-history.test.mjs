import test from 'node:test';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {calendarHistory} from '../src/dashboard-server.mjs';
import {dailyRecords,dayTotals} from '../public/calendar-model.mjs';
import {businessDayHistory} from '../public/business-day-history.mjs';
import {buildSnapshot} from '../src/bridge.mjs';
import {createLedgerRecord} from '../src/shadow-ledger.mjs';
import {evaluateShadowHistory} from '../src/shadow-acceptance.mjs';

const row=(day,at,status='signed')=>({schemaVersion:1,mode:'shadow_read_only',recordId:'ledger_'+day.replaceAll('-','')+'a'.repeat(16),
  businessDate:day,recordedAt:at,planHash:'a'.repeat(64),drift:{classification:'same_plan',hashValid:true},
  health:{healthy:true,sourceCheckedAt:at,freshness:{fresh:true}},counts:{logicalSites:1,executionUnits:1,status:{[status]:1}},
  taskSummaries:[{origin:'https://pt.example',observedStatus:status,evidence:{authoritative:status==='signed'}}],
  ptSummaries:[{origin:'https://pt.example',inLegacyPlan:true,observedStatus:status,evidence:{authoritative:status==='signed'}}]});

test('a persisted next-day unknown cannot overwrite the prior-day calendar or its original evidence',()=>{
  const signed=row('2026-10-25','2026-10-25T07:54:00Z');
  const late={...row('2026-10-25','2026-10-25T16:15:00Z','unknown'),recordId:'ledger_'+'b'.repeat(24)};
  const records=[signed,late],before=JSON.stringify(records);
  const projected=calendarHistory(records,{now:new Date('2026-10-26T05:00:00Z')});
  assert.equal(projected.days.length,1);assert.equal(projected.days[0].recordedAt,signed.recordedAt);
  assert.equal(dayTotals(dailyRecords({ledger:records}).get('2026-10-25')).completed,1);
  assert.equal(JSON.stringify(records),before);
});

test('missing same-day history stays missing and conflicting explicit dates are never accepted',()=>{
  const late=row('2026-10-25','2026-10-25T16:15:00Z','unknown');
  assert.equal(businessDayHistory([late]).size,0);
  assert.equal(businessDayHistory([{...late,recordedAt:'2026-10-25T07:54:00Z',ptBusinessDate:'2026-10-26'}]).size,0);
});

test('a genuine later same-day negative still supersedes an earlier completion',()=>{
  const signed=row('2026-10-25','2026-10-25T07:54:00Z'),negative=row('2026-10-25','2026-10-25T08:00:00Z','not_signed');
  assert.equal(businessDayHistory([signed,negative]).get('2026-10-25'),negative);
});

test('a malformed later calendar aggregate cannot displace an otherwise valid daily record',()=>{
  const signed=row('2026-10-25','2026-10-25T07:54:00Z'),broken={...signed,recordedAt:'2026-10-25T08:00:00Z',counts:{executionUnits:-1}};
  assert.equal(calendarHistory([signed,broken],{now:new Date('2026-10-26T05:00:00Z')}).days[0].recordedAt,signed.recordedAt);
});

test('mixed-day audit records explicitly keep source and observation dates without archiving next-day PT facts',()=>{
  const legacyRoot=fileURLToPath(new URL('./fixtures/legacy/',import.meta.url));
  const snapshot=buildSnapshot({legacyRoot,generatedAt:'2026-09-03T00:05:00Z'});
  const record=createLedgerRecord(snapshot,{recordedAt:snapshot.generatedAt});
  assert.equal(record.businessDate,'2026-09-02');assert.equal(record.observationBusinessDate,'2026-09-03');
  assert.equal(record.ptBusinessDate,'2026-09-03');assert.equal(record.ptSummaries,null);
});

test('next-day health for an old run does not poison the original daily health window',()=>{
  const records=['2026-10-24','2026-10-25','2026-10-26'].map(day=>row(day,day+'T02:00:00Z'));
  const late={...row('2026-10-24','2026-10-25T00:05:00Z'),recordId:'ledger_'+'c'.repeat(24),health:{healthy:false,sourceCheckedAt:'2026-10-25T00:05:00Z',freshness:{fresh:true}}};
  const result=evaluateShadowHistory([...records,late],{now:'2026-10-26T05:00:00Z'});
  assert.equal(result.accepted,true);assert.equal(result.eligibleRecentDays,3);
  assert.equal(result.unhealthyRecordCount,1);
});
