import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {withRuntimeLocks} from './release-lib.mjs';
const source=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const read=file=>fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):{};
function atomic(file,value){fs.mkdirSync(path.dirname(file),{recursive:true});const temp=file+'.tmp';
  try{fs.writeFileSync(temp,JSON.stringify(value,null,2),{mode:0o600});fs.renameSync(temp,file);}finally{if(fs.existsSync(temp))fs.unlinkSync(temp);}}
export async function configureRuntime({executionRoot,observationRoot,lock=withRuntimeLocks}={}){
  if(!executionRoot||!observationRoot)throw Error('both runtime roots are required');
  const execution=path.resolve(executionRoot),observation=path.resolve(observationRoot);
  if(execution===observation||[execution,observation].some(root=>root===path.parse(root).root))throw Error('invalid runtime roots');
  if(!fs.existsSync(path.join(execution,'config/config.json'))||!fs.existsSync(path.join(execution,'data/last-valid-bookmark-plan.json')))
    throw Error('initialize and dry-run the execution layer first');
  const file=path.join(observation,'config/runtime.local.json'),bindingFile=path.join(execution,'data/v2-integration.json');
  const runtime=read(file),binding=read(bindingFile);
  if(runtime.executionEngine&&runtime.executionEngine!=='v1'||binding.executionEngine&&binding.executionEngine!=='v1')throw Error('existing execution ownership needs review');
  if(runtime.legacyRoot&&path.resolve(runtime.legacyRoot)!==execution||binding.v2ProjectRoot&&path.resolve(binding.v2ProjectRoot)!==observation)throw Error('existing runtime binding differs');
  return lock({source,roots:{execution,observation}},async()=>{
    const prior={runtime:fs.existsSync(file)?fs.readFileSync(file,'utf8'):null,binding:fs.existsSync(bindingFile)?fs.readFileSync(bindingFile,'utf8'):null};
    const backup=path.join(observation,'outputs','runtime-binding-before-'+Date.now()+'.json');atomic(backup,prior);
    try{
      atomic(file,{...runtime,executionEngine:'v1',legacyRoot:execution,ptFallbackOnlyEnabled:runtime.ptFallbackOnlyEnabled===true});
      atomic(bindingFile,{...binding,executionEngine:'v1',v2ProjectRoot:observation});
    }catch(error){
      if(prior.runtime!=null)fs.writeFileSync(file,prior.runtime);else if(fs.existsSync(file))fs.unlinkSync(file);
      if(prior.binding!=null)fs.writeFileSync(bindingFile,prior.binding);else if(fs.existsSync(bindingFile))fs.unlinkSync(bindingFile);
      throw error;
    }
    return {configured:true,executionOwner:'execution',backup};
  });
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const args=process.argv.slice(2),value=k=>args[args.indexOf(k)+1];
  try{if(!args.includes('--execution-root')||!args.includes('--observation-root'))throw Error('provide --execution-root and --observation-root');
    console.log(JSON.stringify(await configureRuntime({executionRoot:value('--execution-root'),observationRoot:value('--observation-root')})));
  }catch(error){console.error(error.message);process.exitCode=1;}
}
