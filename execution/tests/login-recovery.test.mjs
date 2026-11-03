import test from "node:test";
import assert from "node:assert/strict";
import {
  authoritativeLoginDailyCheckin,
  loginHelperOutcome,
  parseLoginHelperResult,
  resolveLoginRecoveryUrl,
  nativePasswordLoginPage,
  waitForNativePasswordLoginPage,
} from "../src/login-recovery.mjs";

test('PigGo native recovery selects its newest actual login tab rather than a restored error or home page',()=>{
  const origin='https://piggo.me',page=url=>({url:()=>url});
  const old=page(origin+'/takelogin.php'),older=page(origin+'/login.php?previous=1'),fresh=page(origin+'/login.php');
  assert.equal(nativePasswordLoginPage([old,older,page('https://foreign.example/login.php'),fresh],origin),fresh);
  assert.equal(nativePasswordLoginPage([old],origin),old);
  assert.equal(nativePasswordLoginPage([page('https://foreign.example/login.php')],origin),null);
  assert.equal(nativePasswordLoginPage([old,fresh],'https://other.example'),null);
});

test('a ready native debugging port waits for its target page and never selects an unrelated tab',async()=>{
  const origin='https://piggo.me',blank={url:()=> 'about:blank'},foreign={url:()=> 'https://foreign.example/'},login={url:()=>origin+'/login.php'};
  let at=0,reads=0;
  const options={timeoutMs:1000,clock:()=>at,sleep:async milliseconds=>{at+=milliseconds;}};
  const page=await waitForNativePasswordLoginPage(()=>++reads<3?[blank,foreign]:[blank,login],origin,options);
  assert.equal(page,login);assert.equal(reads,3);
  at=0;assert.equal(await waitForNativePasswordLoginPage(()=>[blank,foreign],origin,options),null);assert.equal(at,1000);
});

test("登录助手必须明确返回 logged_in 才算成功", () => {
  assert.deepEqual(parseLoginHelperResult('startup\n{"status":"logged_in"}\n'), { status: "logged_in" });
  assert.deepEqual(parseLoginHelperResult('browser startup\n{\n  "status": "logged_in"\n}\n'), { status: "logged_in" });
  assert.equal(loginHelperOutcome('{"status":"logged_in"}').succeeded, true);
  assert.equal(loginHelperOutcome('{"status":"needs_attention"}').succeeded, false);
  assert.equal(loginHelperOutcome("browser startup text").succeeded, false);
});

test("登录助手保留二次验证终态且禁止普通重试", () => {
  const outcome = loginHelperOutcome('{"status":"needs_attention","failureCode":"two_factor_required"}');
  assert.equal(outcome.succeeded, false);
  assert.equal(outcome.failureCode, "two_factor_required");
  assert.equal(outcome.retryable, false);
});

test("登录助手保留恢复原因代码且丢弃其他文本", () => {
  const outcome = loginHelperOutcome(JSON.stringify({ status: "needs_attention", failureCode: "two_factor_required",
    nativeTwoFactorRecovery: { attempted: false, accepted: false, reason: "provider_unavailable", providerReason: "vault_locked" } }));
  assert.equal(outcome.recoveryReason, "provider_unavailable");
  assert.equal(outcome.providerReason, "vault_locked");
  assert.equal(outcome.failureCode, "two_factor_required");
  assert.equal(outcome.retryable, false);
  const unsafe = loginHelperOutcome(JSON.stringify({ status: "needs_attention",
    nativeTwoFactorRecovery: { reason: "user@example.com", providerReason: "Secret Text" } }));
  assert.equal(unsafe.recoveryReason, undefined);
  assert.equal(unsafe.providerReason, undefined);
  assert.equal(loginHelperOutcome('{"status":"logged_in"}').recoveryReason, undefined);
});

test('passive login diagnostics survive result projection using the recovery reason code rules',()=>{
  const outcome=loginHelperOutcome(JSON.stringify({status:'needs_attention',failureCode:'two_factor_required',
    nativeTwoFactorRecovery:{reason:'passive_proof_unavailable',passiveStatus:'unconfirmed',
      passiveFailure:'authoritative_status_unavailable',passiveStage:'http_status',bodyText:'PRIVATE RESPONSE'}}));
  assert.equal(outcome.recoveryReason,'passive_proof_unavailable');assert.equal(outcome.passiveStatus,'unconfirmed');
  assert.equal(outcome.passiveFailure,'authoritative_status_unavailable');assert.equal(outcome.passiveStage,'http_status');
  assert.equal(outcome.failureCode,'two_factor_required');assert.equal(outcome.retryable,false);
  assert.doesNotMatch(JSON.stringify(outcome),/PRIVATE RESPONSE/);
  for(const code of ['https://private.example/path','PRIVATE','has space','with-hyphen','login_required\n',
    'a'.repeat(41),42,null,{},'']){
    const unsafe=loginHelperOutcome(JSON.stringify({status:'needs_attention',nativeTwoFactorRecovery:{
      passiveStatus:code,passiveFailure:code,passiveStage:code}}));
    for(const key of ['passiveStatus','passiveFailure','passiveStage'])assert.equal(unsafe[key],undefined);
  }
  for(const key of ['passiveStatus','passiveFailure','passiveStage'])
    assert.equal(loginHelperOutcome('{"status":"logged_in"}')[key],undefined);
});

test('submitted login diagnostics keep only stage codes, bounded numbers and same-origin API paths',()=>{
  const outcome=loginHelperOutcome(JSON.stringify({status:'needs_attention',failureCode:'two_factor_required',
    nativeTwoFactorRecovery:{reason:'authentication_unknown',submitStage:'post_login_receipt',postLoginForm:'unchanged',
      afterStatus:'login_required',afterFailure:'login_required',afterStage:'authentication',loginHttpStatus:200,loginApiCode:1001,
      loginPosts:1,challengePosts:1,loginPagePath:'/login',blockedPosts:['/v1/web/auth/srp/verify'],msg:'PRIVATE RESPONSE'}}));
  assert.deepEqual({...outcome,diagnostic:undefined,status:undefined,succeeded:undefined},{recoveryReason:'authentication_unknown',
    submitStage:'post_login_receipt',postLoginForm:'unchanged',afterStatus:'login_required',afterFailure:'login_required',
    afterStage:'authentication',loginHttpStatus:200,loginApiCode:1001,loginPosts:1,challengePosts:1,loginPagePath:'/login',
    blockedPosts:['/v1/web/auth/srp/verify'],failureCode:'two_factor_required',retryable:false,
    diagnostic:undefined,status:undefined,succeeded:undefined});
  for(const value of ['PRIVATE',1.5,-1,1e12,'200',null,{}]){
    const unsafe=loginHelperOutcome(JSON.stringify({status:'needs_attention',nativeTwoFactorRecovery:{
      submitStage:value,loginHttpStatus:value,loginApiCode:value,loginPosts:value,challengePosts:value,loginPagePath:value,blockedPosts:value}}));
    for(const key of ['submitStage','loginHttpStatus','loginApiCode','loginPosts','challengePosts','loginPagePath','blockedPosts'])
      if(!(key==='loginApiCode'&&value===-1))assert.equal(unsafe[key],undefined,key+' '+JSON.stringify(value));
  }
  for(const blockedPosts of [['/v1/web/PRIVATE'],['/v1/web/a?b=c'],['/other/path'],['https://foreign.example/v1/web/x'],
    ['/v1/web/user/42/heartbeat'],['/v1/web/x/'],Array(5).fill('/v1/web/x'),[]]){
    assert.equal(loginHelperOutcome(JSON.stringify({status:'needs_attention',nativeTwoFactorRecovery:{blockedPosts}})).blockedPosts,undefined);
  }
  for(const loginPagePath of ['/Login','/login?next=1','https://piggo.me/login','/'+'a'.repeat(61),'/u/42','/user/42/profile'])
    assert.equal(loginHelperOutcome(JSON.stringify({status:'needs_attention',nativeTwoFactorRecovery:{loginPagePath}})).loginPagePath,undefined);
  assert.doesNotMatch(JSON.stringify(outcome),/PRIVATE/);
});

test("登录助手区分可自愈超时与确定性身份错误", () => {
  const timeout = loginHelperOutcome('{"status":"needs_attention","failureCode":"oauth_timeout"}');
  assert.equal(timeout.failureCode, "oauth_timeout");
  assert.equal(timeout.retryable, true);

  const mismatch = loginHelperOutcome('{"status":"needs_attention","failureCode":"account_mismatch"}');
  assert.equal(mismatch.failureCode, "account_mismatch");
  assert.equal(mismatch.retryable, false);
});

test("OAuth 上游限流保留可退避诊断码", () => {
  const outcome = loginHelperOutcome(JSON.stringify({ status: "failed", failureCode: "oauth_rate_limited" }));
  assert.equal(outcome.failureCode, "oauth_rate_limited");
  assert.equal(outcome.retryable, true);
  assert.match(outcome.diagnostic, /请求过多/);
});

test("OAuth 上游回调故障保留可退避诊断码", () => {
  const outcome = loginHelperOutcome(JSON.stringify({ status: "failed", failureCode: "oauth_upstream_unavailable" }));
  assert.equal(outcome.failureCode, "oauth_upstream_unavailable");
  assert.equal(outcome.diagnostic, "OAuth 上游回调服务暂时不可用");
  assert.equal(outcome.retryable, true);
});

test("OAuth 结构变化保留安全且可执行的诊断", () => {
  const outcome = loginHelperOutcome(JSON.stringify({ status: "failed", failureCode: "site_flow_changed" }));
  assert.equal(outcome.failureCode, "site_flow_changed");
  assert.equal(outcome.retryable, false);
  assert.match(outcome.diagnostic, /流程已变化/);
});

test("登录助手保留无敏感信息的凭据拒绝诊断码", () => {
  const outcome = loginHelperOutcome('{"status":"invalid_credential","diagnostic":{"observedResponses":[{"path":"/api/user/login"}]}}');
  assert.equal(outcome.succeeded, false);
  assert.equal(outcome.status, "invalid_credential");
  assert.equal(outcome.diagnosticCode, "invalid_credential");
  assert.equal(Object.hasOwn(outcome, "username"), false);
  assert.equal(Object.hasOwn(outcome, "password"), false);
});

test("登录助手只保留白名单内的权威签到证据", () => {
  const mockSecretValue = "redacted-test-value";
  const outcome = loginHelperOutcome(JSON.stringify({
    status: "logged_in",
    cookie: mockSecretValue,
    token: "private-token",
    body: "private-body",
    dailyCheckin: {
      status: "signed",
      reason: "使用日志确认今日签到成功",
      cookie: mockSecretValue,
      evidence: {
        source: "usage_log",
        createdAt: "2026-08-09T01:02:03Z",
        rewardAmount: 25,
        accountId: "private-account",
        token: "nested-token",
        body: "nested-body",
      },
    },
  }));
  assert.deepEqual(outcome, {
    succeeded: true,
    status: "logged_in",
    diagnostic: "已取得登录会话",
    dailyCheckin: {
      status: "signed",
      reason: "使用日志确认今日签到成功",
      evidence: {
        source: "usage_log",
        createdAt: "2026-08-09T01:02:03.000Z",
        rewardAmount: 25,
      },
    },
  });
  assert.doesNotMatch(JSON.stringify(outcome), /private|cookie|token|body|accountId/);
});

test("只有成功的受信登录助手可以直接提交权威签到结果", () => {
  const outcome = loginHelperOutcome(JSON.stringify({
    status: "logged_in",
    dailyCheckin: { status: "already_signed", reason: "当日使用日志已确认" },
  }));
  assert.deepEqual(authoritativeLoginDailyCheckin("native_oauth", outcome), outcome.dailyCheckin);
  assert.deepEqual(authoritativeLoginDailyCheckin("oauth", outcome), outcome.dailyCheckin);
  assert.deepEqual(authoritativeLoginDailyCheckin("protected_credential", outcome), outcome.dailyCheckin);
  assert.equal(authoritativeLoginDailyCheckin("saved_password", outcome), null);
  assert.equal(authoritativeLoginDailyCheckin("native_oauth", { ...outcome, succeeded: false }), null);
  assert.equal(authoritativeLoginDailyCheckin("native_oauth", loginHelperOutcome(JSON.stringify({
    status: "logged_in", dailyCheckin: { status: "login_required", reason: "not terminal" },
  }))), null);
});

test("报告中的脱敏参数不会被重新用于登录导航", () => {
  assert.equal(
    resolveLoginRecoveryUrl(
      "https://example.test",
      null,
      "https://example.test/sign-in?redirect=%5BVALUE%5D",
    ),
    "https://example.test/sign-in",
  );
});

test("显式登录入口优先且必须保持同源 HTTPS", () => {
  assert.equal(
    resolveLoginRecoveryUrl("https://example.test", "https://example.test/auth?mode=login", null),
    "https://example.test/auth?mode=login",
  );
  assert.throws(
    () => resolveLoginRecoveryUrl("https://example.test", "https://evil.test/login", null),
    /目标 HTTPS origin/,
  );
});

test("非登录诊断地址回退到约定登录入口", () => {
  assert.equal(
    resolveLoginRecoveryUrl("https://example.test", null, "https://example.test/dashboard"),
    "https://example.test/login",
  );
});
