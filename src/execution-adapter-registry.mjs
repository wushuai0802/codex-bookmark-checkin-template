import {createNewApiExecutionAdapter} from './new-api-execution-adapter.mjs';

const factories=new Map([
  ['new-api.execute.v1',createNewApiExecutionAdapter]
]);

export function executionAdapterDefinitions() {
  return [
    {id:'new-api.execute.v1',family:'标准 New API',status:'implemented',requires:['identity','read_status','submit_once','verify'],canaryReady:false},
    {id:'oauth-reward.execute.v1',family:'OAuth 奖励日志',status:'planned',requires:['identity','read_status','recover_session','submit_once','verify'],canaryReady:false},
    {id:'pt-native.execute.v1',family:'PT 原生签到',status:'planned',requires:['identity','read_status','submit_once','verify'],canaryReady:false},
    {id:'anyrouter.execute.v1',family:'AnyRouter 动态线路',status:'planned',requires:['route_probe','identity','read_status','submit_once','verify'],canaryReady:false}
  ];
}

export function createExecutionAdapter({adapterId,origin,rule} = {}) {
  const factory=factories.get(adapterId);
  if(!factory) throw Error(`execution adapter unavailable: ${adapterId}`);
  return factory({origin,rule});
}

export function adapterBindingForSite({origin,familyId} = {}) {
  if(familyId==='new-api-calendar.v1') return {origin,adapterId:'new-api.execute.v1',canaryReady:false};
  if(familyId==='oauth-reward-log.v1') return {origin,adapterId:'oauth-reward.execute.v1',canaryReady:false};
  if(familyId==='native-pt.v1') return {origin,adapterId:'pt-native.execute.v1',canaryReady:false};
  return {origin,adapterId:null,canaryReady:false,blockedReason:'family_not_implemented'};
}
