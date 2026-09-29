#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {runPtSite} from '../src/pt-site-execution.mjs';

const root=fileURLToPath(new URL('../',import.meta.url));
const businessDay=at=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai'}).format(at);
const origin='https://open.cd';

export function recordReadOnlyOpenCd(rootDirectory,result,now=new Date()){
  const businessDate=businessDay(now),observed=Date.parse(result?.observedAt??'');
  if(result?.origin!==origin||result.status!=='already_signed'||result.evidence?.source!=='pt_page'||
    result.evidence.authoritative!==true||!Number.isFinite(observed)||businessDay(new Date(observed))!==businessDate||
    observed>now.getTime()+60_000)throw Error('OpenCD read-only receipt is not authoritative for today');
  const file=path.join(rootDirectory,'outputs',`pt-fallback-results-${businessDate}.json`);
  let report={schemaVersion:1,source:'execution-supplement',businessDate,generatedAt:now.toISOString(),sites:[]};
  if(fs.existsSync(file)){
    if(fs.lstatSync(file).isSymbolicLink())throw Error('PT report cannot be a symbolic link');
    report=JSON.parse(fs.readFileSync(file,'utf8'));
    if(report.source!=='execution-supplement'||report.businessDate!==businessDate||!Array.isArray(report.sites))
      throw Error('existing PT report cannot be updated');
  }
  report.generatedAt=now.toISOString();
  report.sites=report.sites.filter(site=>site.origin!==origin).concat(result);
  fs.mkdirSync(path.dirname(file),{recursive:true});
  const temp=`${file}.${process.pid}.tmp`;
  try{fs.writeFileSync(temp,JSON.stringify(report,null,2),{encoding:'utf8',mode:0o600});fs.renameSync(temp,file);}
  finally{if(fs.existsSync(temp))fs.unlinkSync(temp);}
  return {file,businessDate,siteCount:report.sites.length};
}

if(process.argv[1]&&path.resolve(process.argv[1])===path.resolve(fileURLToPath(import.meta.url))){
  const [catalogFile,catalogHash]=process.argv.slice(2);
  if(!catalogFile||!/^[a-f0-9]{64}$/i.test(catalogHash??'')){
    console.error('provide a bound PT catalog and SHA-256');process.exitCode=1;
  }else try{
    const result=await runPtSite({root,origin,catalogFile,catalogHash,readOnly:true});
    const saved=result.status==='already_signed'&&result.evidence?.authoritative===true
      ? recordReadOnlyOpenCd(root,result)
      : null;
    console.log(JSON.stringify({businessDate:businessDay(new Date()),origin,status:result.status,
      authoritative:result.evidence.authoritative===true,source:result.evidence.source,
      recorded:Boolean(saved)}));
  }catch(error){console.error(`OpenCD read-only verification failed: ${error.message}`);process.exitCode=1;}
}
