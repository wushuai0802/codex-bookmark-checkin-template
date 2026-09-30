import test from 'node:test';
import assert from 'node:assert/strict';
import {siteIdentityIndex} from '../src/site-identity-index.mjs';
test('one PT classification preserves compatibility sources and never adopts Harvest IDs',()=>{
  const index=siteIdentityIndex({catalog:{sites:[{origin:'https://open.cd',userId:'999'},{origin:'https://new-pt.example'}]},
    planTargets:[{origin:'https://open.cd',folderNames:['公益站']},{origin:'https://service.example',accountKey:'first'},
      {origin:'https://service.example',accountKey:'second'}]});
  assert.equal(index.get('https://open.cd').kind,'pt');
  assert.deepEqual(index.get('https://open.cd').accountKeys,['site-default']);
  assert.equal(index.get('https://open.cd').targets[0].folderNames[0],'公益站');
  assert.equal(index.get('https://new-pt.example').monitored,true);
  assert.equal(index.get('https://service.example').kind,'service');
  assert.equal(index.get('https://service.example').ambiguous,true);
});
