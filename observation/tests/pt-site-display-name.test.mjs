import assert from 'node:assert/strict';
import test from 'node:test';
import {siteDisplayName} from '../src/display-identity.mjs';
import {buildPtStatus} from '../src/pt-status.mjs';
import {siteTitle,matchesTask} from '../public/dashboard-model.mjs';

test('the PT site display name is canonical across bookmarks and Harvest, without changing identity',()=>{
  const origin='https://ptsbao.club';
  assert.equal(siteDisplayName(origin,'示例站点'),'烧包');
  assert.equal(siteDisplayName(origin,'示例旧名'),'烧包');
  assert.equal(siteDisplayName(origin,'示例站点扩展名'),'烧包');
  assert.equal(siteDisplayName('https://another.example','Another PT'),'Another PT');
  const historical={origin,displayName:'示例旧名',observedStatus:'already_signed'};
  assert.equal(siteTitle(historical),'烧包');
  assert.equal(matchesTask(historical,{query:'烧包'}),true);
  assert.equal(matchesTask(historical,{query:'示例旧名'}),true);
  const status=buildPtStatus({generatedAt:'2026-10-01T02:00:00Z',businessDate:'2026-10-01',
    monitorCatalog:{sites:[{origin,displayName:'示例站点'}]},externalReport:{source:'harvest',businessDate:'2026-10-01',generatedAt:'2026-10-01T02:00:00Z',
      sites:[{origin,displayName:'示例站点扩展名',status:'unknown',observedAt:null,evidence:{source:'none',authoritative:false}}]}});
  assert.equal(status.sites[0].origin,origin);assert.equal(status.sites[0].displayName,'烧包');
  assert.equal(status.sites[0].effective.authoritative,false);
});
