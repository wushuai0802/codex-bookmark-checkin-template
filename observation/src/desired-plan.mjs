import { normalizeOrigin } from './contracts.mjs';
import { shortLabel } from './display-identity.mjs';

const keyFor = row => `${normalizeOrigin(row.origin)}|${row.accountKey || 'site-default'}`;
export function desiredTargets(plan, config = {}) {
  if (!Array.isArray(plan?.targets) || plan.targets.length === 0) throw new Error('desired plan has no targets');
  const excluded = new Set(config.excludedOrigins ?? []);
  const targets = plan.targets.filter(target => !excluded.has(normalizeOrigin(target.origin))).map(target => {
    const origin = normalizeOrigin(target.origin);
    const primary = target.accountKey ? {} : config.oauthAccountIdentities?.[origin] ?? {};
    return { origin, title:shortLabel(target.title), accountKey:target.accountKey || primary.accountKey || 'site-default',
      accountId:target.accountId ?? primary.accountId ?? null, accountLabel:target.accountLabel ?? primary.accountLabel ?? null,
      folderNames:target.folderNames ?? [] };
  });
  // Configured supplements are explicitly in V1's desired plan, independent of results.
  for (const account of config.supplementalOAuthAccounts ?? []) targets.push({origin:normalizeOrigin(account.origin),
    title:shortLabel(account.title),accountKey:account.accountKey,accountId:account.accountId??null,accountLabel:account.accountLabel??null,folderNames:['supplemental-oauth']});
  const seen = new Set();
  for (const target of targets) {
    if (typeof target.accountKey !== 'string' || !/^[A-Za-z0-9._-]{1,80}$/.test(target.accountKey)) throw new Error('invalid desired account key');
    const key=keyFor(target); if(seen.has(key)) throw new Error('duplicate desired account task'); seen.add(key);
  }
  return targets;
}

export function reconcilePlan(targets, results) {
  const desired=new Map(targets.map(target=>[keyFor(target),target]));
  const observed=new Map(); const unexpected=[];
  for(const entry of results){
    const key=keyFor(entry);
    if(!desired.has(key)){unexpected.push({origin:normalizeOrigin(entry.origin),accountRefKey:shortLabel(entry.accountKey)||'site-default'});continue;}
    observed.set(key,[...(observed.get(key)||[]),entry]);
  }
  let missingCount=0,conflictCount=0;
  const entries=targets.map(target=>{
    const matches=observed.get(keyFor(target))??[];
    if(!matches.length){missingCount++;return {...target,status:'not_started',reason:'计划内任务尚无执行回执',missingResult:true,identityFromPlan:true};}
    const entry=matches[0];
    const reportedId=entry.accountId??entry.evidence?.accountId;
    if(matches.length>1 || (target.accountId&&reportedId&&String(target.accountId)!==String(reportedId))){
      conflictCount++;return {...target,status:'needs_attention',reason:'任务身份或回执重复冲突，禁止自动执行',reconciliationConflict:true,identityFromPlan:true};
    }
    return {...entry,origin:target.origin,accountKey:target.accountKey,title:target.title||entry.title,
      accountId:entry.accountId??target.accountId,accountLabel:entry.accountLabel??target.accountLabel,identityFromPlan:!entry.accountId&&!entry.evidence?.accountId};
  });
  return {entries,diagnostics:{missingCount,conflictCount,unexpectedCount:unexpected.length}};
}
