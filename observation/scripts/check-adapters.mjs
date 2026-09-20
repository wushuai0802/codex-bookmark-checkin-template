#!/usr/bin/env node
import {createExecutionAdapter,executionAdapterDefinitions} from '../src/execution-adapter-registry.mjs';

const origins={
  'new-api.execute.v1':'https://adapter-fixture.example',
  'new-api-captcha.execute.v1':'https://captcha-fixture.example',
  'oauth-reward.execute.v1':'https://oauth-fixture.example',
  'oauth-api.execute.v1':'https://oauth-api-fixture.example',
  'pt-native.execute.v1':'https://pt-fixture.example',
  'anyrouter.execute.v1':'https://anyrouter.top',
  'vibe-entitlement.execute.v1':'https://vibe-fixture.example'
};
const required=['identity','read_status','submit_once','verify','classify_error'];
const checked=[];
for(const definition of executionAdapterDefinitions()){
  const adapter=createExecutionAdapter({adapterId:definition.id,origin:origins[definition.id]});
  for(const method of required)if(typeof adapter.methods[method]!=='function')throw Error(definition.id+' missing '+method);
  checked.push({id:adapter.id,origin:adapter.origin,mutating:adapter.mutating});
}
console.log(JSON.stringify({checked:checked.length,adapters:checked},null,2));
