import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

// Tool-managed caches can disappear during an editor/runtime update.
export function unstablePowerShellPath(value) {
  const normalized=String(value??'').replaceAll('\\','/');
  return /(?:^|\/)(?:\.cache|codex-runtimes|node_modules|\.codex|\.vscode|\.cursor|\.windsurf|\.kiro)(?:\/|$)/i.test(normalized)||
    /(?:^|\/)(?:runtimes|dependencies)\/(?:native|powershell)(?:\/|$)/i.test(normalized);
}

export function powerShellExecutablePresent(value,{exists=fs.existsSync,lstat=fs.lstatSync,readlink=fs.readlinkSync}={}) {
  // Windows App Execution Aliases can reject stat/access while readlink
  // exposes their installed MSIX target. Keep the stable alias in config.
  if(!/[\\/]Microsoft[\\/]WindowsApps[\\/](?:pwsh|powershell)\.exe$/i.test(value??''))return exists(value);
  try {
    if(!lstat(value).isSymbolicLink())return exists(value);
    const target=readlink(value);
    return path.win32.isAbsolute(target)&&!unstablePowerShellPath(target)&&exists(target);
  }catch{return false;}
}

export function powerShellRuntimeHealth(value,{exists=powerShellExecutablePresent}={}) {
  const absolute=typeof value==='string'&&path.win32.isAbsolute(value);
  return {present:Boolean(absolute&&exists(value)),stable:Boolean(absolute&&!unstablePowerShellPath(value))};
}

export function configuredPowerShellRuntimeHealth(configFile,{exists=powerShellExecutablePresent}={}) {
  const read=file=>JSON.parse(fs.readFileSync(file,'utf8').replace(/^\uFEFF/,''));
  const config=read(configFile),values=[config.powershellExecutable];
  const root=path.dirname(path.dirname(configFile)),integrationFile=path.join(root,'data','v2-integration.json');
  if(fs.existsSync(integrationFile)) {
    const integration=read(integrationFile);
    if(integration.executionEngine==='v1') {
      const runtimeFile=path.join(integration.v2ProjectRoot,'config','runtime.local.json');
      if(fs.existsSync(runtimeFile)) {
        const runtime=read(runtimeFile);
        if(runtime.powershellExecutable!==undefined&&runtime.powershellExecutable!==null)values.push(runtime.powershellExecutable);
      }
    }
  }
  const checks=values.map(value=>powerShellRuntimeHealth(value,{exists}));
  return {present:checks.every(value=>value.present),stable:checks.every(value=>value.stable)};
}

export async function selectPowerShell({configured,env=process.env,exists=powerShellExecutablePresent}={}) {
  const programFiles=env.ProgramFiles??env.PROGRAMFILES;
  const local=env.LOCALAPPDATA;
  const system=env.SystemRoot??env.SYSTEMROOT??'C:\\Windows';
  const candidates=[configured,
    programFiles&&path.win32.join(programFiles,'PowerShell','7','pwsh.exe'),
    local&&path.win32.join(local,'Microsoft','WindowsApps','pwsh.exe'),
    ...(env.Path??env.PATH??'').split(';').filter(Boolean).map(directory=>path.win32.join(directory,'pwsh.exe')),
    path.win32.join(system,'System32','WindowsPowerShell','v1.0','powershell.exe')];
  for(const candidate of candidates.filter(Boolean)) {
    if(!path.win32.isAbsolute(candidate)||unstablePowerShellPath(candidate)||
      !/^(?:pwsh|powershell)\.exe$/i.test(path.win32.basename(candidate)))continue;
    if(await exists(candidate))return path.win32.normalize(candidate);
  }
  throw Error('No stable PowerShell installation found; choose an installed system PowerShell');
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  try {
    console.log(JSON.stringify(configuredPowerShellRuntimeHealth(process.argv[2])));
  }catch{console.log(JSON.stringify({present:false,stable:false}));process.exitCode=1;}
}
