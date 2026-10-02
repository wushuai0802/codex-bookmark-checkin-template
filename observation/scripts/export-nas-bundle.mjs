#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {execFileSync} from 'node:child_process';
import {releaseInfo} from '../src/release-info.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv) {
  const args = { out: path.join(projectRoot, 'outputs', 'nas-bundle') };
  for (let i = 2; i < argv.length; i += 1) {
    if (argv[i] === '--out') args.out = argv[++i];
    else if (argv[i] === '--help' || argv[i] === '-h') args.help = true;
    else throw new Error(`unknown argument: ${argv[i]}`);
  }
  return args;
}

function copyRequired(source, destination) {
  if (!fs.existsSync(source)) throw new Error(`required bundle source is missing: ${source}`);
  fs.cpSync(source, destination, { recursive: true, force: true });
}

const args = parseArgs(process.argv);
if (args.help) {
  console.log('Usage: npm run export:nas -- [--out <directory>]');
  process.exit(0);
}
const output = path.resolve(args.out);
const outputsRoot=path.join(projectRoot,'outputs');
if (output === outputsRoot || !output.startsWith(`${outputsRoot}${path.sep}`)) throw new Error('NAS bundle output must be a dedicated subdirectory of outputs');
fs.rmSync(output, { recursive: true, force: true });
fs.mkdirSync(output, { recursive: true });
for (const name of ['Dockerfile', 'compose.nas.yaml', 'compose.worker.yaml', '.dockerignore', 'package.json', 'package-lock.json']) copyRequired(path.join(projectRoot, name), path.join(output, name));
for (const directory of ['src', 'public']) copyRequired(path.join(projectRoot, directory), path.join(output, directory));
const release=releaseInfo();
let revision=release.revision;
if(!revision)try{revision=execFileSync('git',['rev-parse','HEAD'],{cwd:projectRoot,encoding:'utf8'}).trim();}catch{}
fs.writeFileSync(path.join(output,'release.json'),JSON.stringify({version:release.version,revision,deployedAt:new Date().toISOString()}));
fs.mkdirSync(path.join(output, 'nas-data'), { recursive: true });
fs.writeFileSync(path.join(output, 'nas-data', '.gitkeep'), '', 'utf8');
fs.mkdirSync(path.join(output, 'secrets'), { recursive: true });
copyRequired(path.join(projectRoot, 'secrets', 'README.md'), path.join(output, 'secrets', 'README.md'));
fs.writeFileSync(path.join(output, 'TRANSFER-MANIFEST.txt'), [
  'Check-in Fabric NAS bundle',
  'Contains only application source and empty data/secret directories.',
  'compose.worker.yaml is included as an opt-in transport overlay; it does not enable execution by itself.',
  'Publish shadow-ledger.jsonl first, then shadow-beta-snapshot.json, and dashboard-generation.json last.',
  'Retain dashboard-generation.previous.json; all generation files must refer to the same ledger prefix.',
  'release.json identifies this code bundle and contains no private runtime paths.',
  'Create secrets/fabric_admin_token.txt on the NAS; never copy credentials or browser profiles.',
  ''
].join('\n'), 'utf8');
console.log(`NAS bundle exported: ${output}`);
