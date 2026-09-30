const messages={
  submission_outcome_unknown:'提交结果不明，先只读核验，禁止自动重放',
  site_maintenance:'站点公告正在维护或恢复数据，等待恢复后核验',
  upstream_unavailable:'站点服务暂时不可用，等待恢复后重试',
  rate_limit:'站点触发频率限制，等待冷却后重试',
  login_required:'执行会话需要重新登录',
  upstream_login_required:'上游登录已失效，需要恢复登录',
  two_factor_required:'站点要求完成二次验证',
  interactive_challenge:'站点要求完成浏览器验证',
  managed_challenge:'站点返回浏览器安全验证页，须先完成验证',
  captcha_ocr_exhausted:'图片验证码未通过，保留原签到流程待复核',
  account_mismatch:'页面账号与执行绑定不一致',
  harvest_waiting:'Harvest 当日任务尚未完成，暂缓补签',
  network_error:'页面访问失败，尚未取得签到状态',
  authoritative_status_unavailable:'页面尚无可确认的今日签到证据'
};
export function ptDiagnostic(result={}){
  const maintenance=result.failureCode==='site_maintenance'||result.siteCondition==='site_maintenance'||
    /维护通知|数据恢复|全量恢复/.test(result.reason??'');
  const failureCode=Object.hasOwn(messages,result.failureCode)?result.failureCode:
    maintenance?'site_maintenance':Object.hasOwn(messages,result.retryCause)?result.retryCause:
    result.status==='login_required'?'login_required':result.status==='interactive_challenge'?'interactive_challenge':
    result.status==='error'?'network_error':'authoritative_status_unavailable';
  const retryCause=['upstream_unavailable','rate_limit','login_required','harvest_waiting'].includes(result.retryCause)?result.retryCause:undefined;
  return {failureCode,...(retryCause?{retryCause}:{}),...(maintenance?{siteCondition:'site_maintenance'}:{}),
    summary:messages[failureCode]+(maintenance&&failureCode==='submission_outcome_unknown'?'；站点当前正在维护':'')};
}
