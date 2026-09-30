import fs from 'node:fs';
import {fileURLToPath} from 'node:url';
export function releaseInfo(){
  const version=JSON.parse(fs.readFileSync(fileURLToPath(new URL('../package.json',import.meta.url)),'utf8')).version;
  let marker;try{marker=JSON.parse(fs.readFileSync(fileURLToPath(new URL('../release.json',import.meta.url)),'utf8'));}catch{}
  return {version,revision:marker?.version===version&&/^[a-f0-9]{40}$/.test(marker.revision??'')?marker.revision:null,
    deployedAt:Number.isFinite(Date.parse(marker?.deployedAt))?new Date(marker.deployedAt).toISOString():null};
}
