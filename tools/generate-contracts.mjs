import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const contract=JSON.parse(fs.readFileSync(path.join(root,'shared/checkin-contract.json'),'utf8'));
const text='// Generated from shared/checkin-contract.json. Run npm run contracts; do not edit.\n'+
  Object.entries(contract).map(([name,value])=>'export const '+name+' = Object.freeze('+JSON.stringify(value,null,2)+');').join('\n')+'\n';
const files=['execution/src/checkin-contract.generated.mjs','observation/src/checkin-contract.generated.mjs','observation/public/checkin-contract.generated.mjs'];
for(const file of files){
  const target=path.join(root,file);
  if(process.argv.includes('--check')){
    if(!fs.existsSync(target)||fs.readFileSync(target,'utf8').replaceAll('\r','')!==text)throw Error('generated contract drift: '+file);
  }else fs.writeFileSync(target,text);
}
const psQuote=value=>"'"+value.replaceAll("'","''")+"'";
const powershell='# Generated from shared/checkin-contract.json. Run npm run contracts; do not edit.\n'+
  '$CheckinFeatureDisabledEvidence = @{\n'+Object.entries(contract.featureDisabledEvidence).map(([source,outcomes])=>
    `    ${psQuote(source)} = @(${outcomes.map(psQuote).join(', ')})`).join('\n')+'\n}\n'+
  '$CheckinExternalRetryCauses = @('+contract.externalRetryCauses.map(psQuote).join(', ')+')\n'+
  '$CheckinNativePtHeaderOrigins = @('+contract.nativePtHeaderOrigins.map(psQuote).join(', ')+')\n';
const psFile=path.join(root,'execution/scripts/CheckinContract.generated.ps1');
if(process.argv.includes('--check')){
  if(!fs.existsSync(psFile)||fs.readFileSync(psFile,'utf8').replaceAll('\r','')!==powershell)throw Error('generated PowerShell contract drift');
}else fs.writeFileSync(psFile,powershell);
console.log('Shared check-in contracts '+(process.argv.includes('--check')?'verified':'generated'));
const coordinationSource=fs.readFileSync(path.join(root,'execution/src/pt-coordination.mjs'),'utf8').replaceAll('\r','');
const coordinationText='// Generated from execution/src/pt-coordination.mjs. Run npm run contracts; do not edit.\n'+coordinationSource;
const coordinationFile=path.join(root,'observation/src/pt-coordination.generated.mjs');
if(process.argv.includes('--check')){
  if(!fs.existsSync(coordinationFile)||fs.readFileSync(coordinationFile,'utf8').replaceAll('\r','')!==coordinationText)throw Error('generated PT coordination drift');
}else fs.writeFileSync(coordinationFile,coordinationText);
