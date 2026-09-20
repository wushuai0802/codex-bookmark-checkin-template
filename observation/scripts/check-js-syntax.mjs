#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';

const root=path.resolve('.'),directories=['src','scripts','public'],files=[];
for(const directory of directories){const base=path.join(root,directory);if(!fs.existsSync(base))continue;const walk=dir=>{for(const entry of fs.readdirSync(dir,{withFileTypes:true})){const file=path.join(dir,entry.name);if(entry.isDirectory())walk(file);else if(entry.name.endsWith('.mjs')||entry.name.endsWith('.js'))files.push(file);}};walk(base);}
for(const file of files.sort()){const result=spawnSync(process.execPath,['--check',file],{encoding:'utf8'});if(result.status!==0){process.stderr.write(result.stderr||`syntax check failed: ${file}\n`);process.exit(result.status??1);}}
console.log(`JavaScript syntax check passed: ${files.length} files`);
