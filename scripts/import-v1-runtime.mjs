#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import {loadEffectiveConfig} from '../src/effective-config.mjs';
import {buildV1AdapterCatalog} from '../src/v1-adapter-catalog.mjs';
import {importV1Runtime} from '../src/v1-runtime-import.mjs';

const root=process.argv[2]??process.env.CHECKIN_LEGACY_ROOT;
if(!root) throw Error('provide V1 root');
const config=loadEffectiveConfig(root);
const plan=JSON.parse(fs.readFileSync(path.join(root,'data','last-valid-bookmark-plan.json'),'utf8'));
const catalog=buildV1AdapterCatalog({config,plan});
const output=process.argv[3]??'outputs/v1-runtime-import.json';
fs.writeFileSync(output,JSON.stringify(importV1Runtime({config,v1Catalog:catalog}),null,2),'utf8');
console.log(`V1 metadata imported: ${output}`);
