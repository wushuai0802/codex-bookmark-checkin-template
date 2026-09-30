import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {planRelease,applyRelease,rollbackRelease,auditRelease} from './release-lib.mjs';
const source=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const [command,...args]=process.argv.slice(2),options={};
try{
  for(let i=0;i<args.length;i+=2){if(!['--execution-root','--observation-root','--out','--manifest','--backup-root','--backup'].includes(args[i])||!args[i+1])throw Error('invalid release arguments');options[args[i]]=args[i+1];}
  if(command==='plan'){
    if(!options['--execution-root']||!options['--observation-root']||!options['--out'])throw Error('plan needs runtime roots and --out');
    const plan=planRelease({source,executionRoot:options['--execution-root'],observationRoot:options['--observation-root']});
    const file=path.resolve(options['--out']);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,JSON.stringify(plan,null,2),{mode:0o600});
    console.log(JSON.stringify({manifest:file,files:plan.files.length,changed:plan.files.filter(f=>f.beforeHash!==f.afterHash).map(f=>f.file)}));
  }else if(command==='apply'||command==='audit'){
    if(!options['--manifest'])throw Error('manifest required');
    const plan=JSON.parse(fs.readFileSync(options['--manifest'],'utf8'));
    if(command==='apply'&&!options['--backup-root'])throw Error('backup root required');
    console.log(JSON.stringify(command==='apply'?await applyRelease(plan,{backupRoot:options['--backup-root']}):auditRelease(plan)));
  }else if(command==='rollback'){
    if(!options['--backup'])throw Error('backup required');console.log(JSON.stringify(await rollbackRelease(options['--backup'])));
  }else throw Error('use plan, apply, audit or rollback');
}catch(error){console.error('Release refused: '+error.message);process.exitCode=1;}
