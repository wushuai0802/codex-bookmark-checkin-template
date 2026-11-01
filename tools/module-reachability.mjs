#!/usr/bin/env node
// Text-only inventory: never import, invoke or read the private inputs of a target.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

const slash = value => value.replaceAll('\\', '/');
const normalize = value => path.posix.normalize(slash(value));
const codeFile = /\.(?:[cm]?js|ps1|py|vbs|sh)$/i;
const assetFile = /\.(?:html|css|[cm]?js)$/i;
const packageOf = file => file.split('/')[0];
const inScope = file => /^(?:execution|observation)\/(?:src|scripts|public)\//.test(file);
const unique = values => [...new Set(values)].sort();
const merge = values => values.some(value => value === null) ? null : unique(values.flat());
const combine = (groups, join) => groups.some(group => group === null) ? null :
  groups.reduce((result, group) => result.flatMap(left => group.map(right => join(left, right))), ['']);
const lineAt = (source, at) => source.slice(0, at).split('\n').length;

// The names below denote architecture roles, not local configured paths. These
// cross-package mappings are evidenced by architecture.md and their binding guards.
function roleBindings(file) {
  const pkg = packageOf(file);
  const values = {
    __dirname: path.posix.dirname(file), 'import.meta.url': file,
    root: pkg, rootDirectory: pkg, projectRoot: 'observation',
    legacyRoot: 'execution', v1Root: 'execution', legacy: 'execution',
    controller: 'observation', binding: 'observation',
    'policy.root': 'execution', 'record.legacyRoot': 'execution',
    'runtime.legacyRoot': 'execution', 'integration.v2ProjectRoot': 'observation',
    'config.v2ProjectRoot': 'observation', 'plan.source': '.',
    'plan.roots.execution': 'execution', 'roots.execution': 'execution',
    'plan.roots.observation': 'observation', 'roots.observation': 'observation',
    'plan.roots.operations': 'observation', 'roots.operations': 'observation',
    PSScriptRoot: path.posix.dirname(file), PSCommandPath: file,
    resolvedLegacyRoot: 'execution', LegacyRoot: 'execution',
    resolvedProjectRoot: 'observation', ProjectRoot: 'observation',
    opsRoot: 'observation', resolvedOpsRoot: 'observation', OpsRoot: 'observation',
  };
  if (['observation/scripts/collect-desired-plan.mjs', 'observation/scripts/collect-monitor-catalog.mjs'].includes(file)) values.root = 'execution';
  if (file === 'execution/scripts/Native-PtGuard.ps1') values['state.root'] = 'execution';
  if (file === 'execution/scripts/Cleanup-PtWorker.ps1') { values.RuntimeRoot = 'execution'; values.resolvedRoot = 'execution'; }
  return new Map(Object.entries(values).map(([key, value]) => [file.endsWith('.ps1') ? key.toLowerCase() : key, [value]]));
}

function unquote(text, powershell = false) {
  if (powershell) return text.slice(1, -1).replaceAll("''", "'");
  return text.slice(1, -1).replace(/\\(u[\da-f]{4}|x[\da-f]{2}|[\s\S])/gi, (_, escape) => {
    if (/^[ux]/.test(escape)) return String.fromCodePoint(parseInt(escape.slice(1), 16));
    return ({n: '\n', r: '\r', t: '\t'})[escape] ?? escape;
  });
}

// Strings, comments and regexes cannot manufacture imports. Offsets are retained
// for line evidence; templates are opaque unless their interpolation is bounded.
function tokens(source, powershell = false) {
  const result = [];
  for (let at = 0; at < source.length;) {
    const rest = source.slice(at);
    const skip = powershell ? rest.match(/^(?:\s+|#[^\r\n]*|<#[\s\S]*?#>)/) :
      rest.match(/^(?:\s+|\/\/[^\r\n]*|\/\*[\s\S]*?\*\/|#![^\r\n]*)/);
    if (skip) { at += skip[0].length; continue; }
    const quoted = rest.match(powershell ? /^(?:'(?:''|[^'])*'|"(?:`[\s\S]|[^"`])*")/ :
      /^(?:'(?:\\[\s\S]|[^'\\])*'|"(?:\\[\s\S]|[^"\\])*"|`(?:\\[\s\S]|[^`\\])*`)/)?.[0];
    if (quoted) {
      const template = quoted[0] === '`' && quoted.includes('${') || powershell && quoted[0] === '"' && quoted.includes('$');
      result.push({kind: template ? 'template' : 'string', value: unquote(quoted, powershell), at, end: at + quoted.length});
      at += quoted.length; continue;
    }
    const previous = result.at(-1);
    if (!powershell && rest[0] === '/' && (!previous || /^(?:[=(:,[!&|?{};]|return|throw|case|yield)$/.test(previous.value))) {
      const regex = rest.match(/^\/(?:\\[^\r\n]|\[(?:\\[^\r\n]|[^\]\\\r\n])*\]|[^/\\[\r\n])+\/[a-z]*/i)?.[0];
      if (regex) { result.push({kind: 'regex', value: '', at, end: at + regex.length}); at += regex.length; continue; }
    }
    const word = rest.match(powershell ? /^\$?[A-Za-z_][\w:-]*(?:\.[A-Za-z_][\w]*)*/ : /^[A-Za-z_$][\w$]*/)?.[0];
    const value = word ?? source[at];
    result.push({kind: word ? 'word' : 'punct', value, at, end: at + value.length});
    at += value.length;
  }
  return result;
}

function closeAt(list, start) {
  const opening = list[start]?.value, closing = {'(': ')', '[': ']', '{': '}'}[opening];
  let depth = 0;
  for (let i = start; i < list.length; i++) {
    if (list[i].kind !== 'punct') continue;
    if (list[i].value === opening) depth++;
    if (list[i].value === closing && --depth === 0) return i;
  }
  return list.length;
}

function splitTop(list, separator) {
  const groups = []; let start = 0;
  for (let i = 0; i < list.length; i++) {
    if (list[i].kind !== 'punct') continue;
    if (['(', '[', '{'].includes(list[i].value)) { i = closeAt(list, i); continue; }
    if (list[i].value === separator) { groups.push(list.slice(start, i)); start = i + 1; }
  }
  groups.push(list.slice(start)); return groups;
}

function jsValue(list, env, file) {
  if (!list.length) return null;
  while (list[0]?.value === '(' && closeAt(list, 0) === list.length - 1) list = list.slice(1, -1);
  if (list.at(-1)?.value === 'href' && list.at(-2)?.value === '.') list = list.slice(0, -2);
  if (list[0]?.value === 'new') list = list.slice(1);
  const key = list.map(item => item.value).join('');
  if (env.has(key)) return env.get(key);
  if (list.length === 1 && list[0].kind === 'string') return [list[0].value];
  if (list.length === 1 && list[0].kind === 'template') {
    let value = list[0].value, valid = true;
    value = value.replace(/\$\{([\w.]+)\}/g, (_, name) => {
      const bound = env.get(name);
      if (bound?.length === 1) return bound[0];
      valid = false; return '';
    });
    return valid && !value.includes('${') ? [value] : null;
  }
  const choices = splitTop(list, '?');
  if (choices.length === 2) {
    const branches = splitTop(choices[1], ':');
    if (branches.length === 2) return merge(branches.map(branch => jsValue(branch, env, file)));
  }
  const plus = splitTop(list, '+');
  if (plus.length > 1) return combine(plus.map(part => jsValue(part, env, file)), (a, b) => a + b);
  const open = list.findIndex(item => item.value === '(');
  if (open < 0 || closeAt(list, open) !== list.length - 1) return null;
  const name = list.slice(0, open).map(item => item.value).join('');
  const args = splitTop(list.slice(open + 1, -1), ',');
  const first = () => jsValue(args[0], env, file);
  if (['fileURLToPath', 'pathToFileURL'].includes(name)) return first();
  if (name === 'URL') {
    const relative = first(), base = jsValue(args[1] ?? [], env, file);
    if (!relative || !base) return null;
    return relative.flatMap(value => base.map(parent => normalize(path.posix.join(path.posix.dirname(parent), value))));
  }
  if (/^(?:path\.)?(?:join|resolve)$/.test(name)) return combine(args.map(arg => jsValue(arg, env, file)), (a, b) => normalize(path.posix.join(a, slash(b))));
  if (/^(?:path\.)?dirname$/.test(name)) return first()?.map(value => path.posix.dirname(value)) ?? null;
  return null;
}

function expressionEnd(list, start, source) {
  for (let i = start; i < list.length; i++) {
    if (list[i].kind === 'punct' && ['(', '[', '{'].includes(list[i].value)) { i = closeAt(list, i); continue; }
    if (list[i].kind === 'punct' && [',', ';', '}'].includes(list[i].value)) return i;
    if (i > start && source.slice(list[i - 1].end, list[i].at).includes('\n')) return i;
  }
  return list.length;
}

function jsBindings(list, source, file) {
  const roles = roleBindings(file), env = new Map(roles);
  // Bounded constant propagation, including aliases used later in spawn/execFile.
  for (let pass = 0; pass < 3; pass++) {
    const assignments = new Map();
    for (let i = 0; i < list.length - 2; i++) {
      if (list[i].kind !== 'word' || list[i + 1].value !== '=' || ['=', '>'].includes(list[i + 2].value) || list[i - 1]?.value === '.') continue;
      const key = list[i].value;
      let value = jsValue(list.slice(i + 2, expressionEnd(list, i + 2, source)), env, file);
      if (value === null && roles.has(key)) value = roles.get(key);
      value = assignments.has(key) ? merge([assignments.get(key), value]) : value;
      assignments.set(key, value); env.set(key, value);
    }
  }
  return env;
}

function psValue(list, start, env) {
  let i = start;
  // Type casts have no bearing on the symbolic path role.
  if (list[i]?.value === '[') i = closeAt(list, i) + 1;
  const token = list[i];
  if (!token) return {value: null, end: i};
  // Bare ./helper.ps1 and $PSScriptRoot\helper.ps1 are single PS path
  // arguments even though their punctuation is tokenized separately.
  if ((['.', '/', '\\'].includes(token.value) || token.value.startsWith('$')) &&
      list[i + 1]?.at === token.end && ['.', '/', '\\'].includes(list[i + 1].value)) {
    let end = i + 1;
    while (end < list.length && list[end - 1].end === list[end].at && ![')', '}', ']', ',', ';', '|'].includes(list[end].value)) end++;
    const suffix = list.slice(i + 1, end).map(item => item.value).join('');
    const base = token.value.startsWith('$') ? env.get(token.value.slice(1).toLowerCase()) ?? null : [token.value];
    return {value: base?.map(value => normalize(value + suffix)) ?? null, end};
  }
  if (token.value === '(') {
    const end = closeAt(list, i);
    return {value: psValue(list.slice(i + 1, end), 0, env).value, end: end + 1};
  }
  if (token.value.toLowerCase() === 'join-path') {
    i++; if (list[i]?.value === '-') i += 2;
    const left = psValue(list, i, env); i = left.end;
    if (list[i]?.value === '-') i += 2;
    const right = psValue(list, i, env);
    return {value: combine([left.value, right.value], (a, b) => normalize(path.posix.join(a, slash(b)))), end: right.end};
  }
  if (token.value.toLowerCase() === 'split-path') {
    i++; if (list[i]?.value === '-') i += 2;
    const part = psValue(list, i, env);
    return {value: part.value?.map(value => path.posix.dirname(value)) ?? null, end: part.end};
  }
  if (token.kind === 'string') return {value: [token.value], end: i + 1};
  if (codeFile.test(token.value) && !token.value.startsWith('$')) return {value: [token.value], end: i + 1};
  if (token.kind === 'template') {
    let valid = true;
    const value = token.value.replace(/\$\{?([\w.]+)\}?/g, (_, name) => {
      const bound = env.get(name.toLowerCase());
      if (bound?.length === 1) return bound[0];
      valid = false; return '';
    });
    return {value: valid ? [normalize(value)] : null, end: i + 1};
  }
  return {value: env.get(token.value.replace(/^\$/, '').toLowerCase()) ?? null, end: i + 1};
}

function dynamicCandidates(part, inventory) {
  const literals = part.filter(item => ['string', 'template'].includes(item.kind)).map(item => slash(item.value));
  const tails = literals.filter(value => /[\w-]+\.(?:[cm]?js|ps1|py|vbs|sh)$/.test(value) && !value.includes('${'))
    .map(value => value.replace(/^(?:\.\.?\/)+/, '').replace(/^\//, ''));
  if (tails.length) return inventory.filter(target => tails.some(tail => target === tail || target.endsWith('/' + tail)));
  const extensions = literals.map(value => value.match(/\.(?:[cm]?js|ps1|py|vbs|sh)$/)?.[0]).filter(Boolean);
  return inventory.filter(target => extensions.length ? extensions.some(extension => target.endsWith(extension)) : codeFile.test(target));
}

const defaultEntrypoints = [
  'execution/scripts/Run-HiddenPowerShell.vbs', 'execution/scripts/Start-UserScheduler.ps1',
  'observation/scripts/Start-NasShadowScheduler.ps1', 'observation/scripts/run-v1-engine.mjs',
  'observation/src/legacy-engine.mjs', 'observation/src/dashboard-server.mjs',
];

// An explicit historical decision needs positive evidence in addition to no
// production/manual reachability. Unknown or newly added files default to pending.
const historicalEvidence = new Map([
  ['observation/src/ownership-transition.mjs', '独立 V2 所有权切换模型；project-structure.md 保留旧迁移供回滚审计，只有测试/语法检查引用。'],
  ['observation/scripts/adopt-v2-checkin.mjs', '旧 V2 adoption 一次性迁移；project-structure.md 的迁移保留边界，未见现行入口或人工命令。'],
  ['observation/scripts/build-v1-adapter-catalog.mjs', '为旧独立 adapter 生成迁移目录；project-structure.md 保留旧 adapter 供审计，无现行入口。'],
  ['observation/scripts/import-v1-runtime.mjs', '旧 V1→V2 运行目录导入；project-structure.md 保留旧迁移供审计，无现行入口。'],
]);

function readInventory(root) {
  const files = new Map(), documents = new Map(), links = [];
  const walk = (relative, docs = false) => {
    const full = path.join(root, relative);
    if (!fs.existsSync(full)) return;
    if (fs.lstatSync(full).isSymbolicLink()) { links.push(relative); return; }
    if (fs.statSync(full).isDirectory()) {
      for (const entry of fs.readdirSync(full).sort()) walk(relative + '/' + entry, docs);
    } else if ((!docs || relative.endsWith('.md')) && (!relative.startsWith('tools/') || codeFile.test(relative))) (docs ? documents : files).set(relative, fs.readFileSync(full, 'utf8'));
  };
  for (const pkg of ['execution', 'observation']) {
    for (const directory of ['src', 'scripts', 'public']) walk(pkg + '/' + directory);
    walk(pkg + '/package.json');
    for (const name of ['AGENTS.md', 'README.md']) walk(pkg + '/' + name, true);
    walk(pkg + '/docs', true); walk(pkg + '/skills', true);
  }
  walk('tools'); walk('package.json');
  for (const name of ['Dockerfile', 'compose.nas.yaml', 'compose.worker.yaml']) walk('observation/' + name);
  for (const name of ['AGENTS.md', 'README.md']) walk(name, true);
  walk('docs', true);
  documents.delete('docs/module-status.md'); // The generated inventory cannot justify itself.
  return {files, documents, links};
}

export function analyzeRepository({root = path.resolve(fileURLToPath(new URL('..', import.meta.url))), entrypoints} = {}) {
  root = path.resolve(root);
  const {files, documents, links} = readInventory(root);
  const inventory = unique([...files.keys(), ...links].filter(inScope));
  const edges = [], unresolved = [], npmScripts = [], deploymentMappings = [];
  const mappingRanges = [];
  const releaseSource = files.get('tools/release-lib.mjs') ?? '';
  for (const match of releaseSource.matchAll(/\[\s*['"](operations\/[^'"]+)['"]\s*,\s*['"]([^'"]+)['"]\s*\]/g)) {
    deploymentMappings.push({runtime: match[1], source: match[2]});
    mappingRanges.push([match.index, match.index + match[0].length]);
  }
  const mappedSources = new Map(deploymentMappings.map(item => [item.runtime, item.source]));
  const seeds = new Map((entrypoints ?? defaultEntrypoints).filter(file => files.has(file)).map(file => [file, '生产入口（架构调用链）']));
  const manualSeeds = new Map();
  const edge = (from, to, kind, at, source) => {
    to = normalize(to);
    // operationsRoot aliases observationRoot for source analysis, except the
    // hidden launcher, whose canonical source is the execution package.
    if (!files.has(to) && to.startsWith('observation/')) to = mappedSources.get('operations/' + to.slice('observation/'.length)) ?? to;
    if (files.has(to)) edges.push({from, to, kind, line: lineAt(source, at)});
    else unresolved.push({from, line: lineAt(source, at), kind, reason: '仓库内无对应文件；不读取运行副本', candidates: [to]});
  };
  const unknown = (from, kind, at, source, reason, candidates = []) => unresolved.push({from, line: lineAt(source, at), kind, reason, candidates: unique(candidates)});
  const resolve = (from, value, kind, at, source, relative = false) => {
    value = slash(value).split(/[?#]/)[0];
    if (/^(?:node:|[a-z]+:|\/\/)/i.test(value)) return;
    if (value.startsWith('/app/')) { value = 'observation/' + value.slice('/app/'.length); relative = false; }
    else if (value.startsWith('/') && !from.includes('/public/')) {
      const candidates = inventory.filter(file => file.endsWith(value));
      if (kind === 'literal-script' && !candidates.length && value.endsWith('.js')) return; // remote page asset suffix
      if (candidates.length === 1 && kind === 'literal-script') value = candidates[0];
      else { unknown(from, kind, at, source, '绝对脚本路径不在可确认的仓库映射内', candidates); return; }
    }
    if (!relative && !codeFile.test(value) && !assetFile.test(value)) return;
    if (relative && !value.startsWith('.') && !value.startsWith('/')) return; // external npm dependency
    if (relative) value = value.startsWith('/') && from.includes('/public/') ? packageOf(from) + '/public' + value : path.posix.join(path.posix.dirname(from), value);
    else if (!/^(?:execution|observation|tools)\//.test(value)) {
      const local = normalize(path.posix.join(path.posix.dirname(from), value));
      const pkgPath = normalize(path.posix.join(packageOf(from), value));
      if (files.has(local)) value = local;
      else if (files.has(pkgPath)) value = pkgPath;
      else {
        const candidates = inventory.filter(file => file.endsWith('/' + value));
        if (candidates.length === 1) value = candidates[0];
        else { unknown(from, kind, at, source, '路径根或目标不唯一', candidates); return; }
      }
    }
    edge(from, value, kind, at, source);
  };

  for (const [file, source] of files) {
    if (/^tools\/(?:release[^/]*\.mjs|doctor\.mjs|nas-runtime\.mjs)$/.test(file) && !entrypoints) seeds.set(file, '发布/体检映射入口');
    if (/\.[cm]?js$/.test(file)) {
      const list = tokens(source), env = jsBindings(list, source, file), importSpecifiers = new Set();
      const pathExpressions = [];
      for (let i = 0; i < list.length; i++) {
        const token = list[i], next = list[i + 1];
        if (token.kind === 'word' && ['import', 'export'].includes(token.value) && list[i - 1]?.value !== '.' && next) {
          if (token.value === 'import' && next.value === '(') {
            const end = closeAt(list, i + 1);
            if (list[end + 1]?.value === '{') continue; // object method named import
            const argument = splitTop(list.slice(i + 2, end), ',')[0];
            if (argument.length === 1) importSpecifiers.add(argument[0].at);
            const values = jsValue(argument, env, file);
            if (values) for (const value of values) resolve(file, value, 'esm-dynamic', token.at, source, argument.length === 1);
            else {
              unknown(file, 'esm-dynamic', token.at, source, '动态 import 无法静态求值', dynamicCandidates(argument, inventory));
            }
          } else if (token.value === 'import' && next.kind === 'string') { importSpecifiers.add(next.at); resolve(file, next.value, 'esm-static', token.at, source, true); }
          else if (next.value !== '.' && (token.value === 'import' || ['{', '*'].includes(next.value))) {
            for (let j = i + 1; j < list.length && list[j].value !== ';'; j++) {
              if (list[j].kind === 'word' && list[j].value === 'from' && list[j + 1]?.kind === 'string') {
                importSpecifiers.add(list[j + 1].at);
                resolve(file, list[j + 1].value, 'esm-static', token.at, source, true); break;
              }
            }
          }
        }
        if (file === 'tools/module-reachability.mjs') continue; // Its inventory/policy strings are data, not execution edges.
        if (token.kind === 'template' && /\bimport\s*\(/.test(token.value)) unknown(file, 'esm-dynamic', token.at, source, '模板表达式内的 import 须人工核对', inventory.filter(target => codeFile.test(target)));
        if (token.kind === 'word' && (token.value === 'path' && list[i + 1]?.value === '.' && ['join', 'resolve'].includes(list[i + 2]?.value) || token.value === 'URL' && next?.value === '(')) {
          const open = token.value === 'path' ? i + 3 : i + 1;
          if (list[open]?.value !== '(') continue;
          const end = closeAt(list, open), part = list.slice(i, end + 1);
          if (!part.some(item => ['string', 'template'].includes(item.kind) && codeFile.test(item.value))) continue;
          const values = jsValue(part, env, file);
          if (values) { for (const value of values) resolve(file, value, 'node-path', token.at, source); pathExpressions.push([token.at, list[end]?.end]); }
          else unknown(file, 'node-path', token.at, source, '脚本路径含未绑定变量', dynamicCandidates(part, inventory));
        }
      }
      // Script helper functions and spawn argument arrays also carry literal
      // paths. This is conservative text reachability, not proof of execution.
      for (const token of list.filter(item => file !== 'tools/module-reachability.mjs' && item.kind === 'string' && (codeFile.test(item.value) || file.includes('/public/') && assetFile.test(item.value)))) {
        if (importSpecifiers.has(token.at)) continue;
        if (file === 'tools/release-lib.mjs' && mappingRanges.some(([start, end]) => token.at >= start && token.end <= end)) continue;
        if (pathExpressions.some(([start, end]) => token.at >= start && token.end <= end)) continue;
        if (token.value.startsWith('operations/')) continue; // release destination, recorded separately below
        if (/^[\w./-]+\.(?:[cm]?js|ps1|py|vbs|sh|css|html)$/.test(token.value)) resolve(file, token.value, 'literal-script', token.at, source);
        for (const match of token.value.matchAll(/\/app\/((?:src|scripts)\/[\w./-]+\.[cm]?js)/g)) resolve(file, 'observation/' + match[1], 'nas-command', token.at, source);
      }
      for (let i = 0; i < list.length - 1; i++) {
        if (!/^(?:spawn(?:Sync|Child|Health)?|execFile(?:Sync)?)$/.test(list[i].value) || list[i + 1].value !== '(' || file === 'tools/module-reachability.mjs') continue;
        const end = closeAt(list, i + 1), args = splitTop(list.slice(i + 2, end), ',').slice(0, 2);
        // A fully bounded script path in a command or its argument array is
        // captured above. Generic wrappers and configurable commands stay visible.
        const hasScript = args.flat().some(token => token.kind === 'string' && codeFile.test(token.value) ||
          token.kind === 'word' && env.get(token.value)?.some(value => codeFile.test(value)));
        const first = jsValue(args[0] ?? [], env, file);
        if (!hasScript && !(first?.every(value => /^(?:git|tar|ssh|scp|docker|taskkill|cmd)(?:\.exe)?$/i.test(value)))) unknown(file, 'node-process', list[i].at, source, '子进程命令/参数由函数或配置提供，不能静态展开');
      }
    } else if (file.endsWith('.ps1')) {
      const list = tokens(source, true), roles = roleBindings(file), env = new Map(roles);
      for (let pass = 0; pass < 3; pass++) {
        const assignments = new Map();
        for (let i = 0; i < list.length - 2; i++) {
          if (!list[i].value.startsWith('$') || list[i + 1].value !== '=') continue;
          const key = list[i].value.slice(1).toLowerCase();
          let {value} = psValue(list, i + 2, env);
          if (value === null && roles.has(key)) value = roles.get(key);
          value = assignments.has(key) ? merge([assignments.get(key), value]) : value;
          assignments.set(key, value); env.set(key, value);
        }
      }
      for (let i = 0; i < list.length; i++) {
        const token = list[i], isJoin = token.value.toLowerCase() === 'join-path';
        const next = list[i + 1];
        const isDot = token.value === '.' && (token.at === 0 || /\s/.test(source[token.at - 1])) &&
          (next?.value.startsWith('$') || ['(', '.', '/', '\\'].includes(next?.value) || codeFile.test(next?.value ?? '') || ['string', 'template'].includes(next?.kind));
        const isCall = isDot || token.value === '&' && next?.value !== '&';
        if (!isJoin && !isCall) continue;
        const start = isJoin ? i : i + 1, result = psValue(list, start, env);
        const part = list.slice(start, result.end);
        const scriptHint = part.some(item => codeFile.test(item.value) || /^\$(?!PSScriptRoot$|PSCommandPath$)[\w:]*?(?:script|worker|launcher|cli|entry)(?:path)?$/i.test(item.value));
        if (result.value) for (const value of result.value) {
          if (codeFile.test(value)) resolve(file, value, isJoin ? 'ps-join' : 'ps-call', token.at, source);
        } else if (isDot || scriptHint) {
          unknown(file, isJoin ? 'ps-join' : 'ps-call', token.at, source, 'PowerShell 动态脚本路径未解析', inventory.filter(target => part.some(item => item.kind === 'string' && codeFile.test(item.value) && target.endsWith('/' + slash(item.value)))));
        }
      }
    } else if (file.endsWith('.py')) {
      for (const match of source.matchAll(/^\s*(?:from\s+(\.*[\w.]+)\s+import|import\s+([\w.]+))/gm)) {
        const name = match[1] ?? match[2], local = normalize(path.posix.join(path.posix.dirname(file), name.replace(/^\./, '').replaceAll('.', '/') + '.py'));
        if (files.has(local)) edge(file, local, 'python-import', match.index, source);
      }
      for (const match of source.matchAll(/\b(?:import_module|__import__|(?:subprocess\.)?(?:Popen|run|call))\s*\(/g)) unknown(file, 'python-dynamic', match.index, source, 'Python 动态装载/子进程须人工核对');
    } else if (/\.(?:html|css)$/.test(file)) {
      for (const match of source.matchAll(/(?:\b(?:src|href)\s*=\s*["']|@import\s*["']|url\(\s*["']?)([^"'\s)]+)/g)) {
        if (!match[1].startsWith('#') && !/^(?:https?:|data:)/.test(match[1])) resolve(file, match[1].startsWith('/') ? '.' + match[1] : match[1], 'public-asset', match.index, source, true);
      }
    }
  }

  // Deployment mapping is availability, never an edge to every shipped module.
  if (files.has('observation/src/dashboard-server.mjs') && files.has('observation/public/index.html')) edge('observation/src/dashboard-server.mjs', 'observation/public/index.html', 'dashboard-assets', 0, '');
  for (const file of ['observation/Dockerfile', 'observation/compose.nas.yaml', 'observation/compose.worker.yaml']) {
    const source = files.get(file) ?? '';
    for (const match of source.matchAll(/(?:\/app\/|\.\/)?((?:src|scripts)\/[\w./-]+\.[cm]?js)/g)) if (files.has('observation/' + match[1]) && !entrypoints) seeds.set('observation/' + match[1], 'NAS 容器入口 ' + file);
  }
  for (const pkg of ['.', 'execution', 'observation']) {
    const packageFile = pkg === '.' ? 'package.json' : pkg + '/package.json';
    if (!files.has(packageFile)) continue;
    const scripts = JSON.parse(files.get(packageFile)).scripts ?? {};
    for (const [name, command] of Object.entries(scripts)) {
      const targets = [];
      for (const segment of command.split(/&&|\|\||;/)) for (const match of segment.matchAll(/(?:^|\s)['"]?((?:tools|src|scripts|public)\/[\w./*-]+\.(?:[cm]?js|ps1|py))/g)) {
        const target = normalize(path.posix.join(pkg, match[1]));
        const checkOnly = /(?:^|\s)(?:--check|--test)\s/.test(segment.slice(0, match.index + match[0].length));
        targets.push({file: target, checkOnly});
        if (files.has(target) && !checkOnly && !entrypoints) {
          if (['start', 'dashboard', 'shadow', 'bridge'].includes(name)) seeds.set(target, 'npm 生产脚本 ' + packageFile + ':' + name);
          else manualSeeds.set(target, 'npm 人工命令 ' + packageFile + ':' + name);
        }
      }
      npmScripts.push({package: packageFile, name, targets});
    }
  }
  const dedupEdges = [...new Map(edges.map(item => [JSON.stringify(item), item])).values()].sort((a, b) => a.from.localeCompare(b.from) || a.line - b.line || a.to.localeCompare(b.to));
  const outgoing = new Map();
  for (const item of dedupEdges) outgoing.set(item.from, [...outgoing.get(item.from) ?? [], item]);
  const walk = seedMap => {
    const reached = new Map(seedMap), pending = [...seedMap.keys()];
    for (let i = 0; i < pending.length; i++) for (const item of outgoing.get(pending[i]) ?? []) if (!reached.has(item.to)) {
      reached.set(item.to, item.from + ':' + item.line + ' (' + item.kind + ')'); pending.push(item.to);
    }
    return reached;
  };
  const active = walk(seeds);
  const uniqueUnknown = [...new Map(unresolved.map(item => [JSON.stringify(item), item])).values()].sort((a, b) => a.from.localeCompare(b.from) || a.line - b.line || a.kind.localeCompare(b.kind));
  for (const file of inventory) {
    if (active.has(file) || manualSeeds.has(file)) continue;
    const name = path.posix.basename(file);
    const doc = [...documents].find(([document, source]) => !/migration-phases|glossary/.test(document) &&
      source.split('\n').some(line => line.includes(name) && /\b(?:node|pwsh|powershell|python|npm)\b|scripts[/\\]|`src\//i.test(line)));
    if (doc) manualSeeds.set(file, '人工用法见 ' + doc[0]);
    else if (/^(?:Install-|Initialize-|Remove-|Test-|Manage-|Set-|Get-|Open-|Close-|Recover-|Protect-|Clear-|Cleanup-|Ensure-|Scan-|Export-|Read-|Backup-)/.test(name) || /^(?:archive-history|preview-dashboard|deploy-nas-code|verify-|check-|audit-migration)/.test(name)) manualSeeds.set(file, '安装/恢复/诊断人工工具；用途由文件入口实现确认。');
  }
  const manual = walk(manualSeeds);
  const uncertain = new Set(uniqueUnknown.filter(item => active.has(item.from) || manual.has(item.from)).flatMap(item => item.candidates));
  const records = inventory.map(file => {
    if (links.includes(file)) return {file, status: '待确认', reason: '符号链接未跟随，目标不在本次只读分析范围。'};
    if (active.has(file)) return {file, status: '现役', reason: active.get(file)};
    if (uncertain.has(file)) return {file, status: '待确认', reason: '处于未解析动态引用的候选范围，不能证明不可达。'};
    if (manual.has(file)) return {file, status: '运维手动', reason: manual.get(file)};
    if (historicalEvidence.has(file)) return {file, status: '历史审计', reason: historicalEvidence.get(file)};
    return {file, status: '待确认', reason: file === 'observation/src/scheduler.mjs' ? '当前文本仅见测试和 lint:domain 语法检查，生产调用待核实，暂不迁移。' : '未见生产可达或明确人工用途；缺少足够的退役依据。'};
  });
  return {
    schemaVersion: 1, records, counts: Object.fromEntries(['现役', '运维手动', '历史审计', '待确认'].map(status => [status, records.filter(item => item.status === status).length])),
    entrypoints: [...seeds].map(([file, reason]) => ({file, reason})), edges: dedupEdges,
    unresolved: uniqueUnknown.map(item => ({...item, reachable: active.has(item.from), manual: manual.has(item.from)})),
    npmScripts, deploymentMappings, skippedLinks: links,
  };
}

export function renderModuleStatus(report) {
  const lines = [
    '# 模块状态（只标记，不移动）', '',
    '重新生成：在仓库根运行 `node tools/module-reachability.mjs`，将标准输出保存为本文件；用 `node tools/module-reachability.mjs --check` 校验，用 `--json` 查看逐边、npm 脚本及发布映射。脚本本身只读，不执行被分析代码、不读取运行根或私有配置。', '',
    '范围：两个包的 `src/`、`scripts/`、`public/` 全部普通文件。现役表示从受管生产入口在文本调用图中可达，包含条件分支，不表示现场启用；npm 的诊断/演练命令作为人工入口，`--check` 不构成运行依赖。发布清单只证明文件被分发，不能把整个清单视为现役。', '',
    '路径角色依据 `docs/architecture.md`：legacy/执行根映射 `execution/`，控制/观测及兼容 operations 根映射 `observation/`，`plan.source` 为仓库根。变量传播只处理有界字面量、路径拼接、URL 包装和条件分支；无法求值或仓库外钩子逐项保留。新增未知文件默认待确认。历史分类是退役审查依据，不授权迁移或删除。', '',
    '| 类别 | 文件数 |', '| --- | ---: |',
    ...Object.entries(report.counts).map(([status, count]) => `| ${status} | ${count} |`), '',
    '## 四个基准模块核对', '',
    '| 模块 | 当前判定 | 核对依据 |', '| --- | --- | --- |',
    ...['scheduler', 'notification-delivery', 'runtime-config', 'shadow-acceptance'].map(name => {
      const record = report.records.find(item => item.file === 'observation/src/' + name + '.mjs');
      return record ? `| \`${name}.mjs\` | ${record.status} | ${record.reason} |` : null;
    }).filter(Boolean), '',
    '这四个模块名字看着旧，过去的记录把它们都当作现役。当前 scheduler 仅见测试和语法检查，notification-delivery 可由 npm 人工通知刷新命令到达，未找到两者的生产调用链。不把它们强行标为现役，也不建议迁移。', '',
    '## 生产入口', '',
    ...report.entrypoints.map(item => `- \`${item.file}\`：${item.reason}`), '',
    '## 逐文件分类', '', '| 文件 | 类别 | 依据 |', '| --- | --- | --- |',
    ...report.records.map(item => `| \`${item.file}\` | ${item.status} | ${item.reason.replaceAll('|', '\\|')} |`), '',
    '## 未解析引用', '',
    '下表包含人工工具的动态边界；“生产”列仅指调用方可达。候选为空表示目标/命令无法由文本确定，不能用它证明某个文件已退役；JSON 保留完整候选集合。', '',
    '| 调用位置 | 类型 | 生产 | 未解析依据 / 有界候选 |', '| --- | --- | --- | --- |',
    ...report.unresolved.map(item => `| \`${item.from}:${item.line}\` | ${item.kind} | ${item.reachable ? '是' : '否'} | ${item.reason}${item.candidates.length && item.candidates.length <= 3 ? '；' + item.candidates.map(file => '\`' + file + '\`').join('、') : item.candidates.length ? '；候选 ' + item.candidates.length + ' 个（见 JSON）' : ''} |`), '',
    '## 结构围栏', '',
    '`observation/scripts/check-structure.mjs` 读取本表已审阅的“历史审计”集合，再检查当前生产可达文件的静态/动态 import（含 re-export）。新 import 即使让目标变得可达，也不会自动撤销历史禁入；先处理引用和退役审查，再显式更新分类。现有历史 import 例外白名单为空；新增例外必须逐边写明原因。', '',
    `发布兼容映射：${report.deploymentMappings.map(item => '\`' + item.runtime + '\` → \`' + item.source + '\`').join('；') || '无'}。`, '',
  ];
  if (!report.unresolved.length) lines.splice(lines.indexOf('## 结构围栏') - 1, 0, '| — | — | — | 无 |', '');
  return lines.join('\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  if (args.some(arg => !['--json', '--check'].includes(arg))) throw Error('usage: node tools/module-reachability.mjs [--json|--check]');
  const root = fileURLToPath(new URL('..', import.meta.url));
  const report = analyzeRepository({root}), rendered = renderModuleStatus(report);
  if (args.includes('--check')) {
    const target = path.join(root, 'docs/module-status.md');
    if (!fs.existsSync(target) || fs.readFileSync(target, 'utf8').replaceAll('\r', '') !== rendered) {
      console.error('Module inventory is stale: regenerate docs/module-status.md and review historical decisions.'); process.exitCode = 1;
    } else console.log('Module inventory is current: ' + report.records.length + ' files');
  } else process.stdout.write(args.includes('--json') ? JSON.stringify(report, null, 2) + '\n' : rendered);
}
