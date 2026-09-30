import {planHistoryArchive,applyHistoryArchive,verifyHistoryArchive,restoreHistoryArchive} from '../src/history-archive.mjs';
const args=process.argv.slice(2),value=key=>args.includes(key)?args[args.indexOf(key)+1]:null;
try{
  let result;
  if(value('--verify')){const manifest=verifyHistoryArchive(value('--verify'));result={verified:true,files:manifest.moved.length,months:manifest.monthly.length};}
  else if(value('--restore'))result=restoreHistoryArchive(value('--restore'),value('--data-dir'));
  else{
    if(!value('--data-dir')||!value('--before'))throw Error('provide --data-dir and --before YYYY-MM');
    const plan=planHistoryArchive(value('--data-dir'),value('--before'));
    if(args.includes('--apply')){if(!value('--archive-root'))throw Error('provide --archive-root for an applied archive');result=applyHistoryArchive(plan,value('--archive-root'));}
    else result={mode:'preview',files:plan.files.map(f=>f.name),months:Object.keys(plan.months),retainedUnresolved:plan.retained};
  }
  console.log(JSON.stringify(result));
}catch(error){console.error('History archive refused: '+error.message);process.exitCode=1;}
