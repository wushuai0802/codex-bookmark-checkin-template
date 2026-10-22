import crypto from 'node:crypto';
import { normalizeOrigin, redactText } from './contracts.mjs';
import {siteIdentityIndex} from './site-identity-index.mjs';
import {projectPtDiagnostic} from './pt-site-execution.mjs';
import {ptStatuses} from './checkin-contract.generated.mjs';
import {siteDisplayName} from './display-identity.mjs';
import {canonicalPtOrigin} from './pt-coordination.generated.mjs';
export const PT_STATUS_VALUES=ptStatuses;
export const PT_EVIDENCE_STATES=Object.freeze(['confirmed','guarded_read_needed','not_signed_confirmed',
  'verification_pending','monitor_only_unconfirmed','external_blocked','unavailable','disabled','unconfirmed']);

const SOURCE_VALUES = new Set(['harvest', 'legacy-checkin', 'execution-supplement', 'manual', 'v2-observer', 'other']);
const EVIDENCE_VALUES = new Set(['api', 'page_text', 'pt_page', 'usage_log', 'user_confirmation', 'manual', 'health_cache', 'harvest', 'none']);
const SENSITIVE_NAMES = new Set([
  'password', 'passwd', 'token', 'cookie', 'secret', 'authorization',
  'credential', 'credentials', 'profilepath', 'userdatadir', 'dpapi',
  'screenshot', 'accountid', 'accountlabel'
]);
const STATUS_ALIASES = new Map([
  ['checked_in', 'signed'], ['checkin_success', 'signed'],
  ['not_checked_in', 'not_signed'], ['missing', 'not_signed'],
  ['pending', 'unknown'], ['timeout', 'unreachable']
]);
const SOURCE_PRIORITY = new Map([
  ['execution-supplement', 5], ['legacy-checkin', 4], ['harvest', 3], ['v2-observer', 2], ['manual', 1], ['other', 0]
]);

function sensitiveKey(key) {
  return SENSITIVE_NAMES.has(String(key).replaceAll('_', '').toLowerCase());
}

function assertNoSensitiveFields(value, location = '$') {
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (sensitiveKey(key)) throw new Error(`sensitive field leaked at ${location}.${key}`);
    assertNoSensitiveFields(child, `${location}.${key}`);
  }
}

function parseIso(value, fallback) {
  const date = new Date(value ?? fallback);
  return Number.isNaN(date.getTime()) ? new Date(fallback).toISOString() : date.toISOString();
}

function normalizeStatus(value) {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  const status = STATUS_ALIASES.get(normalized) ?? normalized;
  return PT_STATUS_VALUES.includes(status) ? status : 'unknown';
}

function normalizeSource(value, fallback = 'other') {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return SOURCE_VALUES.has(normalized) ? normalized : fallback;
}

function normalizeEvidenceSource(value, fallback = 'none') {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return EVIDENCE_VALUES.has(normalized) ? normalized : fallback;
}

function normalizeOriginForStatus(value) {
  if (typeof value !== 'string' || value.length > 255) throw new Error('PT status origin must be a short URL');
  const parsed = new URL(value.trim());
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password) {
    throw new Error('PT status origin must be HTTPS without credentials');
  }
  return canonicalPtOrigin(normalizeOrigin(value));
}

function normalizeAccountRef(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string' || !/^acct_[a-f0-9]{16}$/.test(value)) {
    throw new Error('PT status accountRef is invalid');
  }
  return value;
}

function ageFor(observedAt, generatedAt, maxAgeHours) {
  const observed = new Date(observedAt).getTime();
  const generated = new Date(generatedAt).getTime();
  if (!Number.isFinite(observed) || !Number.isFinite(generated)) return { fresh: false, ageHours: null };
  const ageHours = (generated - observed) / 3600000;
  const fresh = ageHours >= 0 && ageHours <= maxAgeHours;
  return { fresh, ageHours: Number(Math.max(0, ageHours).toFixed(3)) };
}

function evidenceFor(input, status) {
  const evidence = input?.evidence && typeof input.evidence === 'object' ? input.evidence : {};
  const authoritative = evidence.authoritative === true;
  const source = normalizeEvidenceSource(evidence.source, 'none');
  const summary = redactText(evidence.summary ?? input?.reason ?? '');
  return {
    source,
    authoritative,
    summary,
    redacted: true,
    ...(Number.isFinite(Date.parse(evidence.confirmedAt))?{confirmedAt:new Date(evidence.confirmedAt).toISOString()}:{}),
    ...(/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(evidence.businessDate??'')?{businessDate:evidence.businessDate}:{}),
    ...(evidence.evidenceScope==='site_account_day'?{evidenceScope:evidence.evidenceScope}:{}),
    ...(evidence.verification==='task_disabled'?{verification:'task_disabled'}:{}),
    ...((evidence.readSafety??input?.readSafety)==='reviewed_passive'?{readSafety:'reviewed_passive'}:{}),
    ...(/^[a-z0-9_]{1,80}$/.test(evidence.statusSignal??'')?{statusSignal:evidence.statusSignal}:{}),
    ...(/^[a-f0-9]{64}$/.test(evidence.profileBinding??input?.profileBinding??'')?{profileBinding:evidence.profileBinding??input.profileBinding}:{}),
    statusVerified: authoritative && ['signed', 'already_signed', 'not_signed'].includes(status)
  };
}

function stableSiteRef(origin, accountRef) {
  const digest = crypto.createHash('sha256').update(`${origin}|${accountRef ?? 'site-default'}`, 'utf8').digest('hex');
  return `pt_${digest.slice(0, 16)}`;
}

function displayNameFor(target, origin) {
  const candidate = target?.displayName ?? target?.title ?? target?.name;
  const canonical = siteDisplayName(origin, null);
  if (canonical) return canonical;
  if (typeof candidate === 'string' && candidate.trim()) return redactText(candidate).slice(0, 80);
  return origin.replace(/^https:\/\//, '');
}

function normalizeObservation(input, {
  defaultSource = 'other', generatedAt, maxAgeHours = 26,
  inLegacyPlan = false, displayName = null, fallbackObservedAt = generatedAt
} = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('PT status observation must be an object');
  assertNoSensitiveFields(input);
  const origin = normalizeOriginForStatus(input.origin);
  const source = normalizeSource(input.source, defaultSource);
  const status = normalizeStatus(input.status);
  const observedAt = input.observedAt === null ? null : parseIso(input.observedAt, fallbackObservedAt);
  const freshness = ageFor(observedAt, generatedAt, maxAgeHours);
  const accountRef = normalizeAccountRef(input.accountRef);
  const evidence = evidenceFor(input, status);
  const supplementCandidate = status === 'not_signed' && evidence.statusVerified && freshness.fresh;
  return {
    source,
    origin,
    ...projectPtDiagnostic(input),
    ...(typeof input.submissionAttempted==='boolean'?{submissionAttempted:input.submissionAttempted}:{}),
    displayName: displayName ?? displayNameFor(input, origin),
    accountRef,
    status,
    observedAt,
    freshness,
    evidence,
    inLegacyPlan: inLegacyPlan || input.inLegacyPlan === true,
    managedBy: normalizeSource(input.managedBy, source),
    supplementCandidate,
    supplementAction: supplementCandidate ? 'manual_review_only' : 'none'
  };
}

export function normalizePtStatusReport(report, {
  generatedAt = new Date().toISOString(), businessDate = null, maxAgeHours = 26
} = {}) {
  if (!report || typeof report !== 'object' || Array.isArray(report)) throw new Error('PT status report must be an object');
  assertNoSensitiveFields(report);
  const reportGeneratedAt = parseIso(report.generatedAt, generatedAt);
  const source = normalizeSource(report.source, 'other');
  const sites = Array.isArray(report.sites) ? report.sites : [];
  const unique = new Map();
  for (const item of sites) {
    const observation = normalizeObservation({...item,evidence:{...item.evidence,
      ...(/^\d{4}-\d{2}-\d{2}$/.test(report.businessDate??'')&&!item.evidence?.businessDate?{businessDate:report.businessDate}:{})}}, {
      defaultSource: source,
      generatedAt,
      maxAgeHours,
      displayName: displayNameFor(item, normalizeOriginForStatus(item.origin))
    });
    const key = `${observation.origin}|${observation.accountRef ?? 'site-default'}|${observation.source}`;
    const previous = unique.get(key);
    if (!previous || new Date(observation.observedAt) >= new Date(previous.observedAt)) unique.set(key, observation);
  }
  return {
    schemaVersion: 1,
    generatedAt: reportGeneratedAt,
    businessDate: typeof report.businessDate === 'string' ? report.businessDate : businessDate,
    mode: 'status_observe_only',
    source,
    sites: [...unique.values()].sort((a, b) => `${a.origin}|${a.accountRef ?? ''}`.localeCompare(`${b.origin}|${b.accountRef ?? ''}`))
  };
}

function betterObservation(a, b) {
  const confirmedCompletion = item => item.freshness.fresh && item.evidence.authoritative
    && ['signed', 'already_signed'].includes(item.status);
  const unconfirmedObservation = item => !item.evidence.authoritative;
  if (a.status === 'unknown' && !a.evidence.authoritative && confirmedCompletion(b)) return b;
  if (b.status === 'unknown' && !b.evidence.authoritative && confirmedCompletion(a)) return a;
  if (confirmedCompletion(a) && unconfirmedObservation(b)) return a;
  if (confirmedCompletion(b) && unconfirmedObservation(a)) return b;
  // Rank equivalent authorities by source. Opposing signed/unsigned signals
  // remain a discrepancy and keep the newer observation; neither authorizes
  // a submission while the conflict is unresolved.
  const statusKind=item=>['signed','already_signed'].includes(item.status)?'signed':item.status;
  if (a.evidence.authoritative && b.evidence.authoritative &&
      statusKind(a)===statusKind(b) &&
      (SOURCE_PRIORITY.get(a.source) ?? 0) !== (SOURCE_PRIORITY.get(b.source) ?? 0)) {
    return (SOURCE_PRIORITY.get(a.source) ?? 0) > (SOURCE_PRIORITY.get(b.source) ?? 0) ? a : b;
  }
  const time = new Date(a.observedAt) - new Date(b.observedAt);
  if (time !== 0) return time > 0 ? a : b;
  return (SOURCE_PRIORITY.get(a.source) ?? 0) >= (SOURCE_PRIORITY.get(b.source) ?? 0) ? a : b;
}

export function classifyPtEvidenceState(site) {
  const effective = site?.effective ?? {};
  const status = effective.fresh===true?effective.status:'unknown';
  const possiblyUnconfirmed=item=>item.failureCode==='submission_outcome_unknown'||
    item.submissionAttempted===true&&(!['signed','already_signed'].includes(item.status)||item.authoritative!==true);
  const submitted=effective.fresh===true&&possiblyUnconfirmed(effective)||
    site.observations?.some(item=>item.fresh&&possiblyUnconfirmed(item))||
    ['submission_outcome_unknown','unverified_prior_attempt'].includes(site?.recovery?.code);
  if (effective.fresh===true && ['signed', 'already_signed'].includes(status) && effective.authoritative === true && !site.discrepancy &&
      (!submitted||currentBoundCompletion(site,effective.evidence?.businessDate))) return 'confirmed';
  if(effective.fresh===true&&status==='not_available'&&effective.authoritative===true)
    return effective.evidence?.verification==='task_disabled'?'disabled':'unavailable';
  const moved=item=>[item?.failureCode,item?.underlyingFailureCode].some(code=>['site_migration','bookmark_origin_changed'].includes(code));
  if (effective.fresh===true&&(effective.siteCondition === 'site_maintenance' || effective.retryCause==='rate_limit' ||
      moved(effective)||site.observations?.some(item=>item.fresh&&moved(item))||
      ['tls_certificate_invalid', 'tls_handshake_failed', 'site_server_error'].includes(effective.failureCode))) {
    return 'external_blocked';
  }
  if (submitted) {
    return 'verification_pending';
  }
  if(effective.fresh===true&&status==='not_signed'&&effective.authoritative===true&&!site.discrepancy)return 'not_signed_confirmed';
  if (!site?.inLegacyPlan && !site?.fallbackEnabled && !['signed','already_signed'].includes(status)) return 'monitor_only_unconfirmed';
  if ((site?.inLegacyPlan||site?.fallbackEnabled) && !['signed','already_signed'].includes(status)) return 'guarded_read_needed';
  return 'unconfirmed';
}

function currentBoundCompletion(site,businessDate,{passiveOnly=false}={}){
  const positive=site?.effective,proof=positive?.evidence??{};
  const passive=positive?.source==='execution-supplement'&&proof.readSafety==='reviewed_passive'&&positive?.submissionAttempted===false;
  const formal=positive?.submissionAttempted===true&&positive?.failureCode!=='submission_outcome_unknown';
  return positive?.fresh===true&&positive.authoritative===true&&['signed','already_signed'].includes(positive.status)&&!site.discrepancy&&
    ['execution-supplement','legacy-checkin'].includes(positive.source)&&
    proof.businessDate===businessDate&&proof.evidenceScope==='site_account_day'&&
    (passiveOnly?passive:passive||formal)&&
    /^[a-f0-9]{64}$/.test(proof.profileBinding??'')&&Number.isFinite(Date.parse(proof.confirmedAt))&&
    Boolean(site.accountRef)&&
    (site.observations??[]).some(item=>(item.failureCode==='submission_outcome_unknown'||
      item.submissionAttempted===true&&(!['signed','already_signed'].includes(item.status)||item.authoritative!==true))&&
      item.fresh&&item.evidence?.profileBinding===proof.profileBinding&&Date.parse(item.observedAt)<=Date.parse(proof.confirmedAt));
}

export function ptUnknownReconciled(site,businessDate){
  return currentBoundCompletion(site,businessDate,{passiveOnly:true})&&
    (site.observations??[]).some(item=>item.fresh&&(item.failureCode==='submission_outcome_unknown'||
      item.submissionAttempted===true&&(!['signed','already_signed'].includes(item.status)||item.authoritative!==true)));
}

function mergeSiteObservations(observations, target) {
  const ordered = [...observations].sort((a, b) => new Date(b.observedAt) - new Date(a.observedAt));
  const effective = ordered.filter(item=>item.freshness.fresh)
    .reduce((current, item) => current ? betterObservation(current, item) : item, null);
  const bySource = new Map();
  for (const item of ordered) {
    const previous = bySource.get(item.source);
    if (!previous || new Date(item.observedAt) > new Date(previous.observedAt)) bySource.set(item.source, item);
  }
  const sourceStatuses = [...bySource.values()].sort((a, b) => a.source.localeCompare(b.source)).map((item) => ({
    source: item.source, status: item.status, observedAt: item.observedAt,
    fresh: item.freshness.fresh, authoritative: item.evidence.authoritative
  }));
  const distinctStatuses = new Set(sourceStatuses.filter((item) => item.authoritative&&item.fresh)
    .map((item) => item.status==='already_signed'?'signed':item.status));
  const supplementCandidate = distinctStatuses.size <= 1 && effective?.supplementCandidate === true;
  return {
    siteRef: stableSiteRef(ordered[0].origin, ordered[0].accountRef),
    origin: ordered[0].origin,
    displayName: target ? displayNameFor(target, ordered[0].origin)
      : ordered.find((item) => item.displayName)?.displayName ?? displayNameFor(target, ordered[0].origin),
    accountRef: ordered[0].accountRef,
    inLegacyPlan: ordered.some((item) => item.inLegacyPlan),
    managedBy: [...new Set(ordered.map((item) => item.managedBy))].sort().join(' + '),
    effective: effective ? {
      source: effective.source, status: effective.status, observedAt: effective.observedAt,
      ...projectPtDiagnostic(effective),
      ...(typeof effective.submissionAttempted==='boolean'?{submissionAttempted:effective.submissionAttempted}:{}),
      fresh: effective.freshness.fresh, authoritative: effective.evidence.authoritative,
      evidence: {...effective.evidence}
    } : {source:'v2-observer',status:'unknown',observedAt:null,fresh:false,authoritative:false,
      evidence:{source:'none',authoritative:false,summary:'尚无今日确认回执',redacted:true,statusVerified:false}},
    sourceStatuses,
    discrepancy: distinctStatuses.size > 1,
    supplementCandidate,
    supplementAction: supplementCandidate ? 'manual_review_only' : 'none',
    observations: ordered.map((item) => ({
      source: item.source, status: item.status, observedAt: item.observedAt,
      ...projectPtDiagnostic(item),
      ...(typeof item.submissionAttempted==='boolean'?{submissionAttempted:item.submissionAttempted}:{}),
      fresh: item.freshness.fresh, authoritative: item.evidence.authoritative,
      evidence: item.evidence
    }))
  };
}

export function buildPtStatus({
  tasks = [], receipts = [], planTargets = [], externalReport = null, fallbackReport = null, monitorCatalog = null,
  fallbackOnlyEnabled = false, recoveryReport = null,
  generatedAt = new Date().toISOString(), businessDate = null, maxAgeHours = 26
} = {}) {
  const report = externalReport
    ? normalizePtStatusReport(externalReport, { generatedAt, businessDate, maxAgeHours })
    : null;
  const supplemental = fallbackReport
    ? normalizePtStatusReport(fallbackReport, { generatedAt, businessDate, maxAgeHours })
    : null;
  if(supplemental && (supplemental.source!=='execution-supplement'||supplemental.businessDate!==businessDate))throw Error('PT fallback report has the wrong source or date');
  const targets = new Map();
  const stableFallbackAt = businessDate ? `${businessDate}T00:00:00.000Z` : generatedAt;
  const siteIndex=siteIdentityIndex({catalog:monitorCatalog,planTargets});
  for (const target of planTargets) {
    try {
      const origin = normalizeOriginForStatus(target.origin);
      // A monitored PT site may be explicitly configured under another
      // execution folder (OpenCD is currently labelled 公益站).
      if (siteIndex.get(origin)?.kind!=='pt') continue;
      targets.set(origin, { ...target, origin });
    } catch { /* Invalid bookmark targets are handled by the main bridge. */ }
  }
  const receiptByTask = new Map(receipts.map((receipt) => [receipt.taskId, receipt]));
  const grouped = new Map();
  const add = (item) => {
    const key = `${item.origin}|${item.accountRef ?? 'site-default'}`;
    const list = grouped.get(key) ?? [];
    list.push(item);
    grouped.set(key, list);
  };
  for (const task of tasks) {
    let taskOrigin;
    try { taskOrigin = normalizeOriginForStatus(task.origin); } catch { continue; }
    if (!targets.has(taskOrigin)) continue;
    const receipt = receiptByTask.get(task.taskId);
    add(normalizeObservation({
      origin: taskOrigin,
      accountRef: task.accountRef,
      status: task.observedStatus,
      observedAt: task.observedStatus === 'not_started' ? null : receipt?.observedAt ?? generatedAt,
      source: 'legacy-checkin',
      managedBy: 'legacy-checkin',
      inLegacyPlan: true,
      ...(/^[a-f0-9]{64}$/.test(task.profileBinding??'')?{profileBinding:task.profileBinding}:{}),
      ...projectPtDiagnostic(task),
      ...(typeof task.submissionAttempted==='boolean'?{submissionAttempted:task.submissionAttempted}:{}),
      evidence: receipt?.evidence ?? { source: 'none', authoritative: false, summary: '' }
    }, { generatedAt, maxAgeHours, inLegacyPlan: true, fallbackObservedAt: stableFallbackAt, displayName: displayNameFor(targets.get(taskOrigin), taskOrigin) }));
  }
  for (const [origin, target] of targets) {
    if ([...grouped.keys()].some((key) => key.startsWith(`${origin}|`))) continue;
    add(normalizeObservation({
      origin, status: 'unknown', source: 'legacy-checkin', managedBy: 'legacy-checkin',
      inLegacyPlan: true, observedAt: generatedAt,
      evidence: { source: 'none', authoritative: false, summary: '未出现在最近一次 v1 结果中' }
    }, { generatedAt, maxAgeHours, inLegacyPlan: true, fallbackObservedAt: stableFallbackAt, displayName: displayNameFor(target, origin) }));
  }
  const monitorSites = new Map((monitorCatalog?.sites ?? []).map(site => [normalizeOriginForStatus(site.origin), site]));
  for (const item of report?.sites ?? []) {
    if (monitorCatalog && !monitorSites.has(item.origin) && !targets.has(item.origin)) continue;
    const matches = tasks.filter(task => {
      try { return normalizeOriginForStatus(task.origin) === item.origin; } catch { return false; }
    });
    // An external default-account observation may join only a single known account.
    if (!item.accountRef && matches.length === 1) item.accountRef = matches[0].accountRef;
    add(item);
  }
  for(const item of supplemental?.sites??[]){
    if(!monitorSites.has(item.origin) && !targets.has(item.origin))continue;
    const matches=tasks.filter(task=>{
      try { return normalizeOriginForStatus(task.origin) === item.origin; } catch { return false; }
    });
    if(!item.accountRef&&matches.length===1)item.accountRef=matches[0].accountRef;
    add(item);
  }
  for (const [origin, site] of monitorSites) {
    if ([...grouped.keys()].some(key => key.startsWith(`${origin}|`))) continue;
    add(normalizeObservation({ origin, displayName: site.displayName, source: 'v2-observer',
      status: 'unknown', observedAt: null, evidence: { source: 'none', authoritative: false,
        summary: '已纳入书签监测，暂无今日签到证据' }
    }, { generatedAt, maxAgeHours }));
  }
  // A catalog is inventory, never evidence. Success must belong to this business day.
  for (const items of grouped.values()) for (const item of items) {
    const observedDay = item.observedAt ? new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date(item.observedAt)) : null;
    if (!item.observedAt || (businessDate && observedDay !== businessDate)) {
      item.freshness.fresh = false;
      item.supplementCandidate = false;
    }
    const confirmed=Date.parse(item.evidence.confirmedAt??'');
    const matching=tasks.filter(task=>{
      try{return normalizeOriginForStatus(task.origin)===item.origin&&(task.accountRef??null)===(item.accountRef??null);}catch{return false;}
    });
    const expectedBinding=matching.length===1?matching[0].profileBinding:null;
    if((item.evidence.businessDate&&item.evidence.businessDate!==businessDate)||
       (expectedBinding&&item.evidence.profileBinding&&expectedBinding!==item.evidence.profileBinding)||
       (Number.isFinite(confirmed)&&(confirmed>Date.parse(generatedAt)+60_000||
         new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai'}).format(new Date(confirmed))!==businessDate))){
      item.evidence.authoritative=false;
      item.evidence.statusVerified=false;
      item.supplementCandidate=false;
    }
  }
  const sites = [...grouped.values()].map((items) => {
    const site = {...mergeSiteObservations(items, targets.get(items[0].origin)??monitorSites.get(items[0].origin)),
      fallbackEnabled:fallbackOnlyEnabled && monitorSites.has(items[0].origin)};
    return site;
  }).sort((a, b) => a.origin.localeCompare(b.origin) || (a.accountRef ?? '').localeCompare(b.accountRef ?? ''));
  if(recoveryReport?.businessDate===businessDate)for(const site of sites){
    const recovery=recoveryReport.sites?.find(item=>item.origin===site.origin);
    if(!recovery||!['prior_outcome_unknown','submission_outcome_unknown','unverified_prior_attempt'].includes(recovery.code))continue;
    site.recovery={code:recovery.code,blockedSince:recovery.blockedSince,summary:redactText(recovery.summary)};
    // Earlier uncertainty remains audit metadata, not evidence about today.
    if(recovery.code!=='prior_outcome_unknown'&&!['signed','already_signed'].includes(site.effective.status)){
      const detail=site.effective.evidence.summary;
      site.effective.evidence.summary=site.recovery.summary+
        (detail&&/维护|登录|验证|验证码|暂时不可用/.test(detail)?`；${detail}`:'');
    }
  }
  for(const site of sites){
    if(['signed','already_signed'].includes(site.effective.status))continue;
    const maintenance=site.observations.find(item=>item.fresh&&item.siteCondition==='site_maintenance');
    if(!maintenance)continue;
    site.effective.siteCondition='site_maintenance';
    site.effective.evidence.summary=redactText(maintenance.evidence.summary||'只读检查确认站点维护，等待恢复后核验');
  }
  for(const site of sites){
    site.evidenceState=classifyPtEvidenceState(site);
    // A display success is not automatically a submission reconciliation.
    // Only an account/day/profile-bound passive receipt closes that audit.
    if(ptUnknownReconciled(site,businessDate))site.reconciledFromUnknown=true;
  }
  const status = Object.fromEntries(PT_STATUS_VALUES.map((value) => [value, 0]));
  for (const site of sites) status[site.effective?.status ?? 'unknown'] += 1;
  return {
    schemaVersion: 1,
    generatedAt: new Date(generatedAt).toISOString(),
    businessDate,
    mode: 'status_observe_only',
    sources: [...new Set(sites.flatMap((site) => site.sourceStatuses.map((item) => item.source)))].sort(),
    counts: {
      sites: sites.length,
      inLegacyPlan: sites.filter((site) => site.inLegacyPlan).length,
      externalOnly: sites.filter((site) => !site.inLegacyPlan).length,
      fallbackOnly: sites.filter((site) => site.fallbackEnabled && !site.inLegacyPlan).length,
      fresh: sites.filter((site) => site.effective?.fresh).length,
      discrepancies: sites.filter((site) => site.discrepancy).length,
      supplementCandidates: sites.filter((site) => site.supplementCandidate).length,
      monitorOnlyUnconfirmed: sites.filter(site => site.evidenceState === 'monitor_only_unconfirmed').length,
      guardedReadNeeded: sites.filter(site => site.evidenceState === 'guarded_read_needed').length,
      verificationPending: sites.filter(site => site.evidenceState === 'verification_pending').length,
      externalBlocked: sites.filter(site => site.evidenceState === 'external_blocked').length,
      notSignedConfirmed: sites.filter(site => site.evidenceState === 'not_signed_confirmed').length,
      status
    },
    executionEnabled: false,
    sites
  };
}
