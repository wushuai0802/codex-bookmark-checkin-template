import {defineAdapter} from './adapter-contract.mjs';
import {validateReadRequest} from './readonly-adapters.mjs';

const safeUser = body => body?.success === true ? (body.data?.user ?? body.data) : null;
const responseCause = response => response?.status === 401 ? 'login_required'
  : response?.status === 403 ? 'access_challenge'
  : response?.status === 429 ? 'rate_limited'
  : !response?.status || response.status >= 500 ? 'unreachable' : 'invalid_response';

// A real V1 New API site is represented by this read-only V2 adapter first.
// There is deliberately no submit method: V1 remains the execution owner.
export function createNewApiReadonlyAdapter({origin} = {}) {
  const normalized = new URL(origin);
  if (normalized.protocol !== 'https:') throw Error('origin must use https');
  const siteOrigin = normalized.origin;
  return defineAdapter({
    id:'readonly.new-api.v1', origin:siteOrigin,
    capabilities:['identity','read_status','classify_error'],
    async identity({expectedIdentity, context = {}} = {}) {
      if (!/^\d{1,20}$/.test(String(expectedIdentity??''))) return null;
      const url = validateReadRequest('new-api', siteOrigin, '/api/user/self');
      const response = await context.request(url.pathname, {method:'GET', headers:{Accept:'application/json'}});
      const user = safeUser(response?.body);
      if (response?.status !== 200 || user?.id == null || String(user.id) !== String(expectedIdentity)) return null;
      return {userId:String(user.id), username:typeof user.username === 'string' ? user.username.slice(0,80) : null, origin:siteOrigin};
    },
    async read_status({identity, businessDate, context = {}} = {}) {
      const url = validateReadRequest('new-api', siteOrigin, `/api/user/checkin?month=${encodeURIComponent(String(businessDate).slice(0,7))}`);
      const response = await context.request(url.pathname + url.search, {method:'GET', headers:{Accept:'application/json'}});
      if (response?.status !== 200) return {state:'unknown', reason:responseCause(response)};
      const stats = response.body?.data?.stats, records = stats?.records;
      if (!Array.isArray(records)) return {state:'unknown', reason:'invalid_response'};
      const today = records.filter(record => record.checkin_date === businessDate);
      if (today.some(record => record.user_id != null && String(record.user_id) !== String(identity?.userId))) return {state:'unknown', reason:'identity_mismatch'};
      if (stats.checked_in_today === true && today.some(record => record.quota_awarded != null)) return {state:'already_done', evidence:{authoritative:true, source:'new_api_checkin_calendar', businessDate}};
      if (stats.checked_in_today === false && today.length === 0) return {state:'not_signed', evidence:{authoritative:true, source:'new_api_checkin_calendar', businessDate}};
      return {state:'unknown', reason:'invalid_response'};
    },
    classify_error(error) { return responseCause({status:error?.status}); }
  });
}
