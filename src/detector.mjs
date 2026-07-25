const CHECKIN_EXACT = new Set([
  "签到", "簽到", "立即签到", "立即簽到", "每日签到", "每日簽到",
  "今日签到", "今日簽到", "去签到", "去簽到", "打卡", "立即打卡",
  "福利站", "check in", "check-in", "daily check in", "daily check-in", "attendance",
  "开始转动", "開始轉動", "转动转盘", "轉動轉盤",
  "申请额度", "申請額度",
  "领取 codex 权益", "領取 codex 權益", "领取codex权益", "領取codex權益",
]);

const EXCLUDED_ACTIONS = /(签到记录|簽到記錄|签到排行|签到规则|补签|補簽|历史|history|rules?)/i;

export function normalizeText(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

export function formatDailyReason(template, now = new Date()) {
  const parts = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "numeric",
    day: "numeric",
  }).formatToParts(now).reduce((result, part) => {
    if (part.type !== "literal") result[part.type] = part.value;
    return result;
  }, {});
  const date = `${parts.year}年${parts.month}月${parts.day}日`;
  return String(template ?? "").replaceAll("{date}", date);
}

export function isCheckinSingleChoiceChallenge({ contextText = "", submitTexts = [] } = {}) {
  const context = normalizeText(contextText);
  const submits = submitTexts.map(normalizeText).filter(Boolean);
  const hasCheckinMarker = /(签到|簽到|答题|答題|验证码|驗證碼|安全验证|安全驗證|\[单选\]|\[單選\])/i.test(context);
  const isPlainPoll = submits.some((text) => /^(投票|vote)$/i.test(text)) && !hasCheckinMarker;
  if (isPlainPoll) return false;
  return hasCheckinMarker
    || submits.some((text) => /^(提交|确认|確認|确定|確定|签到|簽到|check[ -]?in)$/i.test(text));
}

export function classifyPageText({ url = "", title = "", bodyText = "", hasPassword = false, challengeSelectors = false }) {
  const text = normalizeText(`${title}\n${bodyText}`).slice(0, 30000);
  const lowerUrl = String(url).toLowerCase();

  // A login form can legitimately contain an image CAPTCHA.  Treating every
  // CAPTCHA marker as a standalone browser challenge hides the real action
  // required (refreshing the site's login session).
  if (hasPassword || /\/(log[-_]?in|sign[-_]?in|auth)(?:[/?#]|$)/i.test(lowerUrl)) {
    const suffix = challengeSelectors ? "，登录页包含验证码" : "";
    return { status: "login_required", reason: `登录状态失效${suffix}` };
  }
  if (/(未登录|尚未登录|请先登录|請先登入|not logged in|sign in to continue)/i.test(text)) {
    return { status: "login_required", reason: "页面要求先登录" };
  }
  if (/(?:使用|用)\s*linux\s*do\s*(?:账号|帳號)?\s*(?:登录|登入)|use\s+linux\s*do\s+to\s+(?:log|sign)\s*in/i.test(text)) {
    return { status: "login_required", reason: "页面要求通过 Linux DO 登录" };
  }

  if (/(操作过于频繁|操作過於頻繁|请求过于频繁|請求過於頻繁|too many requests|rate limit|try again later|请稍后再试|請稍後再試)/i.test(text)) {
    return { status: "deferred", retryCause: "rate_limit", reason: "站点触发频率限制，请稍后重试" };
  }

  // Visible Turnstile/recaptcha widgets and an explicit checkbox prompt need
  // interaction.  Mere explanatory copy such as “完成人机验证即可签到” does
  // not prove that a challenge is currently active.
  if (challengeSelectors || /(请验证您是真人|請驗證您是真人|verify you are human)/i.test(text)) {
    return { status: "interactive_challenge", reason: "检测到交互式安全验证" };
  }
  if (/(just a moment|performing security verification|请稍候.*安全|正在验证您是否是真人)/i.test(text)) {
    return { status: "managed_challenge", reason: "等待托管安全验证" };
  }
  if ((/(^|\s)(登录|登入)(\s|$)/.test(text) && /注册/.test(text)) || (/(^|\s)log[ -]?in(\s|$)/i.test(text) && /sign[ -]?up/i.test(text))) {
    return { status: "login_required", reason: "页面仅显示登录/注册入口" };
  }
  if (/(今日已签到|今天已签到|今天已经签到过|已经签到|已完成签到|已签到|已簽到|签到已得\s*\d*|簽到已得\s*\d*|查看(?:签到|簽到)(?:记录|記錄).{0,20}\d{1,2}(?:点|點)|無需重複簽到|无需重复签到|codex\s*(?:权益|權益)\s*已(?:领取|領取)|already checked[ -]?in|checked in today)/i.test(text)) {
    return { status: "already_signed", reason: "今天已经签到" };
  }
  if (/(签到成功|簽到成功|成功签到|成功簽到|打卡成功|回答正确|回答正確|本次签到获得|本次簽到獲得|申请额度成功|申請額度成功|额度已发放|額度已發放|额度申请成功|額度申請成功|额度申请已提交|額度申請已提交|申请已提交|申請已提交|申请成功.*额度|申請成功.*額度|(?:领取|領取)\s*codex\s*(?:权益|權益)\s*成功|codex\s*(?:权益|權益)\s*(?:领取|領取)成功|successfully checked[ -]?in)/i.test(text)) {
    return { status: "signed", reason: "页面显示签到成功" };
  }
  return { status: "ready", reason: "页面可继续处理" };
}

export function scoreActionText(rawText) {
  const text = normalizeText(rawText).toLowerCase()
    .replace(/^[\[【(（]+\s*/, "")
    .replace(/\s*[\]】)）]+$/, "");
  if (!text || EXCLUDED_ACTIONS.test(text)) return -1;
  if (CHECKIN_EXACT.has(text)) return 100;
  if (/^(?:领取|領取)\s*codex\s*(?:权益|權益)$/i.test(text)) return 100;
  if (/^(立即|每日|今日|去)?[签到簽到打卡]{2,6}$/.test(text)) return 95;
  if (/(领取|領取).*(每日|今日).*(奖励|獎勵)/.test(text)) return 85;
  if (/^(daily )?(check[ -]?in|attendance)$/.test(text)) return 90;
  return -1;
}

export function solveArithmeticQuestion(text) {
  const normalized = String(text ?? "").replace(/[×xX]/g, "*").replace(/[÷]/g, "/");
  const match = normalized.match(/(-?\d+)\s*([+\-*/])\s*(-?\d+)/);
  if (!match) return null;
  const left = Number(match[1]);
  const right = Number(match[3]);
  if (!Number.isSafeInteger(left) || !Number.isSafeInteger(right)) return null;
  switch (match[2]) {
    case "+": return String(left + right);
    case "-": return String(left - right);
    case "*": return String(left * right);
    case "/": return right !== 0 && Number.isInteger(left / right) ? String(left / right) : null;
    default: return null;
  }
}
