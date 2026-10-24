import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {verifyHhclubNativeProfile} from '../src/hhclub-two-factor-login.mjs';

test('native login proof requires one browser root and ignores renderer/service copies of the same Profile and debugging switches',
  {skip:process.platform!=='win32'},async()=>{
    const profile=path.resolve('D:/fixture native login'),port=42371;
    const command='chrome.exe --user-data-dir="'+profile+'" --remote-debugging-port='+port;
    for(const [processes,expected] of [
      [[{CommandLine:command},{CommandLine:command+' --type=renderer'},{CommandLine:command+' --type=utility'}],true],
      [[{CommandLine:command+' --type=renderer'}],false],
      [[{CommandLine:command},{CommandLine:command}],false],
      [[{CommandLine:command.replace(String(port),'42372')}],false],
      [[{CommandLine:command.replace(profile,'D:/other native login')}],false],
    ]){
      const executeProcess=async(file,args,options)=>{
        const data=Buffer.from(JSON.stringify(processes)).toString('base64');
        const mock="function Get-CimInstance { $rows=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:CHECKIN_PROCESS_FIXTURE))|ConvertFrom-Json;foreach($row in @($rows)){$row} };";
        return promisify(execFile)(file,[...args.slice(0,-1),mock+args.at(-1)],
          {...options,env:{...options.env,CHECKIN_PROCESS_FIXTURE:data}});
      };
      assert.equal(await verifyHhclubNativeProfile(profile,port,{executeProcess}),expected);
    }
  });
