import test from 'node:test';
import assert from 'node:assert/strict';
import {closeNativeBrowser} from '../src/isolated-browser-worker.mjs';
test('native browser closes Chrome before disconnecting CDP',async()=>{
  const calls=[],child={exitCode:null,signalCode:null,kill(){throw Error('must not force kill');}};
  const browser={newBrowserCDPSession:async()=>({send:async method=>{calls.push(method);child.exitCode=0;}}),close:async()=>{calls.push('disconnect');}};
  await closeNativeBrowser({browser,child});assert.deepEqual(calls,['Browser.close','disconnect']);
});
