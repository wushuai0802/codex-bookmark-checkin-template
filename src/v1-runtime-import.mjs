import {normalizeOrigin} from './contracts.mjs';
import {displayIdentity} from './display-identity.mjs';
import {buildV2AdapterPlan} from './v1-v2-adapter-plan.mjs';

// Convert the V1 effective configuration into V2 metadata. Runtime secrets and
// V1 browser state are intentionally not part of this result.
export function importV1Runtime({config = {}, v1Catalog} = {}) {
  const accounts = [];
  const primary = Object.entries(config.oauthAccountIdentities ?? {}).map(([origin, account]) => ({...account, origin}));
  for (const account of [...primary, ...(config.supplementalOAuthAccounts ?? [])]) {
    if (!account?.accountKey || !account?.origin) continue;
    const origin = normalizeOrigin(account.origin);
    accounts.push({
      accountKey:String(account.accountKey), origin,
      identity:displayIdentity({userId:account.accountId, username:account.accountLabel, label:account.accountLabel, provider:account.provider, source:'configuration', idKind:'site'}),
      upstreamProvider:typeof account.upstreamProvider === 'string' ? account.upstreamProvider : null,
      upstreamAccount:typeof account.upstreamAccount === 'string' ? account.upstreamAccount : null,
      loginUrl:typeof account.loginUrl === 'string' ? new URL(account.loginUrl).origin : origin,
      v2ProfileRef:`data/v2-profiles/${String(account.accountKey)}`,
      v1ProfileAvailable:typeof account.automationUserDataDir === 'string' && account.automationUserDataDir.length > 0
    });
  }
  const unique = new Map(accounts.map(account => [account.accountKey, account]));
  const adapterPlan = v1Catalog ? buildV2AdapterPlan({v1Catalog}) : null;
  return {
    schemaVersion:1, mode:'v2_metadata_import', source:'v1-effective-config',
    executionEnabled:false, v1RemainsOwner:true,
    accounts:[...unique.values()].sort((a,b)=>a.accountKey.localeCompare(b.accountKey)),
    sharedSessions:Object.entries(config.oauthSessionProfiles ?? {}).map(([key])=>({key, v2SessionRef:`data/v2-sessions/${key}`, requiresUpstreamIdentityVerification:true})),
    adapterPlan,
    forbidden:['v1_profile_reuse','cookie_copy','secret_import','parallel_owner','blind_retry']
  };
}
