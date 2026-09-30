import fs from 'node:fs';
import {claimOperation,finishOperation} from './dashboard-operations.mjs';
const root=process.env.FABRIC_DATA_DIR;
try{
  const bytes=fs.readFileSync(0);if(!root||bytes.length>16000)throw Error('invalid queue request');
  const input=JSON.parse(bytes);
  const result=input.mode==='claim'?claimOperation(root):input.mode==='finish'?finishOperation(root,input):null;
  if(!['claim','finish'].includes(input.mode))throw Error('invalid queue operation');
  console.log(JSON.stringify(result));
}catch{console.error('Dashboard operation queue request refused');process.exitCode=1;}
