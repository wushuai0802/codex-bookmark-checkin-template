import assert from 'node:assert/strict';
import test from 'node:test';
import {siteDisplayName} from '../src/display-identity.mjs';
import {buildPtStatus} from '../src/pt-status.mjs';

test('the PT site display name is canonical across bookmarks and Harvest, without changing identity',()=>{
  const origin='https://ptsbao.club';
  assert.equal(siteDisplayName(origin,'PT宝签到'),'骚包');
  assert.equal(siteDisplayName(origin,'烧包乐园'),'骚包');
  assert.equal(siteDisplayName('https://another.example','Another PT'),'Another PT');
  const status=buildPtStatus({generatedAt:'2026-10-01T02:00:00Z',businessDate:'2026-10-01',
    monitorCatalog:{sites:[{origin,displayName:'PT宝签到'}]},externalReport:{source:'harvest',businessDate:'2026-10-01',generatedAt:'2026-10-01T02:00:00Z',
      sites:[{origin,displayName:'烧包乐园',status:'unknown',observedAt:null,evidence:{source:'none',authoritative:false}}]}});
  assert.equal(status.sites[0].origin,origin);assert.equal(status.sites[0].displayName,'骚包');
  assert.equal(status.sites[0].effective.authoritative,false);
});
