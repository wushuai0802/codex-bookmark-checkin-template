import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync, spawnSync} from 'node:child_process';
import {scanPrivateValues, scanConfiguredPrivateValues, formatPrivateValueFindings} from '../../tools/private-value-scan.mjs';
import {runReleaseCli} from '../../tools/release.mjs';

const project = fileURLToPath(new URL('../../', import.meta.url));
const save = (file, value) => { fs.mkdirSync(path.dirname(file), {recursive: true}); fs.writeFileSync(file, JSON.stringify(value)); };
function fixture(t) {
  fs.mkdirSync(path.join(project, 'tmp'), {recursive: true});
  const root = fs.mkdtempSync(path.join(project, 'tmp/private-value-scan-')), source = path.join(root, 'source');
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const roots = Object.fromEntries(['executionRoot', 'observationRoot', 'opsRoot'].map(key => [key, path.join(root, key)]));
  for (const directory of Object.values(roots)) save(path.join(directory, 'config/config.json'), {accountKey: 'site-default'});
  fs.mkdirSync(source);
  const git = args => execFileSync('git', ['-C', source, ...args], {stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true});
  git(['init', '--quiet']);
  const track = (file, content) => {
    const full = path.join(source, file); fs.mkdirSync(path.dirname(full), {recursive: true}); fs.writeFileSync(full, content);
    git(['add', '--', file]);
  };
  track('README.md', 'Public fixture\n');
  const config = path.join(root, 'release.local.json');
  save(config, Object.fromEntries(Object.keys(roots).map(key => [key, key])));
  return {root, source, roots, config, track, scan: () => scanPrivateValues({source, ...roots})};
}

test('tracked text of any extension is scanned with exact lines and only category diagnostics', t => {
  const f = fixture(t), value = 'synthetic-private-account';
  save(path.join(f.roots.executionRoot, 'config/config.json'), {nested: {accountKey: value}});
  f.track('docs/candidate.fixture', `safe\nprivate: ${value}\n`);
  f.track('docs/unicode.fixture', Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(value, 'utf16le')]));
  f.track('asset.bin', Buffer.from([0, 1, 2, 3]));
  const result = f.scan();
  assert.equal(result.ok, false);
  assert.deepEqual(formatPrivateValueFindings(result), ['docs/candidate.fixture:2 account_key', 'docs/unicode.fixture:1 account_key']);
  assert.equal(JSON.stringify(result).includes(value), false);
});

for (const [category, key, value] of [
  ['account_id', 'account_id', '100009'], ['account_key', 'accountKey', 'synthetic-account-key'],
  ['upstream_account', 'boundUpstreamAccountId', '100008'], ['expected_account', 'oauthExpectedAccountIds', {'https://example.com': '100007'}],
  ['user_id', 'anyRouterUserId', '100006'], ['ssh_target', 'sshTarget', 'synthetic-ssh-alias'],
  ['username', 'username', 'synthetic-private-user'], ['email', 'email', 'synthetic-person@example.com'],
  ['token', 'accessToken', 'synthetic-private-bearer'], ['webhook', 'webhookUrl', 'https://hooks.example.test/synthetic-private-hook'],
  ['bookmark_folder', 'mobileFolderNames', ['synthetic-bookmark-folder']]
]) test(`${category} fields are collected from nested private configuration`, t => {
  const f = fixture(t), text = typeof value === 'object' ? Object.values(value)[0] : value;
  save(path.join(f.roots.observationRoot, 'config/runtime.local.json'), {nested: {[key]: value}});
  f.track('candidate.txt', String(text));
  assert.deepEqual(formatPrivateValueFindings(f.scan()), [`candidate.txt:1 ${category}`]);
});

test('account-keyed maps, nested upstream accounts and escaped Unicode remain private', t => {
  const f = fixture(t), value = 'synthetic-map-account', username = '合成用户名六个字';
  save(path.join(f.roots.executionRoot, 'config/config.local.json'), {
    oauthAccountProbeRules: {[value]: {url: 'https://example.com/login'}}, upstreamAccount: {id: '100008', username}
  });
  f.track('candidate.txt', `${value}\n100008\n${[...username].map(char => '\\u' + char.charCodeAt(0).toString(16).padStart(4, '0')).join('')}`);
  assert.deepEqual(formatPrivateValueFindings(f.scan()), ['candidate.txt:1 account_key', 'candidate.txt:2 upstream_account', 'candidate.txt:3 username']);
});

test('named Webhook maps retain private URLs while public login URL fields stay excluded', t => {
  const f = fixture(t), value = 'https://hooks.example.test/synthetic-named-private-hook';
  save(path.join(f.roots.opsRoot, 'config/notification.local.json'), {webhooks: {daily: value}, loginUrl: 'https://example.com/login'});
  f.track('candidate.txt', value + '\nhttps://example.com/login');
  assert.deepEqual(formatPrivateValueFindings(f.scan()), ['candidate.txt:1 webhook']);
});

test('wrapped private values are collected without unrelated public metadata', t => {
  const f = fixture(t), hook = 'https://hooks.example.test/synthetic-wrapped-hook', bearer = 'synthetic-wrapped-bearer';
  const publicNote = 'public-metadata-description';
  save(path.join(f.roots.opsRoot, 'config/notification.local.json'), {
    webhook: {url: hook, description: publicNote}, token: {value: bearer, type: publicNote},
    sshTarget: {host: 'synthetic-wrapped-ssh', description: publicNote},
    upstreamAccount: {id: '100009', description: publicNote, loginUrl: 'https://example.com/login'}
  });
  f.track('candidate.txt', [hook, bearer, 'synthetic-wrapped-ssh', '100009', publicNote, 'https://example.com/login'].join('\n'));
  assert.deepEqual(formatPrivateValueFindings(f.scan()), [
    'candidate.txt:1 webhook', 'candidate.txt:2 token', 'candidate.txt:3 ssh_target', 'candidate.txt:4 upstream_account'
  ]);
});

test('short and generic values, filesystem paths, origins and public login rules do not produce findings', t => {
  const f = fixture(t), publicValues = {accountKey: 'site-default', accountId: '1234', username: 'example-user',
    mobileFolderNames: ['example-folder', '示例站点'], automationUserDataDir: 'data/accounts/fixture/chrome-user-data',
    origin: 'https://example.com', loginUrl: 'https://example.com/login', accountIdPaths: ['data.user.id'],
    password: '<synthetic-not-an-allowlisted-field>'};
  save(path.join(f.roots.executionRoot, 'config/config.json'), publicValues);
  f.track('candidate.txt', JSON.stringify(publicValues));
  assert.deepEqual(f.scan(), {ok: true, findings: []});
  assert.deepEqual(scanConfiguredPrivateValues({source: f.source, config: f.config}), {ok: true, findings: []});
});

test('all shallow private JSON configurations are covered and public rule files are never read', t => {
  const f = fixture(t), value = 'synthetic-additional-private-user';
  save(path.join(f.roots.executionRoot, 'config/accounts.json'), {username: value});
  const rules = path.join(f.roots.executionRoot, 'config/site-rules.public.json');
  fs.writeFileSync(rules, 'not parsed');
  const read = fs.readFileSync; let publicReads = 0;
  t.mock.method(fs, 'readFileSync', (file, ...args) => { if (path.resolve(file) === rules) publicReads++; return read(file, ...args); });
  f.track('candidate.txt', value);
  assert.deepEqual(formatPrivateValueFindings(f.scan()), ['candidate.txt:1 username']);
  assert.equal(publicReads, 0);
});

test('encrypted configuration is refused without opening it', t => {
  const f = fixture(t), encrypted = path.join(f.roots.executionRoot, 'config/credentials.encrypted.json');
  fs.writeFileSync(encrypted, 'synthetic-encrypted-file');
  const read = fs.readFileSync; let encryptedReads = 0;
  t.mock.method(fs, 'readFileSync', (file, ...args) => { if (path.resolve(file) === encrypted) encryptedReads++; return read(file, ...args); });
  assert.equal(f.scan().ok, false); assert.equal(encryptedReads, 0);
});

test('every configured root must have readable valid private JSON, without leaking parse errors', t => {
  for (const key of ['executionRoot', 'observationRoot', 'opsRoot']) for (const mode of ['missing', 'invalid', 'empty']) {
    const f = fixture(t), file = path.join(f.roots[key], 'config/config.json'), value = 'synthetic-private-parse-marker';
    if (mode === 'missing') fs.unlinkSync(file);
    else fs.writeFileSync(file, mode === 'invalid' ? `{"username":"${value}` : '[]');
    const result = f.scan();
    assert.deepEqual(formatPrivateValueFindings(result), ['tools/private-value-scan.mjs:0 private_configuration_unreadable']);
    assert.equal(JSON.stringify(result).includes(value), false);
  }
});

test('CLI fails closed when release configuration is absent or invalid and never prints its path or values', t => {
  const f = fixture(t), marker = 'synthetic-private-error-path', config = path.join(f.root, marker + '.json');
  for (const body of [null, `{"username":"${marker}`]) {
    if (body !== null) fs.writeFileSync(config, body);
    const result = spawnSync(process.execPath, [path.join(project, 'tools/private-value-scan.mjs'), '--source', f.source, '--config', config], {encoding: 'utf8'});
    assert.equal(result.status, 1);
    assert.equal(result.stdout.trim(), 'tools/private-value-scan.mjs:0 release_configuration_unreadable');
    assert.equal(result.stderr, ''); assert.equal((result.stdout + result.stderr).includes(marker), false);
  }
});

test('CLI returns nonzero for a match and zero for a clean synthetic repository', t => {
  const f = fixture(t), value = 'synthetic-cli-private-user';
  save(path.join(f.roots.executionRoot, 'config/config.json'), {username: value});
  const args = [path.join(project, 'tools/private-value-scan.mjs'), '--source', f.source, '--config', f.config];
  assert.equal(spawnSync(process.execPath, args, {encoding: 'utf8'}).status, 0);
  f.track('candidate.txt', value);
  const result = spawnSync(process.execPath, args, {encoding: 'utf8'});
  assert.equal(result.status, 1); assert.equal(result.stdout.trim(), 'candidate.txt:1 username');
  assert.equal((result.stdout + result.stderr).includes(value), false);
});

test('tracked Profile and encrypted data are refused without opening them; untracked files are not read', t => {
  const f = fixture(t), files = ['data/chrome-user-data/Local State', 'secrets.enc'];
  for (const file of files) f.track(file, 'synthetic-private-profile');
  fs.writeFileSync(path.join(f.source, 'untracked.txt'), 'synthetic-untracked');
  const read = fs.readFileSync; let forbiddenReads = 0;
  t.mock.method(fs, 'readFileSync', (file, ...args) => {
    if (files.some(name => path.resolve(file) === path.join(f.source, name)) || String(file).endsWith('untracked.txt')) forbiddenReads++;
    return read(file, ...args);
  });
  const result = f.scan();
  assert.equal(forbiddenReads, 0); assert.equal(result.ok, false);
  assert.equal(result.findings.length, 2); assert.ok(result.findings.every(item => item.category === 'protected_private_file'));
});

test('an empty directory marker under a runtime folder passes, but other files there and marker contents do not', t => {
  const f = fixture(t);
  for (const file of ['execution/logs/.gitkeep', 'execution/tmp/.gitkeep', 'observation/outputs/.gitkeep']) f.track(file, '');
  assert.equal(f.scan().ok, true);
  f.track('execution/logs/run.json', 'synthetic');
  const result = f.scan();
  assert.equal(result.ok, false); assert.deepEqual(result.findings.map(item => item.file), ['execution/logs/run.json']);
});

test('the browser default mobile folder name is not treated as a private value', t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.executionRoot, 'config/generic.json'), JSON.stringify({mobileFolderNames: ['移动设备书签']}));
  f.track('generic-folder.txt', '移动设备书签');
  assert.equal(f.scan().ok, true);
});

for (const scope of ['configuration', 'source']) test(`${scope} Junctions are refused before any target file is read`, t => {
  const f = fixture(t), alias = scope === 'configuration' ? path.join(f.roots.executionRoot, 'config') : path.join(f.source, 'docs');
  if (scope === 'source') f.track('docs/candidate.txt', 'safe');
  const original = alias + '-original'; fs.renameSync(alias, original);
  fs.symlinkSync(original, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const read = fs.readFileSync; let forbiddenReads = 0;
  t.mock.method(fs, 'readFileSync', (file, ...args) => {
    if (path.resolve(file).startsWith(alias + path.sep)) forbiddenReads++;
    return read(file, ...args);
  });
  const result = f.scan();
  assert.equal(result.ok, false); assert.equal(forbiddenReads, 0);
});

for (const mode of ['match', 'unreadable']) test(`release gate refuses ${mode} before querying runtime tasks or processes`, async t => {
  const f = fixture(t), value = 'synthetic-gate-private-user';
  save(path.join(f.roots.executionRoot, 'config/config.json'), {username: value});
  if (mode === 'match') f.track('candidate.txt', value);
  else fs.unlinkSync(path.join(f.roots.executionRoot, 'config/config.json'));
  const manifest = path.join(f.root, 'manifest.json');
  save(manifest, {roots: {execution: f.roots.executionRoot, observation: f.roots.observationRoot, operations: f.roots.opsRoot}});
  const errors = [];
  const code = await runReleaseCli(['gate', '--manifest', manifest, '--config', f.config], {
    projectSource: f.source, probe: assert.fail, stdout: assert.fail, stderr: text => errors.push(text)
  });
  assert.equal(code, 3); assert.equal(errors.length, 1); assert.equal(errors.join('\n').includes(value), false);
  assert.match(errors[0], mode === 'match' ? /^candidate\.txt:1 username$/ : /:0 private_configuration_unreadable$/);
});
