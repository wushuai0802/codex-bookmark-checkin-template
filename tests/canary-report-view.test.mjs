import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {publicCanaryResults} from '../src/canary-report-view.mjs';

test('dashboard canary view exposes bounded redacted execution and delivery state',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'canary-view-'));
  fs.writeFileSync(path.join(dir,'canary-result-api42-2026-09-09.json'),JSON.stringify({taskId:'task_aaaaaaaaaaaaaaaaaaaaaaaa',businessDate:'2026-09-09',accountKey:'api42-20603',mode:'canary_read_only',stage:'already_done',phase:'status_read',mutationCount:0,completedAt:'2026-09-09T01:00:00Z'}));
  fs.writeFileSync(path.join(dir,'notification-notice_aaaaaaaa.json'),JSON.stringify({taskId:'task_aaaaaaaaaaaaaaaaaaaaaaaa',state:'delivered',attempts:1}));
  const rows=publicCanaryResults(dir); assert.equal(rows.length,1); assert.equal(rows[0].notification.state,'delivered'); assert.equal(rows[0].mutationCount,0); assert.doesNotMatch(JSON.stringify(rows),/profileDir|password|cookie/i);
});
