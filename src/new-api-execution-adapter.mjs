import {defineAdapter} from './adapter-contract.mjs';

const responseCause = response => response?.status === 401 ? 'auth_expired'
  : response?.status === 403 ? 'challenge_required'
  : response?.status === 429 ? 'rate_limited'
  : !response?.status || response.status >= 500 ? 'unreachable' : 'invalid_response';

function pageFor(context) {
  if (!context?.page || typeof context.page.evaluate !== 'function') throw Error('isolated page is required');
  return context.page;
}

function ruleFor(origin, rule = {}) {
  const base = new URL(origin);
  const resolve = (value, name) => {
    const url = new URL(value || `/api/user/${name}`, base.origin);
    if (url.protocol !== 'https:' || url.origin !== base.origin || url.username || url.password) throw Error(`invalid ${name} endpoint`);
    return url.pathname;
  };
  return {
    selfPath:resolve(rule.selfPath, 'self'),
    statusPath:resolve(rule.statusPath, 'checkin'),
    signInPath:resolve(rule.signInPath, 'checkin'),
    rewardAmount:Number.isFinite(Number(rule.rewardAmount)) ? Number(rule.rewardAmount) : null
  };
}

// The first V2 mutating adapter. It owns one POST and always verifies afterward.
// The caller must provide a dedicated Playwright-compatible page; no browser is
// launched here and no V1 helper or profile is imported.
export function createNewApiExecutionAdapter({origin, rule} = {}) {
  const siteOrigin = new URL(origin).origin;
  const paths = ruleFor(siteOrigin, rule);
  return defineAdapter({
    id:'new-api.execute.v1', origin:siteOrigin,
    capabilities:['identity','read_status','submit_once','verify','classify_error'],
    async identity({expectedIdentity, context = {}} = {}) {
      if (!/^\d{1,20}$/.test(String(expectedIdentity ?? ''))) return null;
      const response = await pageFor(context).evaluate(async ({path}) => {
        const ids=[];
        const extract=value=>value?.id??value?.user?.id??value?.data?.id??value?.data?.user?.id??null;
        const uid=localStorage.getItem('uid'); if(/^\d{1,20}$/.test(String(uid??''))) ids.push(String(uid));
        for(const storage of [localStorage,sessionStorage]) for(let i=0;i<storage.length;i++) try { const id=extract(JSON.parse(storage.getItem(storage.key(i))||'null')); if(id!=null) ids.push(String(id)); } catch { /* unrelated storage */ }
        const unique=[...new Set(ids)]; if(unique.length!==1) return {status:200,body:{success:false,storageIds:unique}};
        const res=await fetch(path, {credentials:'include', headers:{Accept:'application/json','New-Api-User':unique[0]}});
        return {status:res.status, body:await res.json().catch(() => null), storageIds:unique};
      }, {path:paths.selfPath});
      const user = response?.body?.success === true ? (response.body.data?.user ?? response.body.data) : null;
      if (response?.status !== 200 || !response.storageIds?.includes(String(expectedIdentity)) || user?.id == null || String(user.id) !== String(expectedIdentity)) return null;
      return {userId:String(user.id), username:typeof user.username === 'string' ? user.username.slice(0,80) : null, origin:siteOrigin};
    },
    async read_status({identity, businessDate, context = {}} = {}) {
      const response = await pageFor(context).evaluate(async ({path,month,userId}) => {
        const res = await fetch(`${path}?month=${encodeURIComponent(month)}`, {credentials:'include', headers:{Accept:'application/json','New-Api-User':userId}});
        return {status:res.status, body:await res.json().catch(() => null)};
      }, {path:paths.statusPath, month:String(businessDate).slice(0,7), userId:String(identity?.userId??'')});
      if (response?.status !== 200) return {state:'unknown', reason:responseCause(response)};
      const stats = response.body?.data?.stats, records = stats?.records;
      if (!Array.isArray(records)) return {state:'unknown', reason:'invalid_response'};
      const today = records.filter(record => record.checkin_date === businessDate);
      if (today.some(record => record.user_id != null && String(record.user_id) !== String(identity?.userId))) return {state:'unknown', reason:'identity_mismatch'};
      if (stats.checked_in_today === true && today.some(record => record.quota_awarded != null)) return {state:'already_done', evidence:{authoritative:true, source:'new_api_checkin_calendar', businessDate}};
      if (stats.checked_in_today === false && today.length === 0) return {state:'not_signed', evidence:{authoritative:true, source:'new_api_checkin_calendar', businessDate}};
      return {state:'unknown', reason:'invalid_response'};
    },
    async submit_once({identity, context = {}} = {}) {
      let response;
      try { response = await pageFor(context).evaluate(async ({path,userId}) => {
          try {
            const res = await fetch(path, {method:'POST', credentials:'include', headers:{Accept:'application/json','New-Api-User':userId}});
            return {status:res.status, body:await res.json().catch(() => null)};
          } catch { return {status:0,body:null,networkError:true}; }
        }, {path:paths.signInPath, userId:String(identity?.userId ?? '')});
      } catch { return {state:'unknown', reason:'submit_transport_unknown', actionMayHaveHappened:true}; }
      if (response?.networkError) return {state:'unknown', reason:'submit_transport_unknown', actionMayHaveHappened:true, response};
      if (response?.status !== 200 && response?.status !== 201) return {state:'rejected', reason:responseCause(response), actionMayHaveHappened:false, response};
      if (response.body?.success === true || /已签到|已簽到|already/i.test(String(response.body?.message ?? ''))) return {state:'accepted', response};
      return {state:'rejected', reason:/验证码|captcha|turnstile|hcaptcha/i.test(String(response.body?.message ?? '')) ? 'challenge_required' : 'invalid_response', actionMayHaveHappened:false, response};
    },
    async verify({identity, businessDate, context = {}} = {}) {
      const status = await this.read_status({identity, businessDate, context});
      if (status.state === 'already_done') return {state:'confirmed', evidence:status.evidence};
      if (status.state === 'unknown') return {state:'unknown', reason:status.reason};
      return {state:'unknown', reason:'submission_not_visible'};
    },
    classify_error(error) { return responseCause({status:error?.status}); }
  });
}
