import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {reconcilePtAttempt,listPtAttempts} from '../src/pt-reconciliation.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
try{
  const args=process.argv.slice(2),options={};
  for(let i=0;i<args.length;i+=2){
    if(!['--business-date','--attempt-id','--receipt-file','--resolution','--acknowledgement','--note'].includes(args[i])||!args[i+1]||options[args[i]])throw Error('invalid arguments');
    options[args[i]]=args[i+1];
  }
  if(options['--resolution']==='list'){console.log(JSON.stringify(listPtAttempts(root,options['--business-date'])));}
  else{
  const receipt=options['--receipt-file']?JSON.parse(fs.readFileSync(path.resolve(root,options['--receipt-file']),'utf8')):undefined;
  const result=reconcilePtAttempt({root,businessDate:options['--business-date'],attemptId:options['--attempt-id'],receipt,
    kind:options['--resolution']??'confirmed_external',acknowledgement:options['--acknowledgement'],note:options['--note']});
  console.log(JSON.stringify({attemptId:result.attemptId,businessDate:result.businessDate,kind:result.kind}));
  }
}catch{console.error('Reconciliation refused: exact evidence or explicit operator review is required; original attempts are unchanged.');process.exitCode=1;}
