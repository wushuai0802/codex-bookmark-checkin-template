// Bounded browser workflow ported from V1's provider discovery and callback
// handling. Only ordinary page controls are used; credentials stay in Chrome.
const sleep = async (page, ms) => { await page.waitForTimeout(ms); };
const visible = async control => Boolean(control && await control.count().catch(() => 0) === 1 && await control.isVisible().catch(() => false));
const location = page => { try { return new URL(page.url()); } catch { return null; } };

export async function findOAuthProvider(page, provider) {
  const variants = /linux\s*do/i.test(provider) ? ['LinuxDO', 'Linux DO', 'LINUX DO'] : [provider];
  for (const name of variants) {
    for (const label of [`使用 ${name} 继续`, `使用 ${name} 登录`, `使用 ${name} 登入`, name]) {
      const button = page.getByRole?.('button', {name:label, exact:true});
      if (await visible(button)) return button;
      const text = page.getByText?.(label, {exact:true});
      if (await visible(text)) return text;
    }
    for (const label of [name, `${name}登录`, `${name}登入`]) {
      const image = page.locator?.(`img[alt=${JSON.stringify(label)}]:visible`);
      if (image && await image.count().catch(() => 0) === 1) {
        const button = image.locator?.('xpath=ancestor::button[1]');
        if (await visible(button)) return button;
      }
    }
  }
  return null;
}

// V1 gives Chrome's isolated password manager one bounded chance to restore
// an upstream GitHub session. Values are only checked as booleans and never
// read, copied or returned to the control plane.
async function restoreSavedGitHubLogin(page, state) {
  if(state.attempted||page.isClosed?.())return false;
  const url=location(page);if(url?.origin!=='https://github.com'||!/^\/login(?:[/?#]|$)/i.test(url.pathname))return false;
  state.attempted=true;
  const username=page.locator?.('#login_field:visible, input[name="login"]:visible, input[type="email"]:visible')?.first?.();
  const password=page.locator?.('#password:visible, input[type="password"]:visible')?.first?.();
  if(!username||!password||await username.count().catch(()=>0)!==1||await password.count().catch(()=>0)!==1)return false;
  const filled=async()=>Boolean(await username.evaluate?.(node=>Boolean(node.value)).catch(()=>false)&&await password.evaluate?.(node=>Boolean(node.value)).catch(()=>false));
  for(const field of [username,password,username]){if(await filled())break;await field.click?.().catch(()=>{});await field.press?.('ArrowDown').catch(()=>{});await field.press?.('Enter').catch(()=>{});await page.waitForTimeout?.(1000);}
  if(!await filled())return false;
  const submit=page.locator?.('button[type="submit"]:visible, input[type="submit"]:visible')?.first?.();
  if(!submit||await submit.count().catch(()=>0)!==1)return false;
  await submit.click({timeout:10_000}).catch(()=>{});await page.waitForLoadState?.('domcontentloaded',{timeout:15_000}).catch(()=>{});await page.waitForTimeout?.(1200);return true;
}

export async function runOAuthBrowserFlow({context, site, provider, upstreamProvider, expectedIdentity, readIdentity, waitMs=90_000}) {
  const page=context.page;
  if(location(page)?.origin!==site) return {state:'unknown',reason:'oauth_untrusted_origin',actionMayHaveHappened:false};
  let button=null, revealed=false;
  for(let tick=0;tick<17;tick++) {
    button=await findOAuthProvider(page,provider);
    if(button)break;
    if(!revealed)for(const label of ['其他登录选项','第三方登录','Other login options']) {
      const control=page.getByText?.(label,{exact:true});
      if(await visible(control)){await control.click({timeout:5000});revealed=true;break;}
    }
    if(tick<16)await sleep(page,500);
  }
  if(!button)return {state:'unknown',reason:'oauth_provider_button_missing',actionMayHaveHappened:false};
  const agreement=page.getByRole?.('checkbox');
  if(await visible(agreement)&&typeof agreement.isChecked==='function'&&!await agreement.isChecked())await agreement.check({timeout:5000});
  // Observe the browser context before clicking: a fast popup callback can
  // complete and close before waitForEvent('popup') resolves.
  const emitter=page.context?.() ?? page, pending=new Set();
  let callbackRejected=false, clicked=false;
  const callbackPath=`/api/oauth/${provider.toLowerCase().replace(/[^a-z0-9]/g,'')}`;
  const onResponse=response=>{
    let url;try{url=new URL(response.url());}catch{return;}
    if(url.origin!==site||url.pathname.toLowerCase()!==callbackPath)return;
    const task=(async()=>{
      const body=await response.json().catch(()=>null);
      if(response.status()<200||response.status()>=300||body?.success!==true)callbackRejected=true;
    })().catch(()=>{callbackRejected=true;});
    pending.add(task);task.finally(()=>pending.delete(task));
  };
  emitter.on?.('response',onResponse);
  context.oauthInProgress=true;
  const unknown=reason=>({state:'unknown',reason,actionMayHaveHappened:clicked});
  try {
    const popupWait=page.waitForEvent?.('popup',{timeout:5000}).catch(()=>null);
    clicked=true; // A click timeout can occur after navigation was dispatched.
    try{await button.click({timeout:10_000});}catch{return unknown('oauth_provider_click_failed');}
    const popup=popupWait?await popupWait:null;
    let authPage=popup??page, authorized=false, upstreamClicked=false;const githubLoginState={attempted:false};
    const allowed=new Set([site]);
    for(const name of [provider,upstreamProvider].filter(Boolean)) {
      if(/linux\s*do/i.test(name)){allowed.add('https://connect.linux.do');allowed.add('https://linux.do');}
      if(/^github$/i.test(name))allowed.add('https://github.com');
      if(/^google$/i.test(name))allowed.add('https://accounts.google.com');
    }
    const deadline=Date.now()+waitMs;
    for(let tick=0;tick<Math.ceil(waitMs/1000)&&Date.now()<deadline;tick++) {
      await Promise.allSettled([...pending]);
      if(callbackRejected)return unknown('oauth_callback_rejected');
      if(authPage.isClosed?.())authPage=page;
      const url=location(authPage);
      if(url){context.oauthDiagnostic={host:url.hostname,path:url.pathname,callbackRejected};}
      if(url&&url.href!=='about:blank'&&!allowed.has(url.origin))return unknown('oauth_untrusted_origin');
      if(url?.origin===site) {
        context.page=authPage;
        const identity=await readIdentity(context,expectedIdentity);
        await Promise.allSettled([...pending]);
        if(callbackRejected)return unknown('oauth_callback_rejected');
        if(identity?.userId===expectedIdentity&&identity.origin===site)return {state:'triggered',actionMayHaveHappened:true};
        if(identity?.blockedReason==='identity_mismatch')return unknown('identity_mismatch');
      }
      if(url?.origin==='https://connect.linux.do'&&!authorized) {
        const matches=[];
        for(const label of ['授权','允许','Authorize','Allow','同意','确认授权','同意并继续','继续','Continue','Approve'])for(const role of ['button','link']){
          const control=authPage.getByRole?.(role,{name:label,exact:true});
          if(await visible(control))matches.push(control);
        }
        if(matches.length===1){authorized=true;await matches[0].click({timeout:10_000});}
      }
      if(url?.origin==='https://linux.do'&&/^\/login(?:\/|$)/i.test(url.pathname)&&!upstreamClicked) {
        if(!upstreamProvider)return unknown('oauth_upstream_provider_missing');
        const upstream=await findOAuthProvider(authPage,upstreamProvider);
        if(!upstream)return unknown('oauth_upstream_login_required');
        upstreamClicked=true;await upstream.click({timeout:10_000});
      }
      if(url?.origin==='https://github.com'&&/^\/login\/oauth\/authorize/i.test(url.pathname)){
        const authorize=authPage.getByRole?.('button',{name:/^Authorize /});
        if(await visible(authorize))return unknown('oauth_upstream_authorization_required');
      }
      if(url?.origin==='https://github.com'&&/^\/login\/?$/i.test(url.pathname)) {
        if(await restoreSavedGitHubLogin(authPage,githubLoginState)){await sleep(authPage,1000);continue;}
        return unknown('oauth_upstream_login_required');
      }
      // /login/oauth/authorize is a valid GitHub authorization redirect.
      if(url?.origin==='https://accounts.google.com'&&/challenge|signin/i.test(url.pathname))return unknown('oauth_upstream_login_required');
      if(tick+1<Math.ceil(waitMs/1000))await sleep(authPage,1000);
    }
    return unknown('oauth_callback_timeout');
  } catch {return unknown('oauth_navigation_failed');}
  finally {context.oauthInProgress=false;emitter.off?.('response',onResponse);await Promise.allSettled([...pending]);}
}
