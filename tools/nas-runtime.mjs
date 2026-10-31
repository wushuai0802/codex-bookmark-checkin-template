import path from 'node:path';
import {isDeepStrictEqual} from 'node:util';

// These are the image default and the two supported NAS Compose inputs. Read
// them through the same revision reader as the modules, never the worktree.
export function nasEntrypoints(readFile){
  const commands=[];
  const docker=readFile('observation/Dockerfile').replace(/\\\r?\n\s*/g,' ');
  for(const match of docker.matchAll(/^(?:CMD|ENTRYPOINT|HEALTHCHECK\b[^\n]*?\bCMD)\s+(.+)$/gmi))
    commands.push(match[1]);
  for(const file of ['compose.nas.yaml','compose.worker.yaml']){
    const lines=readFile('observation/'+file).split(/\r?\n/);
    for(let i=0;i<lines.length;i++){
      const match=lines[i].match(/^(\s*)(?:command|entrypoint|test):\s*(.*)$/);
      if(!match)continue;
      commands.push(match[2]);
      for(let j=i+1;j<lines.length&&(!lines[j].trim()||lines[j].match(/^\s*/)[0].length>match[1].length);j++)
        commands.push(lines[j]);
    }
  }
  const entries=new Set();
  for(const command of commands)
    for(const match of command.matchAll(/(?:^|[\s"'\[\],])((?:\/app\/|\.\/)?(?:src|public)\/[\w./-]+\.(?:mjs|cjs|js))(?=$|[\s"'\],;])/g))
      entries.add('observation/'+match[1].replace(/^(?:\/app\/|\.\/)/,''));
  if(!entries.size)throw Error('NAS entrypoint unavailable');
  return [...entries].sort();
}

function literalValue(value){
  return value.slice(1,-1).replace(/\\(u\{[\da-f]+\}|u[\da-f]{4}|x[\da-f]{2}|\r?\n|[\s\S])/gi,(_all,escape)=>{
    if(escape[0]==='u')return String.fromCodePoint(parseInt(escape.slice(1).replace(/[{}]/g,''),16));
    if(escape[0]==='x')return String.fromCharCode(parseInt(escape.slice(1),16));
    return ({n:'\n',r:'\r',t:'\t',b:'\b',f:'\f',v:'\v','0':'\0','\n':'','\r\n':''})[escape]??escape;
  });
}

// Lex rather than execute modules. Comments, quoted text and regular
// expressions cannot create dependencies. A template argument is conservative
// when it interpolates a value; a plain quoted import must be the whole arg.
function moduleTokens(source){
  const tokens=[];
  let i=0;
  const scan=(interpolation=false)=>{
    let braces=0;
    while(i<source.length){
      if(interpolation&&source[i]==='}'&&braces===0){i++;return;}
      const rest=source.slice(i),skip=rest.match(/^(?:\s+|\/\/[^\r\n]*|\/\*[\s\S]*?\*\/|#![^\r\n]*)/);
      if(skip){i+=skip[0].length;continue;}
      const text=rest.match(/^(?:"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*')/)?.[0];
      if(text){tokens.push({kind:'string',value:literalValue(text)});i+=text.length;continue;}
      if(source[i]==='`'){
        const start=i++,template={kind:'template',value:''};
        tokens.push(template);
        let interpolated=false;
        while(i<source.length){
          if(source[i]==='\\'){i+=2;continue;}
          if(source[i]==='`'){i++;break;}
          if(source.startsWith('${',i)){
            interpolated=true;i+=2;tokens.push({kind:'punct',value:'{'});
            scan(true);tokens.push({kind:'punct',value:'}'});
          }else i++;
        }
        if(!interpolated){template.kind='string';template.value=literalValue(source.slice(start,i));}
        continue;
      }
      const previous=tokens.at(-1);
      if(source[i]==='/'&&(!previous||previous.kind==='punct'&&/[=(:,[!&|?{};]/.test(previous.value)||
        previous.kind==='word'&&['return','throw','case','yield'].includes(previous.value))){
        const regex=rest.match(/^\/(?:\\[^\r\n]|\[(?:\\[^\r\n]|[^\]\\\r\n])*\]|[^/\\[\r\n])+\/[a-z]*/i)?.[0];
        if(regex){tokens.push({kind:'regex',value:''});i+=regex.length;continue;}
      }
      const word=rest.match(/^[A-Za-z_$][\w$]*/)?.[0];
      if(!word&&source[i]==='{')braces++;
      if(!word&&source[i]==='}')braces--;
      tokens.push({kind:word?'word':'punct',value:word??source[i]});
      i+=word?.length??1;
    }
  };
  scan();
  return tokens;
}

// Pure graph walk: the caller supplies all contents (Git, an in-memory fixture,
// etc.). Each module is visited once, including cyclic imports/re-exports.
export function collectNasRuntime(readFile,{entrypoints=nasEntrypoints(readFile)}={}){
  const modules=new Set(),conservativeDirectories=new Set(),unresolvedImports=[];
  const pending=[...entrypoints];
  while(pending.length){
    const file=pending.pop();
    if(modules.has(file))continue;
    modules.add(file);
    const source=readFile(file);
    if(!/\.(?:mjs|cjs|js)$/.test(file))continue;
    const tokens=moduleTokens(source),imports=[];
    for(let i=0;i<tokens.length;i++){
      const token=tokens[i],next=tokens[i+1];
      if(token.kind!=='word'||!['import','export'].includes(token.value)||tokens[i-1]?.value==='.'||!next)continue;
      if(token.value==='import'&&next.value==='('){
        // An object/class method named import is not an import expression.
        let end=i+2,depth=1;
        for(;end<tokens.length;end++){
          if(tokens[end].kind!=='punct')continue;
          if(tokens[end].value==='(')depth++;
          if(tokens[end].value===')'&&--depth===0)break;
        }
        if(tokens[end+1]?.value==='{')continue;
        if(tokens[i+2]?.kind==='string'&&[')',','].includes(tokens[i+3]?.value))imports.push(tokens[i+2].value);
        // Loads from the Windows execution root, which does not exist on the NAS.
        else if(tokens.slice(i+2,end).some(item=>item.kind==='word'&&item.value==='legacyRoot'))continue;
        else {unresolvedImports.push(file);conservativeDirectories.add(path.posix.dirname(file)+'/');}
      }else if(token.value==='import'&&next.kind==='string')imports.push(next.value);
      else if(next.value!=='.'&&(token.value==='import'||['{','*'].includes(next.value))){
        for(let j=i+1;j<tokens.length&&tokens[j].value!==';';j++){
          if(tokens[j].value==='from'&&tokens[j+1]?.kind==='string'){imports.push(tokens[j+1].value);break;}
        }
      }
    }
    for(const specifier of imports)if(/^\.\.?\//.test(specifier))
      pending.push(path.posix.normalize(path.posix.join(path.posix.dirname(file),specifier.split(/[?#]/)[0])));
  }
  return {entrypoints:[...entrypoints],modules,conservativeDirectories,unresolvedImports};
}

export function nasRuntimeFile(file,runtime){
  return runtime.modules.has(file)||[...runtime.conservativeDirectories].some(directory=>file.startsWith(directory))||
    /^observation\/public\//.test(file)||
    /^observation\/(?:Dockerfile|compose\.[^/]+\.yaml|\.dockerignore|package(?:-lock)?\.json)$/.test(file);
}

// Ignore just the root package's version. Dependency versions, lock format and
// every other field still participate in the comparison.
export function nasPackageEqual(file,before,after){
  const clean=body=>{
    const value=JSON.parse(body.replace(/^\uFEFF/,''));
    delete value.version;
    if(file==='observation/package-lock.json'&&value.packages?.[''])delete value.packages[''].version;
    return value;
  };
  return isDeepStrictEqual(clean(before),clean(after));
}
