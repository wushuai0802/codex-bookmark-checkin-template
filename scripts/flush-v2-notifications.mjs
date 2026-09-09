#!/usr/bin/env node
import path from 'node:path';
import {flushV2Notifications} from '../src/v2-notification-flush.mjs';
import {loadRuntimeConfig} from '../src/runtime-config.mjs';

try {
  const root=path.resolve('.'),runtime=loadRuntimeConfig(root),result=await flushV2Notifications({root,legacyRoot:runtime.legacyRoot});
  console.log(JSON.stringify(result));
  if(result.pending>0||result.invalid>0)process.exitCode=2;
} catch(error) { console.error(`V2 notification flush error: ${error.message}`);process.exitCode=1; }
