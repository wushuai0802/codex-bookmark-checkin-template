// AnyRouter is deliberately read-only in V2 until its dynamic route contract
// is independently reviewed. The transport is injected by the worker so this
// module has no dependency on V1 helpers or hidden POST side effects.
export async function observeAnyRouter({request, expectedId, now = new Date().toISOString()} = {}) {
  const base={schemaVersion:1,adapter:'anyrouter-route.v1',mode:'observe_only',origin:'https://anyrouter.top',mutationCount:0,observedAt:now};
  if(typeof request!=='function'||!/^[0-9]{1,20}$/.test(String(expectedId??''))) return {...base,status:'unknown',cause:'expected_identity_or_transport_missing'};
  let self;
  try { self=await request('/api/user/self',{method:'GET',headers:{Accept:'application/json','New-Api-User':String(expectedId)}}); }
  catch { return {...base,status:'unknown',cause:'unreachable'}; }
  const user=self?.body?.data?.user??self?.body?.data;
  if(self?.status===401||self?.status===403) return {...base,status:'unknown',cause:'login_required'};
  if(self?.status!==200||self?.body?.success!==true||String(user?.id??'')!==String(expectedId)) return {...base,status:'unknown',cause:'identity_mismatch'};
  return {...base,status:'unknown',cause:'dynamic_route_contract_pending',identity:{userId:String(user.id),verified:true}};
}
