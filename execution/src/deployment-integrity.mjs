import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
const read=file=>JSON.parse(fs.readFileSync(file,'utf8').replace(/^\uFEFF/,''));
const hash=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
export function deploymentIntegrity(root,{now=Date.now(),alive=pid=>{try{process.kill(pid,0);return true;}catch{return false;}}}={}){
  const roots=[root],issues=[];let managed=false;
  try{const integration=read(path.join(root,'data/v2-integration.json'));
    if(integration.executionEngine==='v1'&&path.isAbsolute(integration.v2ProjectRoot??''))roots.push(integration.v2ProjectRoot);
  }catch{}
  for(const current of roots){
    try{const progress=read(path.join(current,'tmp/release-in-progress.json'));
      if(progress.kind==='managed-release'&&Number.isSafeInteger(progress.pid)&&progress.pid>0&&
        now-Date.parse(progress.startedAt)>=0&&now-Date.parse(progress.startedAt)<15*60_000&&alive(progress.pid))
        return {managed:true,consistent:null,busy:true,issues:[]};
    }catch{}
  }
  for(const [index,current] of roots.entries()){
    const lifecycle=path.join(current,'data/pt-worker-lifecycle.json');
    if(fs.existsSync(lifecycle))try{const value=read(lifecycle);
      if(value.state==='cleanup_pending'||!Number.isSafeInteger(value.observerPid)||!alive(value.observerPid))issues.push('pt_cleanup_pending');
    }catch{issues.push('pt_cleanup_pending');}
    const label=index===0?'execution':'observation';let marker;
    try{marker=read(path.join(current,'release.json'));}catch{continue;}
    if(!marker.packageHash&&!marker.lockHash)continue;managed=true;
    try{
      const pkg=path.join(current,'package.json'),lock=path.join(current,'package-lock.json');
      if(marker.packageHash&&hash(pkg)!==marker.packageHash)issues.push(label+'_package_drift');
      if(marker.lockHash&&hash(lock)!==marker.lockHash)issues.push(label+'_lock_drift');
      const declared=read(pkg),packages=read(lock).packages??{};
      if(declared.version!==marker.version)issues.push(label+'_version_drift');
      for(const name of Object.keys(declared.dependencies??{})){
        if(!/^@?[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9._-]+)?$/i.test(name)){issues.push(label+'_dependency_invalid');continue;}
        const expected=packages['node_modules/'+name]?.version;
        let installed;try{installed=read(path.join(current,'node_modules',name,'package.json')).version;}catch{}
        if(expected&&installed!==expected)issues.push(label+'_dependency_drift');
      }
    }catch{issues.push(label+'_metadata_unavailable');}
  }
  return {managed,consistent:issues.length===0,busy:false,issues:[...new Set(issues)]};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{console.log(JSON.stringify(deploymentIntegrity(path.resolve(process.argv[2]))));}
  catch{console.log(JSON.stringify({managed:true,consistent:false,busy:false,issues:['integrity_check_failed']}));}
}
