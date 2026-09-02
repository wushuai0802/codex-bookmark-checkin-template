#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
if (output === projectRoot || output.startsWith(`${projectRoot}${path.sep}src${path.sep}`) || output.startsWith(`${projectRoot}${path.sep}public${path.sep}`)) {
  throw new Error('refusing to export over project source');
}
fs.rmSync(output, { recursive: true, force: true });
fs.mkdirSync(output, { recursive: true });
for (const name of ['Dockerfile', 'compose.nas.yaml', '.dockerignore', 'package.json', 'package-lock.json']) copyRequired(path.join(projectRoot, name), path.join(output, name));
for (const directory of ['src', 'public']) copyRequired(path.join(projectRoot, directory), path.join(output, directory));
fs.mkdirSync(path.join(output, 'nas-data'), { recursive: true });
fs.writeFileSync(path.join(output, 'nas-data', '.gitkeep'), '', 'utf8');
fs.mkdirSync(path.join(output, 'secrets'), { recursive: true });
copyRequired(path.join(projectRoot, 'secrets', 'README.md'), path.join(output, 'secrets', 'README.md'));
fs.writeFileSync(path.join(output, 'TRANSFER-MANIFEST.txt'), [
  'codex-checkin-fabric-v2 NAS bundle',
  'Contains only application source and empty data/secret directories.',
  'Copy redacted shadow-beta-snapshot.json and shadow-ledger.jsonl into nas-data/.',
  'Create secrets/fabric_admin_token.txt on the NAS; never copy credentials or browser profiles.',
  ''
].join('\n'), 'utf8');
console.log(`NAS bundle exported: ${output}`);
