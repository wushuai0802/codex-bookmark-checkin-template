import fs from 'node:fs';
import path from 'node:path';

export function loadRuntimeConfig(root=path.resolve('.')) {
  const file=path.join(path.resolve(root),'config','runtime.local.json');
  let local={};
  if(fs.existsSync(file)){local=JSON.parse(fs.readFileSync(file,'utf8'));if(!local||typeof local!=='object'||Array.isArray(local))throw Error('runtime.local.json is invalid');}
  const legacyRoot=process.env.CHECKIN_LEGACY_ROOT??local.legacyRoot??null;
  const chromeExecutable=process.env.CHECKIN_CHROME_EXECUTABLE??local.chromeExecutable??null;
  const canaryTime=String(local.canaryTime??'07:50');
  if(legacyRoot&&(!path.isAbsolute(legacyRoot)||path.resolve(legacyRoot)===path.parse(path.resolve(legacyRoot)).root))throw Error('legacyRoot must be an absolute project directory');
  if(chromeExecutable&&!path.isAbsolute(chromeExecutable))throw Error('chromeExecutable must be absolute');
  if(!/^([01]\d|2[0-3]):[0-5]\d$/.test(canaryTime))throw Error('canaryTime must be HH:mm');
  const executionEngine=local.executionEngine??'v1';if(!['v1','v2'].includes(executionEngine))throw Error('executionEngine must be v1 or v2');
  return {file,legacyRoot:legacyRoot?path.resolve(legacyRoot):null,chromeExecutable:chromeExecutable?path.resolve(chromeExecutable):null,canaryTime,executionEngine,powershellExecutable:local.powershellExecutable??null};
}

export function assertStandaloneV2Enabled(root=path.resolve('.')) {
  const runtime=loadRuntimeConfig(root);
  if(runtime.executionEngine==='v1')throw Error('standalone V2 migration is retired while the V1 engine is selected');
  return runtime;
}
