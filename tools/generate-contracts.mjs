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
console.log('Shared check-in contracts '+(process.argv.includes('--check')?'verified':'generated'));
