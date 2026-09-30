export function knownPtDialogOpener(origin,action){
  const label=String(action?.text??'').trim().replaceAll('[','').replaceAll(']','').trim();
  return origin==='https://open.cd'&&['签到','簽到'].includes(label);
}

export async function guardPtSubmission(run, check) {
  let attempted = false;
  const beforeSubmit = () => {
    const decision = check();
    if (decision) throw Object.assign(Error('PT submission gate closed'), { ptGateDecision: decision });
    attempted = true;
  };
  const unknown = () => ({ status: 'needs_attention', failureCode: 'submission_outcome_unknown',
    reason: '签到动作已发出但结果未确认，先只读复核，禁止自动重放', submissionAttempted: true, retryable: false });
  try {
    const result = await run(beforeSubmit);
    if (attempted && !['signed','already_signed'].includes(result?.status)) {
      if (result?.failureCode === 'captcha_ocr_exhausted' && result?.captchaRejected === true) return { ...result, submissionAttempted: true, retryable: false };
      return { ...result, ...unknown(), ...(/维护通知|数据恢复|全量恢复/.test(result?.reason??'')?{siteCondition:'site_maintenance'}:{}) };
    }
    return { ...result, ...(attempted ? { submissionAttempted: true } : {}) };
  } catch (error) {
    if (attempted) return unknown();
    if (error.ptGateDecision) return error.ptGateDecision;
    throw error;
  }
}
