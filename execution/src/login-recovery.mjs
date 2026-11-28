import { safeErrorMessage } from "./security.mjs";
import { isCredentialLoginRoute } from "./url-routes.mjs";
import { ptFailureMessages } from "./checkin-contract.generated.mjs";
import {readOAuthProgress,oauthStageLabels} from './oauth-flow-diagnostics.mjs';
import {piggoOrigin,piggoCalendarUrl,piggoCalendarEvidence,piggoDay,piggoPageClasses} from './piggo-calendar.mjs';

const LOGIN_HELPER_STATUSES = new Set([
  "logged_in",
  "needs_attention",
  "deferred",
  "no_saved_credential",
  "credential_missing",
  "invalid_credential",
  "unsupported",
  "timeout",
  "failed",
]);

const LOGIN_FAILURE_CODES = new Set([
  "login_required",
  "account_mismatch",
  "configuration_mismatch",
  "upstream_login_required",
  "upstream_authorization_required",
  "managed_challenge",
  "oauth_timeout",
  "profile_busy",
  "browser_startup",
  "site_flow_changed",
  "oauth_recovery_failed",
  "oauth_rate_limited",
  "oauth_upstream_unavailable",
  "oauth_callback_rejected",
  "two_factor_required",
  "notice_acknowledgement_required",
  "daily_open_limit",
  "daily_recovery_limit",
  "passive_proof_unavailable",
  "captcha_requires_manual",
  "authentication_rejected",
  "authentication_unknown",
  "provider_unavailable",
  "login_not_allowed",
  "login_form_unreviewed",
  "login_form_changed",
  "readonly",
  "recovery_unavailable",
]);

const RETRYABLE_LOGIN_FAILURE_CODES = new Set([
  "managed_challenge",
  "oauth_timeout",
  "profile_busy",
  "browser_startup",
  "oauth_recovery_failed",
  "oauth_rate_limited",
  "oauth_upstream_unavailable",
]);

const TERMINAL_DAILY_CHECKIN_STATUSES = new Set(["signed", "already_signed"]);
const HELPER_STAGES = new Set([
  "piggo_helper_timeout",
  "piggo_stdout_timeout",
  "piggo_helper_nonzero",
  "piggo_stdout_empty",
  "unhandled_rejection",
  "uncaught_exception",
  "cdp_connect",
  "target_page",
  "recover_throw",
]);

export function nativePasswordLoginPage(pages,origin){
  const candidates=pages.filter(page=>{try{const url=new URL(page.url());return url.origin===origin&&!url.username&&!url.password;}catch{return false;}});
  return origin==='https://piggo.me'
    ?[...candidates].reverse().find(page=>isCredentialLoginRoute(page.url()))??candidates.at(-1)??null
    :candidates[0]??null;
}

export async function waitForNativePasswordLoginPage(getPages,origin,{timeoutMs=30000,clock=Date.now,
  sleep=milliseconds=>new Promise(resolve=>setTimeout(resolve,milliseconds))}={}){
  const deadline=clock()+timeoutMs;
  do{
    const page=nativePasswordLoginPage(getPages(),origin);
    if(page)return page;
    if(clock()>=deadline)return null;
    await sleep(Math.min(250,Math.max(1,deadline-clock())));
  }while(clock()<=deadline);
  return null;
}

function safeTerminalDailyCheckin(value) {
  const status = String(value?.status ?? "");
  if (!TERMINAL_DAILY_CHECKIN_STATUSES.has(status)) return null;
  const reason = safeErrorMessage(String(value?.reason || "登录助手确认今日签到完成")).slice(0, 240);
  const rawEvidence = value?.evidence;
  const evidence = {};
  if (rawEvidence && typeof rawEvidence === "object" && !Array.isArray(rawEvidence)) {
    const source = String(rawEvidence.source ?? "").trim();
    if (/^[a-z0-9_-]{1,40}$/i.test(source)) evidence.source = source;
    const createdAt = String(rawEvidence.createdAt ?? "").trim();
    if (createdAt && Number.isFinite(Date.parse(createdAt))) evidence.createdAt = new Date(createdAt).toISOString();
    const rewardAmount = Number(rawEvidence.rewardAmount);
    if (Number.isFinite(rewardAmount) && rewardAmount >= 0 && rewardAmount <= 1_000_000_000) {
      evidence.rewardAmount = rewardAmount;
    }
    for (const key of ["accountId", "userId"]) {
      const candidate = String(rawEvidence[key] ?? "").trim();
      if (candidate && /^\d{1,32}$/.test(candidate)) evidence[key] = candidate;
    }
    for (const key of ["businessDate", "checkinDate", "recordDate", "claimDate"]) {
      const candidate = String(rawEvidence[key] ?? "").trim();
      if (/^\d{4}-\d{2}-\d{2}$/.test(candidate)) evidence[key] = candidate;
    }
    const confirmedAt = String(rawEvidence.confirmedAt ?? "").trim();
    if (confirmedAt && Number.isFinite(Date.parse(confirmedAt))) evidence.confirmedAt = new Date(confirmedAt).toISOString();
    const statusSignal = String(rawEvidence.statusSignal ?? "").trim();
    if (statusSignal && /^[A-Za-z0-9_.:-]{1,80}$/.test(statusSignal)) evidence.statusSignal = statusSignal;
    const endpoint = String(rawEvidence.endpoint ?? "").trim();
    if (endpoint && endpoint.startsWith("/") && endpoint.length <= 160 && !/[\s?#]/.test(endpoint)) evidence.endpoint = endpoint;
    if (rawEvidence.authoritative === true) evidence.authoritative = true;
    if (rawEvidence.authoritative === false) evidence.authoritative = false;
    if (rawEvidence.requestMethod === 'POST') evidence.requestMethod = 'POST';
    if (rawEvidence.actionType === 'daily_entitlement_claim') evidence.actionType = rawEvidence.actionType;
  }
  return {
    status,
    reason,
    ...(Object.keys(evidence).length > 0 ? { evidence } : {}),
  };
}

// PigGo's native helper may return a passive unsigned receipt or a protected
// unknown as well as completion. Keep only the bound gate result, never a DOM.
function safePiggoDailyCheckin(value){
  if(value?.origin!==piggoOrigin||value.accountKey!=='site-default'||!/^[a-f0-9]{64}$/.test(value.profileBinding??'')||
    value.nativeGate!==true)return null;
  const identity={origin:piggoOrigin,url:piggoCalendarUrl,accountKey:'site-default',profileBinding:value.profileBinding,nativeGate:true};
  if(value.status==='needs_attention'&&value.failureCode==='submission_outcome_unknown'&&value.submissionAttempted===true){
    const diag={};
    if(typeof value.checkinStage==='string'&&/^[a-z][a-z_]{0,39}$/.test(value.checkinStage))diag.checkinStage=value.checkinStage;
    if(Number.isInteger(value.checkinHttpStatus)&&value.checkinHttpStatus>=100&&value.checkinHttpStatus<=599)diag.checkinHttpStatus=value.checkinHttpStatus;
    if(typeof value.firewallUsed==='boolean')diag.firewallUsed=value.firewallUsed;
    return {...identity,status:'needs_attention',failureCode:'submission_outcome_unknown',submissionAttempted:true,retryable:false,
      ...diag,
      reason:'猪猪同会话签到结果不明，保留提交意图，禁止自动重放'};
  }
  if(value.url!==piggoCalendarUrl||!['signed','already_signed','not_signed'].includes(value.status)||!piggoCalendarEvidence(value.evidence,value.status)||
    (value.status==='signed'?(value.submissionAttempted!==true||value.confirmationState!=='confirmed'):
      value.submissionAttempted!==false||value.receiptAccepted!==true))return null;
  const evidence=value.evidence,at=Date.parse(evidence.confirmedAt??'');
  if(!Number.isFinite(at)||!/^\d{4}-\d{2}-\d{2}$/.test(evidence.businessDate??'')||piggoDay(at)!==evidence.businessDate)return null;
  return {...identity,status:value.status,submissionAttempted:value.submissionAttempted,
    ...(value.status==='signed'?{confirmationState:'confirmed'}:{receiptAccepted:true}),
    evidence:{source:'api',authoritative:true,confirmedAt:new Date(at).toISOString(),businessDate:evidence.businessDate,
      pagePath:'/calendar',statusSignal:evidence.statusSignal,evidenceScope:'site_account_day'},
    ...(value.status==='not_signed'?{retryable:false}:{}),
    reason:value.status==='signed'?'猪猪同会话签到已由同账号日历回读确认并持久化':
      value.status==='already_signed'?'猪猪同账号日历已确认今日签到完成':'猪猪只读核验成功，今日尚未签到，提交未开放'};
}

export function parseLoginHelperResult(text) {
  const lines = String(text ?? "").split(/\r?\n/).map((line) => line.trim()).filter(line=>{
    if(!line)return false;
    try{return JSON.parse(line)?.type!=='checkin_oauth_progress';}catch{return true;}
  });
  for (let index = 0; index < lines.length; index += 1) {
    try {
      const value = JSON.parse(lines.slice(index).join("\n"));
      if (value && typeof value === "object") return value;
    } catch { /* helpers may include harmless non-JSON browser startup text */ }
  }
  for (const line of [...lines].reverse()) {
    try {
      const value = JSON.parse(line);
      if (value && typeof value === "object") return value;
    } catch { /* a compact result may appear before trailing diagnostic text */ }
  }
  return null;
}

export function loginHelperOutcome(text, fallback = "failed", progress = "") {
  const value = parseLoginHelperResult(text);
  const status = LOGIN_HELPER_STATUSES.has(String(value?.status)) ? String(value.status) : fallback;
  const failureCode = LOGIN_FAILURE_CODES.has(String(value?.failureCode))
    ? String(value.failureCode)
    : null;
  const messages = {
    logged_in: "已取得登录会话",
    needs_attention: "登录需要额外验证",
    no_saved_credential: "独立配置没有可用保存凭据",
    credential_missing: "没有配置受保护站点凭据",
    invalid_credential: "站点拒绝了当前凭据",
    unsupported: "未识别可自动提交的登录表单",
    timeout: "登录恢复流程超时",
    failed: "登录恢复流程失败",
  };
  const failureMessages = {
    login_required: "原 Profile 尚未取得有效登录会话",
    account_mismatch: "登录账号与配置身份不一致",
    configuration_mismatch: "OAuth 恢复配置不一致",
    upstream_login_required: "上游 OAuth 账号需要重新登录",
    upstream_authorization_required: "上游 OAuth 授权需要确认",
    managed_challenge: "上游 OAuth 安全验证未完成",
    oauth_timeout: "OAuth 回调等待超时",
    profile_busy: "OAuth 专属浏览器会话正被占用",
    browser_startup: "OAuth 浏览器恢复启动失败",
    site_flow_changed: "站点 OAuth 登录流程已变化",
    oauth_recovery_failed: "OAuth 自动恢复未完成",
    oauth_rate_limited: "OAuth 上游请求过多，需退避后重试",
    oauth_upstream_unavailable: "OAuth 上游回调服务暂时不可用",
    oauth_callback_rejected: "站点拒绝 OAuth 回调，未取得有效登录会话",
    two_factor_required: "站点要求完成异地登录 2FA 验证",
    notice_acknowledgement_required: ptFailureMessages.notice_acknowledgement_required,
    daily_open_limit: ptFailureMessages.daily_open_limit,
    daily_recovery_limit: "今日自动登录或解锁次数已用尽，请改日或人工核对",
    passive_proof_unavailable: "只读日历核验未取得可用状态，已保留固定诊断码供核对",
    captcha_requires_manual: "站点出现人工验证码，已停止自动登录等待人工处理",
    authentication_rejected: "站点拒绝了本次登录或解锁提交，未重试",
    authentication_unknown: "登录或解锁提交结果未确认，已保留证据且禁止重放",
    provider_unavailable: "未取得可用受保护凭据，无法执行自动登录或解锁",
    login_not_allowed: "当前站点未开启自动密码登录或缺少审阅授权",
    login_form_unreviewed: "登录或解锁表单未通过审阅检查，已停止自动填充",
    login_form_changed: "提交前登录表单或绑定状态已变化，已安全中止",
    readonly: "只读模式禁止打开或提交登录流程",
    recovery_unavailable: "登录或解锁恢复前提不满足，未继续执行",
  };
  const dailyCheckin = status === "logged_in" ? (value?.origin===piggoOrigin?
    safePiggoDailyCheckin(value?.dailyCheckin):safeTerminalDailyCheckin(value?.dailyCheckin)) : null;
  const diagnosticCode = ["invalid_credential", "credential_missing", "no_saved_credential"].includes(status)
    ? status
    : null;
  const retryable = status !== "logged_in" && (
    RETRYABLE_LOGIN_FAILURE_CODES.has(failureCode)
    || (!failureCode && ["timeout", "failed"].includes(status))
  );
  const diagnostic=readOAuthProgress(progress);
  // Fixed lowercase codes only, so the report can say why without carrying helper text.
  const recoveryCode=code=>typeof code==='string'&&/^[a-z][a-z_]{0,39}$/.test(code)?code:null;
  const helperStage=typeof value?.helperStage==='string'&&HELPER_STAGES.has(value.helperStage)?value.helperStage:null;
  const helperExitCode=status!=='logged_in'&&Number.isSafeInteger(value?.helperExitCode)
    &&value.helperExitCode>=-2147483648&&value.helperExitCode<=2147483647
    ?value.helperExitCode:null;
  const recovery=value?.nativeTwoFactorRecovery;
  const recoveryReason=recoveryCode(recovery?.reason);
  const providerReason=recoveryCode(recovery?.providerReason);
  const recoveryMode=['idle_unlock','password_login'].includes(recovery?.recoveryMode)?recovery.recoveryMode:null;
  const recoveryCodes=Object.fromEntries(['passiveStatus','passiveFailure','passiveStage','submitStage','postLoginForm',
    'afterStatus','afterFailure','afterStage'].map(key=>[key,recoveryCode(recovery?.[key])]).filter(([,code])=>code));
  if(piggoPageClasses.includes(recovery?.pageClass))recoveryCodes.pageClass=recovery.pageClass;
  if(recovery?.loginEnvelope==='unavailable')recoveryCodes.loginEnvelope='unavailable';
  // Bounded integers and same-origin API paths say where a submitted login stopped.
  const recoveryNumbers=Object.fromEntries([['loginHttpStatus',100,599],['meHttpStatus',100,599],['calendarHttpStatus',100,599],
    ['loginApiCode',-999_999_999,999_999_999],['loginPosts',0,9],['challengePosts',0,9]].filter(([key,min,max])=>Number.isSafeInteger(recovery?.[key])&&
    recovery[key]>=min&&recovery[key]<=max).map(([key])=>[key,recovery[key]]));
  // Every segment starts with a letter, so numeric account IDs never pass.
  const recoveryPath=item=>typeof item==='string'&&/^\/(?:[a-z][a-z0-9_-]{0,30}(?:\/[a-z][a-z0-9_-]{0,30}){0,7})?$/.test(item);
  const blockedPosts=Array.isArray(recovery?.blockedPosts)&&recovery.blockedPosts.length>0&&recovery.blockedPosts.length<=4&&
    recovery.blockedPosts.every(item=>recoveryPath(item)&&item.startsWith('/v1/web/'))?[...recovery.blockedPosts]:null;
  return {
    ...(recoveryReason?{recoveryReason}:{}),
    ...(providerReason?{providerReason}:{}),
    ...(recoveryMode?{recoveryMode}:{}),
    ...(helperStage?{helperStage}:{}),
    ...(helperExitCode!==null?{helperExitCode}:{}),
    ...recoveryCodes,
    ...recoveryNumbers,
    ...(typeof recovery?.noticeGate==='boolean'?{noticeGate:recovery.noticeGate}:{}),
    ...(recoveryPath(recovery?.pagePath)?{pagePath:recovery.pagePath}:{}),
    ...(recoveryPath(recovery?.loginPagePath)?{loginPagePath:recovery.loginPagePath}:{}),
    ...(blockedPosts?{blockedPosts}:{}),
    ...(failureCode==='daily_open_limit'&&typeof value?.nextEligibleAt==='string'?{nextEligibleAt:value.nextEligibleAt}:{}),
    ...(failureCode==='daily_open_limit'&&value?.retryExhaustedForDay===true?{retryExhaustedForDay:true}:{}),
    succeeded: status === "logged_in",
    status,
    diagnostic: (failureMessages[failureCode] ?? messages[status] ?? messages.failed)+
      (diagnostic&&status!=='logged_in'?`（阶段：${oauthStageLabels[diagnostic.oauthStage]}）`:''),
    ...(diagnostic??{}),
    ...(diagnosticCode ? { diagnosticCode } : {}),
    ...(failureCode ? { failureCode } : {}),
    ...(status !== "logged_in" ? { retryable } : {}),
    ...(dailyCheckin ? { dailyCheckin } : {}),
  };
}

export function piggoLoginDailyCheckin(method,outcome,{origin,accountKey='site-default',profileBinding,now=new Date()}={}){
  if(method!=='native_saved_password'||outcome?.succeeded!==true||origin!==piggoOrigin||accountKey!=='site-default')return null;
  const result=safePiggoDailyCheckin(outcome.dailyCheckin);
  if(!result||result.profileBinding!==profileBinding)return null;
  if(result.failureCode==='submission_outcome_unknown')return result;
  const at=Date.parse(result.evidence.confirmedAt);
  return at<=now.getTime()&&now.getTime()-at<=300_000&&result.evidence.businessDate===piggoDay(now)?result:null;
}

export function authoritativeLoginDailyCheckin(method, outcome, binding) {
  if(method==='native_saved_password'){
    const result=piggoLoginDailyCheckin(method,outcome,binding);
    return TERMINAL_DAILY_CHECKIN_STATUSES.has(result?.status)?result:null;
  }
  if (!["oauth", "native_oauth", "protected_credential"].includes(method) || outcome?.succeeded !== true) return null;
  return safeTerminalDailyCheckin(outcome.dailyCheckin);
}

function sameOriginHttpsUrl(value, expectedOrigin) {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.origin !== expectedOrigin || url.username || url.password) {
    throw new Error("登录恢复地址必须属于目标 HTTPS origin");
  }
  return url;
}

export function resolveLoginRecoveryUrl(origin, configuredUrl, observedUrl) {
  const expected = sameOriginHttpsUrl(origin, new URL(origin).origin).origin;
  if (configuredUrl) return sameOriginHttpsUrl(configuredUrl, expected).href;

  if (observedUrl) {
    try {
      const observed = sameOriginHttpsUrl(observedUrl, expected);
      if (isCredentialLoginRoute(observed.href)) {
        // Result URLs are diagnostics and their query values may already be
        // redacted as [VALUE]. Keep only the stable route when replaying them.
        observed.search = "";
        if (observed.hash.includes("?")) observed.hash = observed.hash.split("?", 1)[0];
        if (/\[VALUE\]/i.test(decodeURIComponent(observed.hash))) observed.hash = "";
        return observed.href;
      }
    } catch { /* invalid diagnostic URLs fall back to the conventional route */ }
  }
  return new URL("/login", expected).href;
}
