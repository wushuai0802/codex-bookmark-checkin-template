import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = file => fs.readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');

test('CI, package metadata and Docker share the supported Node 24 runtime', () => {
  const major = read('.node-version').trim();
  assert.equal(major, '24');
  assert.equal(process.versions.node.split('.')[0], major, 'Run V2 with Node.js 24.x (node:sqlite required)');
  const manifest = JSON.parse(read('package.json'));
  assert.equal(manifest.engines.node, '>=24.0.0 <25');
  assert.deepEqual(JSON.parse(read('package-lock.json')).packages[''].engines, manifest.engines);
  assert.match(read('Dockerfile'), /^FROM node:24-alpine/m);
  const workflow = read('.github/workflows/v2-checks.yml');
  assert.match(workflow, /node-version-file: \.node-version/);
  assert.match(workflow, /ubuntu-latest/);
  assert.match(workflow, /windows-latest/);
});

test('clean checkouts include the sanitized receipt expected by legacy fixture state', () => {
  const base = 'tests/fixtures/legacy';
  const scheduler = JSON.parse(read(`${base}/data/scheduler-state.json`));
  const report = JSON.parse(read(`${base}/logs/${scheduler.lastRunId}/result.json`));
  assert.equal(report.runId, scheduler.lastRunId);
  assert.equal(report.results.length, 3);
  assert.ok(report.results.every(result => new URL(result.origin).hostname.endsWith('.example')));
  assert.doesNotMatch(JSON.stringify(report), /"(?:password|token|cookie|secret|authorization)"\s*:/i);
});
