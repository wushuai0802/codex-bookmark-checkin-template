// Explicit offline harness for the SPA contract tests on dependency-free checkouts.
// Production modules and all receipt/gate logic run unchanged. Only browser
// creation and the unused anonymous request client are replaced with throwers.
import fs from 'node:fs';
import {registerHooks} from 'node:module';
const browserUrl=new URL('../../src/browser.mjs',import.meta.url).href;
const playwrightUrl='offline-piggo:playwright';
registerHooks({
  resolve(specifier,context,next){
    if(specifier==='playwright-core')return {url:playwrightUrl,shortCircuit:true};
    return next(specifier,context);
  },
  load(url,context,next){
    if(url===playwrightUrl)return {format:'module',shortCircuit:true,
      source:"export const request={newContext(){throw Error('Anonymous HTTP disabled in offline SPA tests')}};"};
    if(url===browserUrl){
      const source=fs.readFileSync(new URL(url),'utf8'),start=source.indexOf('export function configuredTargetSkip('),
        end=source.indexOf('export function configuredLoginCompletion(',start);
      if(start<0||end<0)throw Error('Offline boundary extraction failed');
      return {format:'module',shortCircuit:true,source:source.slice(start,end)+
        "\nexport function launchAutomationContext(){throw Error('Browser launch disabled in offline SPA tests')}"};
    }
    return next(url,context);
  }
});
