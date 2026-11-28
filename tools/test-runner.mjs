#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXECUTION_ROOT = path.join(REPO_ROOT, 'execution');
const EXECUTION_TEST_DIR = path.join(EXECUTION_ROOT, 'tests');

// Tests that launch real Chrome instances or share heavy persistent browser
// startup paths. Run them serially (--test-concurrency=1) to prevent Windows
// disk/profile Local State contention while keeping full coverage.
export const EXECUTION_BROWSER_TESTS = Object.freeze([
  'checkin-click.test.mjs',
  'hddolby-readonly.test.mjs',
  'hddolby-two-factor.test.mjs',
  'maintenance-flow.test.mjs',
  'piggo-login-chain.test.mjs',
  'pt-read-first.test.mjs',
  'pt-supplement.test.mjs',
  'u2-receipt.test.mjs',
  'u2-requestion.test.mjs',
  'u2-routing.test.mjs',
  'uhddolby-domain.test.mjs',
  'wo23-daily-open-and-notice.test.mjs',
]);

export function discoverExecutionTests(testDir = EXECUTION_TEST_DIR) {
  const all = fs.readdirSync(testDir)
    .filter(name => name.endsWith('.test.mjs'))
    .sort();
  const allSet = new Set(all);
  const browserSet = new Set(EXECUTION_BROWSER_TESTS);
  if (browserSet.size !== EXECUTION_BROWSER_TESTS.length) {
    throw new Error('Duplicate entries in EXECUTION_BROWSER_TESTS');
  }
  const missing = EXECUTION_BROWSER_TESTS.filter(name => !allSet.has(name));
  if (missing.length > 0) {
    throw new Error(`Missing browser test files: ${missing.join(', ')}`);
  }
  const browser = EXECUTION_BROWSER_TESTS.slice().sort();
  const unit = all.filter(name => !browserSet.has(name));
  if (unit.length + browser.length !== all.length) {
    throw new Error('Test partition mismatch');
  }
  const unlistedBrowser = unit.filter(name => {
    const text = fs.readFileSync(path.join(testDir, name), 'utf8');
    return /piggo-login-chain-fixture|launchPersistentContext|chromium\.launch\b/.test(text);
  });
  if (unlistedBrowser.length > 0) {
    throw new Error(`Real-browser tests missing from EXECUTION_BROWSER_TESTS: ${unlistedBrowser.join(', ')}`);
  }
  return { all, unit, browser };
}

export function selectShard(files, shardSpec) {
  if (!shardSpec) return files;
  const match = /^(\d+)\/(\d+)$/.exec(String(shardSpec).trim());
  if (!match) throw new Error(`Invalid --shard value: ${shardSpec}`);
  const index = Number(match[1]);
  const total = Number(match[2]);
  if (!Number.isSafeInteger(index) || !Number.isSafeInteger(total) || total < 1 || index < 1 || index > total) {
    throw new Error(`Out-of-range --shard value: ${shardSpec}`);
  }
  // Round-robin assignment balances alphabetically clustered slow suites.
  return files.filter((_, i) => (i % total) === (index - 1));
}

function runNodeTest(files, { concurrency } = {}) {
  if (files.length === 0) return 0;
  const args = ['--test'];
  if (Number.isInteger(concurrency) && concurrency > 0) {
    args.push(`--test-concurrency=${concurrency}`);
  }
  args.push(...files.map(name => path.join('tests', name)));
  const child = spawnSync(process.execPath, args, {
    cwd: EXECUTION_ROOT,
    stdio: 'inherit',
  });
  if (child.error) throw child.error;
  return child.status ?? 1;
}

function parseArgs(argv) {
  let suite = null;
  let shard = null;
  let checkOnly = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--check') {
      checkOnly = true;
    } else if (arg === '--suite') {
      suite = argv[++i] ?? '';
    } else if (arg === '--shard') {
      shard = argv[++i] ?? '';
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return { suite, shard, checkOnly };
}

function main() {
  const { suite, shard, checkOnly } = parseArgs(process.argv.slice(2));
  const { all, unit, browser } = discoverExecutionTests();
  if (checkOnly) {
    const s1 = selectShard(unit, '1/2');
    const s2 = selectShard(unit, '2/2');
    const b1 = selectShard(browser, '1/2');
    const b2 = selectShard(browser, '2/2');
    if (s1.length + s2.length !== unit.length || new Set([...s1, ...s2]).size !== unit.length) {
      throw new Error('Unit shard partition invariant violated');
    }
    if (b1.length + b2.length !== browser.length || new Set([...b1, ...b2]).size !== browser.length) {
      throw new Error('Browser shard partition invariant violated');
    }
    console.log(JSON.stringify({
      ok: true,
      total: all.length,
      unit: unit.length,
      browser: browser.length,
      unitShards: [s1.length, s2.length],
      browserShards: [b1.length, b2.length],
    }));
    return;
  }
  if (!['execution-unit', 'execution-browser', 'execution-all'].includes(suite)) {
    throw new Error('Usage: node tools/test-runner.mjs (--check | --suite execution-unit|execution-browser|execution-all [--shard N/M])');
  }
  if (suite === 'execution-all' && shard) {
    throw new Error('--shard cannot be combined with --suite execution-all');
  }
  if (suite === 'execution-unit') {
    const selected = selectShard(unit, shard);
    console.log(`[test-runner] execution-unit${shard ? ` shard ${shard}` : ''}: ${selected.length}/${unit.length} files`);
    process.exit(runNodeTest(selected));
  }
  if (suite === 'execution-browser') {
    const selected = selectShard(browser, shard);
    console.log(`[test-runner] execution-browser${shard ? ` shard ${shard}` : ''} (serial): ${selected.length}/${browser.length} files`);
    process.exit(runNodeTest(selected, { concurrency: 1 }));
  }
  console.log(`[test-runner] execution-all: ${unit.length} unit + ${browser.length} serial browser files`);
  const unitCode = runNodeTest(unit);
  if (unitCode !== 0) process.exit(unitCode);
  process.exit(runNodeTest(browser, { concurrency: 1 }));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
