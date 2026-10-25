import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {boundMonitorCatalog,currentBoundMonitorCatalog} from './monitor-catalog.mjs';
import {loadEffectiveConfig} from './effective-config.mjs';
const read=file=>JSON.parse(fs.readFileSync(file,'utf8').replace(/^\uFEFF/,''));

export async function refreshEvidenceCatalog(root,catalogFile,now=new Date(),{outFile}={}){
  const runtime=read(path.join(root,'config/runtime.local.json')),config=loadEffectiveConfig(runtime.legacyRoot),previous=read(catalogFile);
  const catalog=previous.registration==='current-execution-plan'||config.targetFolderNames?.length
    ?await currentBoundMonitorCatalog(runtime.legacyRoot,previous.scope,now)
    :boundMonitorCatalog(config.bookmarksPath,previous.scope,now);
  const file=outFile??path.join(root,'data/pt-evidence-catalog.json');
  if(outFile&&(path.dirname(path.resolve(outFile))!==path.resolve(root,'tmp')||
    !/^pt-catalog-[a-f0-9-]{36}\.json$/.test(path.basename(outFile))||fs.existsSync(outFile)))throw Error('Invalid owned catalog destination');
  fs.mkdirSync(path.dirname(file),{recursive:true});const temporary=file+'.'+crypto.randomUUID()+'.tmp';
  try{fs.writeFileSync(temporary,JSON.stringify(catalog),{mode:0o600,flag:'wx'});fs.renameSync(temporary,file);}
  finally{if(fs.existsSync(temporary))fs.unlinkSync(temporary);}
  return file;
}

/** A fresh immutable input belongs to one operation, so another reader cannot replace it mid-run. */
export async function withCurrentPtCatalog({root,catalogFile,origin,now=new Date(),refresh=refreshEvidenceCatalog},run){
  const owned=path.join(root,'tmp','pt-catalog-'+crypto.randomUUID()+'.json'),previous=read(catalogFile);
  try{
    const currentFile=await refresh(root,catalogFile,now,{outFile:owned}),bytes=fs.readFileSync(currentFile),catalog=JSON.parse(bytes);
    const selected=value=>(value.sites??[]).filter(site=>site.origin===origin).map(site=>({origin:site.origin,entryUrl:site.entryUrl}));
    const scopeKey=value=>JSON.stringify(['folderId','parentId','folderGuid','parentGuid'].map(key=>value.scope?.[key]??null));
    const oldTarget=selected(previous),newTarget=selected(catalog);
    if(oldTarget.length!==1||newTarget.length!==1||JSON.stringify(oldTarget)!==JSON.stringify(newTarget)||
      scopeKey(previous)!==scopeKey(catalog)||previous.registeredPlanHash!==catalog.registeredPlanHash){
      const error=Error('PT catalog target changed');error.code='PT_PREFLIGHT';error.preflightReason='site_scope_changed';throw error;
    }
    return await run({catalogFile:currentFile,catalogHash:crypto.createHash('sha256').update(bytes).digest('hex'),catalog});
  }finally{if(fs.existsSync(owned))fs.unlinkSync(owned);}
}
