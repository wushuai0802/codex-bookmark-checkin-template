import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {loadRuntimeConfig} from '../src/runtime-config.mjs';

test('local runtime paths stay outside tracked source',()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'runtime-config-'));fs.mkdirSync(path.join(root,'config'));const legacy=path.join(root,'legacy'),chrome=path.join(root,'chrome.exe');fs.writeFileSync(path.join(root,'config','runtime.local.json'),JSON.stringify({legacyRoot:legacy,chromeExecutable:chrome,canaryTime:'07:50'}));
  const value=loadRuntimeConfig(root);assert.equal(value.legacyRoot,path.resolve(legacy));assert.equal(value.canaryTime,'07:50');
});
