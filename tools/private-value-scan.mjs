#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const diagnosticFile = 'tools/private-value-scan.mjs';
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const normalizeKey = key => key.replace(/[-_\s]/g, '').toLowerCase();

// Only these identity/secret fields are collected. In particular, never collect
// filesystem paths, origins, login URLs, provider names or public rule strings.
const keyGroups = {
  account_id: ['accountId', 'accountIds', 'oauthAccountId', 'apiAccountId', 'siteAccountId'],
  account_key: ['accountKey', 'accountKeys', 'disabledAccountKeys', 'selectedAccountKeys',
    'configuredAccountKeys', 'oauthExecutionAccountBindings', 'oauthRecoveryAccountBindings'],
  upstream_account: ['upstreamAccount', 'upstreamAccounts', 'upstreamAccountId', 'upstreamAccountKey',
    'boundUpstreamAccountId', 'boundUpstreamAccountKey', 'oauthUpstreamAccountBindings'],
  expected_account: ['expectedAccount', 'expectedAccounts', 'expectedAccountId', 'expectedAccountIds',
    'configuredExpectedAccountId', 'expectedId', 'expectedIdentity', 'oauthExpectedAccountIds'],
  user_id: ['userId', 'userIds', 'anyRouterUserId', 'expectedUserId', 'configuredUserId'],
  ssh_target: ['sshTarget', 'sshHost', 'sshHostname', 'sshAlias', 'sshDestination', 'nasSshTarget'],
  username: ['username', 'userName', 'loginUsername', 'siteUsername', 'sshUser'],
  email: ['email', 'emails', 'emailAddress', 'emailAddresses', 'mail'],
  token: ['token', 'tokens', 'apiToken', 'apiKey', 'accessToken', 'refreshToken', 'botToken',
    'telegramBotToken', 'bearerToken', 'authorization'],
  webhook: ['webhook', 'webhooks', 'webhookUrl', 'webhookUrls', 'notificationWebhook', 'notifyWebhook'],
  bookmark_folder: ['folderName', 'folderNames', 'bookmarkFolder', 'bookmarkFolders', 'bookmarkFolderName',
    'bookmarkFolderNames', 'mobileFolderNames', 'targetFolderNames', 'parentFolderName',
    'containerFolderName', 'childFolderNames', 'ptFolderNames', 'edgeMobileFolderNames', 'edgeTargetFolderNames']
};
const categories = new Map(Object.entries(keyGroups).flatMap(([category, keys]) =>
  keys.map(key => [normalizeKey(key), category])));
// These maps are indexed by private account keys, rather than by public origins.
const accountKeyMaps = new Set(['oauthAccountProbeRules', 'oauthAccountApiProbeRules'].map(normalizeKey));
const valueMaps = new Set(['accountIds', 'accountKeys', 'oauthExecutionAccountBindings', 'oauthRecoveryAccountBindings',
  'upstreamAccounts', 'oauthUpstreamAccountBindings', 'expectedAccounts', 'expectedAccountIds', 'oauthExpectedAccountIds',
  'userIds', 'emails', 'emailAddresses', 'tokens', 'webhooks', 'webhookUrls'].map(normalizeKey));
const contextualFields = {
  account_id: ['id'], account_key: ['key'], upstream_account: ['id', 'key', 'name'],
  expected_account: ['id', 'key', 'name'], user_id: ['id'], username: ['name', 'value'], email: ['address', 'value'],
  ssh_target: ['target', 'host', 'hostname', 'alias'], token: ['value', 'secret'], webhook: ['url', 'value'], bookmark_folder: ['name']
};
const generic = new Set(['site-default', 'default', 'unknown', 'shared', 'primary', 'secondary',
  'linuxdo', 'github', 'telegram', 'example-user', 'example-folder', 'example-pt-folder', '示例站点', '移动设备书签', 'false', 'true', 'null']);
const publicConfig = name => /^(?:defaults|qa-rules|site-rules\.public)\.json$/i.test(name) || /\.(?:example|schema)\.json$/i.test(name);
const encryptedConfig = name => /(?:^|[.-])(?:dpapi|enc|encrypted)(?:[.-]|$)/i.test(name);
const publicField = key => /(?:path|paths|url|urls|origin|origins|dir|directory|provider|label|title|header|endpoint)$/i.test(key);
const publicValue = value => /^(?:https?:\/\/|[a-z]:[\\/]|[./\\])/i.test(value);

function collectValues(config, values) {
  function add(value, category) {
    if (!['string', 'number'].includes(typeof value)) return;
    const text = String(value).trim();
    if (text.length < 5 || generic.has(text.toLowerCase()) || /^<[^>]+>$/.test(text)) return;
    if (!values.has(text)) values.set(text, new Set());
    values.get(text).add(category);
  }
  function group(value, category, map = false) {
    if (Array.isArray(value)) { for (const item of value) group(item, category, map); return; }
    if (object(value)) {
      for (const [key, child] of Object.entries(value)) {
        const normalized = normalizeKey(key), known = categories.get(normalized);
        if (known) group(child, known, valueMaps.has(normalized));
        else if (contextualFields[category].includes(normalized)) add(child, category);
        else if (!publicField(key)) {
          if (object(child) || Array.isArray(child)) group(child, category, map);
          else if (map && (['webhook', 'token'].includes(category) || !publicValue(String(child)))) add(child, category);
        }
      }
    } else add(value, category);
  }
  function walk(value) {
    if (Array.isArray(value)) { for (const child of value) walk(child); return; }
    if (!object(value)) return;
    for (const [key, child] of Object.entries(value)) {
      const normalized = normalizeKey(key), category = categories.get(normalized);
      if (category) group(child, category, valueMaps.has(normalized));
      if (accountKeyMaps.has(normalized) && object(child)) {
        for (const accountKey of Object.keys(child)) if (!publicValue(accountKey)) add(accountKey, 'account_key');
      }
      walk(child);
    }
  }
  walk(config);
}

// lstat every component before opening it: a config directory, source directory
// or file may itself be a Windows Junction. Never traverse a private data tree.
function plainPath(file) {
  const absolute = path.resolve(file), parsed = path.parse(absolute);
  if (/^[\\/]{2}/.test(absolute)) throw Error('unsafe_path');
  let current = parsed.root;
  for (const part of absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    if (fs.lstatSync(current).isSymbolicLink()) throw Error('unsafe_path');
  }
  return fs.lstatSync(absolute);
}
function readJson(file) {
  if (!plainPath(file).isFile()) throw Error('unreadable');
  const value = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  if (!object(value)) throw Error('invalid_json');
  return value;
}
function readConfiguration(roots, values) {
  for (const key of ['executionRoot', 'observationRoot', 'opsRoot']) {
    if (typeof roots[key] !== 'string' || !roots[key].trim()) throw Error('missing_root');
    const directory = path.join(roots[key], 'config');
    if (!plainPath(directory).isDirectory()) throw Error('unreadable');
    const entries = fs.readdirSync(directory).filter(name => /\.json$/i.test(name) && !publicConfig(name));
    if (!entries.length) throw Error('missing_configuration');
    for (const name of entries) {
      if (encryptedConfig(name)) throw Error('encrypted_configuration');
      collectValues(readJson(path.join(directory, name)), values);
    }
  }
}
function textContent(buffer) {
  if (buffer[0] === 0xff && buffer[1] === 0xfe) return buffer.subarray(2).toString('utf16le');
  if (buffer[0] === 0xfe && buffer[1] === 0xff) return Buffer.from(buffer.subarray(2)).swap16().toString('utf16le');
  if (buffer.includes(0)) return null;
  try { return new TextDecoder('utf-8', {fatal: true}).decode(buffer); } catch { return null; }
}
const failure = category => ({ok: false, findings: [{file: diagnosticFile, line: 0, category}]});
// An empty directory marker holds nothing private; its path and bytes are still scanned below.
const protectedFile = file => !file.endsWith('/.gitkeep') && /^(?:(?:execution|observation)\/)?(?:data|logs|outputs|tmp)\//i.test(file) ||
  /(?:^|\/)(?:chrome-user-data|profiles?|Local State|Cookies|Login Data)(?:\/|$)/i.test(file) ||
  /(?:\.local\.json|\.(?:dpapi|enc|encrypted|db|sqlite))$/i.test(file);

export function scanPrivateValues({source = project, ...roots} = {}) {
  const values = new Map();
  try { readConfiguration(roots, values); } catch { return failure('private_configuration_unreadable'); }
  let files;
  try {
    plainPath(source);
    const git = args => execFileSync('git', ['-C', source, ...args],
      {encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 32 * 1024 * 1024});
    const top = git(['rev-parse', '--show-toplevel']).trim();
    if (fs.realpathSync(top) !== fs.realpathSync(source)) throw Error('not_repository_root');
    files = [...new Set(git(['ls-files', '-z']).split('\0').filter(Boolean))].sort();
    if (!files.length) throw Error('empty_repository');
  } catch { return failure('tracked_files_unavailable'); }
  const findings = [];
  const privateValues = [...values].map(([value, kinds]) => ({
    value, escaped: JSON.stringify(value).slice(1, -1), categories: [...kinds].sort()
  }));
  for (const file of files) {
    // A path containing a private value is itself private; do not echo it.
    const displayFile = privateValues.some(item => file.includes(item.value)) ? '<redacted-file>' : file;
    if (/[\x00-\x1f\\:]/.test(file) || file.split('/').some(part => part === '..' || !part))
      return failure('unsafe_tracked_path');
    if (protectedFile(file)) { findings.push({file: displayFile, line: 0, category: 'protected_private_file'}); continue; }
    let content;
    try {
      const fullPath = path.join(source, file);
      if (!plainPath(fullPath).isFile()) throw Error('not_file');
      content = textContent(fs.readFileSync(fullPath));
    } catch { return failure('tracked_file_unreadable'); }
    if (content === null) continue;
    for (const [index, line] of content.split(/\r?\n/).entries()) {
      const decoded = line.replace(/\\u([a-f\d]{4})/gi, (_all, hex) => String.fromCharCode(parseInt(hex, 16)));
      const kinds = new Set();
      for (const item of privateValues) if (line.includes(item.value) || line.includes(item.escaped) || decoded.includes(item.value))
        for (const kind of item.categories) kinds.add(kind);
      for (const category of [...kinds].sort()) findings.push({file: displayFile, line: index + 1, category});
    }
  }
  return {ok: findings.length === 0, findings};
}

// Diagnostics are fixed categories and repository-relative locations only.
// Never propagate filesystem/JSON/Git exception messages or private values.
export const formatPrivateValueFindings = result => result.findings.map(item => `${item.file}:${item.line} ${item.category}`);
export function scanConfiguredPrivateValues({source = project, config = path.join(source, 'tools/release.local.json'), roots = {}} = {}) {
  try {
    const configured = readJson(config);
    const resolved = Object.fromEntries(['executionRoot', 'observationRoot', 'opsRoot'].map(key => {
      const value = roots[key] ?? configured[key];
      if (typeof value !== 'string' || !value.trim()) throw Error('missing_root');
      return [key, roots[key] ? path.resolve(value) : path.resolve(path.dirname(config), value)];
    }));
    return scanPrivateValues({source, ...resolved});
  } catch { return failure('release_configuration_unreadable'); }
}
export function runPrivateValueScanCli(args, {stdout = text => console.log(text)} = {}) {
  try {
    const options = {};
    for (let i = 0; i < args.length; i++) {
      const key = {'--source': 'source', '--config': 'config'}[args[i]];
      if (!key || !args[i + 1] || args[i + 1].startsWith('--') || Object.hasOwn(options, key)) throw Error('invalid_arguments');
      options[key] = path.resolve(args[++i]);
    }
    const result = scanConfiguredPrivateValues(options);
    for (const line of formatPrivateValueFindings(result)) stdout(line);
    return result.ok ? 0 : 1;
  } catch { stdout(`${diagnosticFile}:0 invalid_arguments`); return 1; }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  process.exitCode = runPrivateValueScanCli(process.argv.slice(2));
