import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

test('native reads distinguish Chromium transport pages from real tracker pages',()=>{
  const script=fileURLToPath(new URL('../scripts/ResultContract.ps1',import.meta.url));
  const cases=[
    ['无法访问此网站，意外终止了连接。 ERR_CONNECTION_CLOSED 重新加载','network_error'],
    ["This site can’t be reached ERR_CONNECTION_RESET",'network_error'],
    ['无法访问此网站 ERR_SSL_PROTOCOL_ERROR','tls_handshake_failed'],
    ['您的连接不是私密连接 NET::ERR_CERT_DATE_INVALID','tls_certificate_invalid'],
    ['欢迎回来 分享率 控制面板 论坛帖子：无法访问此网站 ERR_CONNECTION_CLOSED',''],
    ['已签到 页面加载完成',''],['本站签到页面 Error',''],
  ];
  const quote=value=>value.replaceAll("'","''");
  const command=`$ErrorActionPreference='Stop';[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
. '${quote(script)}'
$cases=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(JSON.stringify(cases),'utf8').toString('base64')}')) | ConvertFrom-Json
$results=@(foreach($case in $cases){[string](Get-NativeBrowserFailure ([string]$case[0]))})
ConvertTo-Json -InputObject $results -Compress`;
  for(const shell of process.platform==='win32'?['powershell.exe','pwsh.exe']:['pwsh']){
    const output=execFileSync(shell,['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(command,'utf16le').toString('base64')],
      {encoding:'utf8',windowsHide:true,timeout:30000});
    assert.deepEqual(JSON.parse(output),cases.map(c=>c[1]),shell);
  }
});
