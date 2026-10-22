const migration=/(?:本站|本网站|本網站|站点|站點|网站|網站|域名|服务|服務)\s*(?:已经|已經|已)\s*(?:迁移|遷移|搬迁|搬遷|更换|更換)|\b(?:site|website|domain|service)\s+(?:has\s+)?(?:been\s+)?(?:moved|migrated|relocated)\b/i;
const addressHint=/自动跳转|自動跳轉|新(?:的)?(?:地址|网址|網址|域名)|前往新|automatically redirect|new (?:address|domain|website)/i;
const leading=/^(?:本站|本网站|本網站|站点|站點|网站|網站|域名|服务|服務|(?:this\s+)?(?:site|website|domain|service)\b)/i;
export const bookmarkReviewRequired=value=>[value?.failureCode,value?.underlyingFailureCode].some(code=>['site_migration','bookmark_origin_changed'].includes(code));
export function providerLoginPage(url){
  let u;try{u=new URL(url);}catch{return false;}
  if(u.protocol!=='https:'||u.username||u.password)return false;
  return u.origin==='https://connect.linux.do'&&/^\/oauth2\/authorize\/?$/.test(u.pathname)||
    u.origin==='https://linux.do'&&/^\/(?:login|session)(?:\/|$)/.test(u.pathname)||
    u.origin==='https://github.com'&&/^\/(?:login|session)(?:\/|$)/.test(u.pathname)||
    u.origin==='https://accounts.google.com'&&/^\/(?:v3\/signin|signin|ServiceLogin|o\/oauth2)(?:\/|$)/.test(u.pathname);
}

export function classifySiteMigration({title='',bodyText='',url='',allowedOrigins=[]}={}){
  let current;
  try{current=new URL(url);}catch{return null;}
  if(!['http:','https:'].includes(current.protocol)||providerLoginPage(url))return null;
  if(current.protocol!=='https:'||current.username||current.password||!allowedOrigins.includes(current.origin))
    return {status:'needs_attention',failureCode:'bookmark_origin_changed',submissionAttempted:false,retryable:false,
      reason:'页面已离开书签授权来源，请核对并更新书签地址'};
  const body=String(bodyText).replace(/\s+/g,' ').trim();
  if(!migration.test(String(title).slice(0,300))&&
    !(body.length<=2000&&leading.test(body)&&migration.test(body.slice(0,250))&&addressHint.test(body)))return null;
  return {status:'needs_attention',failureCode:'site_migration',submissionAttempted:false,retryable:false,
    reason:'站点明确提示已迁移，请核对并更新书签地址'};
}

export async function inspectSiteMigration(page,allowedOrigins){
  const unexpected=classifySiteMigration({url:page.url(),allowedOrigins});
  if(unexpected)return unexpected;
  try{
    const observation=await page.evaluate(()=>({title:document.title,bodyText:(document.body?.innerText??'').slice(0,30001)}));
    return classifySiteMigration({...observation,url:page.url(),allowedOrigins});
  }catch{return classifySiteMigration({url:page.url(),allowedOrigins});}
}
