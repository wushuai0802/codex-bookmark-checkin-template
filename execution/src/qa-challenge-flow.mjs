import { isCheckinSingleChoiceChallenge, normalizeText } from "./detector.mjs";
import { resolveQaByWebSearch } from "./qa-solver.mjs";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function findMatchingQaRule(page, rules, origin) {
  const bodyText = normalizeText(await page.locator("body").innerText({ timeout: 5000 })).slice(0, 30000);
  return rules.find((rule) => {
    if (!rule || rule.origin !== origin || !rule.questionIncludes) return false;
    return bodyText.includes(String(rule.questionIncludes));
  }) ?? null;
}

export async function applyQaRule(page, rule, config = {}) {
  if (!rule?.answerText || !rule?.submitText) return false;
  const answerText = normalizeText(rule.answerText);
  const radioOptions = await page.locator('input[type="radio"]').evaluateAll((elements) => elements.map((element, index) => {
    let siblingText = "";
    let sibling = element.nextSibling;
    while (sibling && sibling.nodeName !== "BR" && !(sibling instanceof HTMLInputElement)) {
      siblingText += ` ${sibling.textContent || ""}`;
      sibling = sibling.nextSibling;
    }
    return { index, text: String(siblingText).replace(/\s+/g, " ").trim() };
  }));
  const matchingRadios = radioOptions.filter((option) => option.text === answerText);
  if (matchingRadios.length === 1) {
    await page.locator('input[type="radio"]').nth(matchingRadios[0].index).check();
  } else {
    const answer = page.getByText(answerText, { exact: true });
    if (await answer.count() !== 1) return false;
    await answer.click();
  }

  const submitText = normalizeText(rule.submitText);
  const submitInputs = await page.locator('input[type="submit"], button[type="submit"]').evaluateAll((elements) => elements.map((element, index) => ({
    index,
    text: String(element.value || element.innerText || "").replace(/\s+/g, " ").trim(),
  })));
  const matchingSubmits = submitInputs.filter((option) => option.text === submitText);
  if (matchingSubmits.length === 1) {
    config.beforePtSubmit?.();
    await page.locator('input[type="submit"], button[type="submit"]').nth(matchingSubmits[0].index).click();
  } else {
    const submit = page.getByText(submitText, { exact: true });
    if (await submit.count() !== 1) return false;
    config.beforePtSubmit?.();
    await submit.click();
  }
  return true;
}

export async function readSingleChoiceChallenge(page) {
  const radios = page.locator('input[type="radio"]');
  if (await radios.count() < 2) return null;
  const groups = await radios.evaluateAll((elements) => {
    const normalize = (value) => String(value || "").replace(/\s+/g, " ").trim();
    const grouped = new Map();
    for (const [index, element] of elements.entries()) {
      const container = element.closest("form") || element.closest("table") || element.parentElement;
      if (!container) continue;
      if (!grouped.has(container)) grouped.set(container, []);
      grouped.get(container).push({ element, index });
    }
    return [...grouped.entries()].map(([container, entries]) => {
      const options = entries.map(({ element, index }) => {
        let text = "";
        const label = element.closest("label")
          || (element.id ? document.querySelector(`label[for="${CSS.escape(element.id)}"]`) : null);
        if (label) text = label.innerText || label.textContent || "";
        if (!normalize(text)) {
          let sibling = element.nextSibling;
          while (sibling && sibling.nodeName !== "BR" && !(sibling instanceof HTMLInputElement)) {
            text += ` ${sibling.textContent || ""}`;
            sibling = sibling.nextSibling;
          }
        }
        return { index, text: normalize(text) };
      }).filter((option) => option.text);
      if (options.length < 2) return null;
      const contextText = normalize(container.innerText || container.textContent || "");
      const submitTexts = [...container.querySelectorAll('input[type="submit"], button[type="submit"], button')]
        .map((element) => normalize(element.value || element.innerText || element.textContent || ""))
        .filter(Boolean);
      let question = contextText;
      const firstOptionIndex = question.indexOf(options[0].text);
      if (firstOptionIndex > 0) question = question.slice(0, firstOptionIndex);
      const markers = [question.lastIndexOf("请问"), question.lastIndexOf("請問"), question.lastIndexOf("[单选]"), question.lastIndexOf("[單選]")];
      const marker = Math.max(...markers);
      if (marker >= 0) question = question.slice(marker);
      return {
        question: normalize(question).slice(-320),
        options: options.map((option) => option.text),
        contextText: contextText.slice(0, 2000),
        submitTexts,
      };
    }).filter(Boolean);
  });
  return groups.find(isCheckinSingleChoiceChallenge) ?? null;
}

export async function clickQaChange(page, config) {
  const labels = config.qaChangeButtonTexts ?? ["仅可换一题", "僅可換一題", "换一题", "換一題"];
  const controls = page.locator('input[type="submit"], button');
  const values = await controls.evaluateAll((elements) => elements.map((element, index) => ({
    index,
    text: String(element.value || element.innerText || "").replace(/\s+/g, " ").trim(),
  })));
  const matches = values.filter((item) => labels.includes(item.text));
  if (matches.length !== 1) return false;
  await controls.nth(matches[0].index).click();
  await page.waitForLoadState("domcontentloaded", { timeout: 15000 }).catch(() => {});
  await sleep(1000);
  return true;
}

export async function tryQaFlow(page, rules, origin, config, { waitForManagedChallenge } = {}) {
  const configuredChanges = Number(config.qaMaxQuestionChanges);
  const maxChanges = Math.max(0, Math.min(2, Number.isFinite(configuredChanges) ? configuredChanges : 1));
  for (let changeIndex = 0; changeIndex <= maxChanges; changeIndex += 1) {
    const challenge = await readSingleChoiceChallenge(page);
    if (!challenge) return null;

    let rule = await findMatchingQaRule(page, rules, origin);
    let source = rule ? (rule.source || "configured") : null;
    if (!rule) {
      const searched = await resolveQaByWebSearch(page, challenge.question, challenge.options, config);
      if (searched?.answer) {
        rule = { answerText: searched.answer, submitText: "提交" };
        source = searched.source;
      }
    }

    if (rule) {
      const applied = await applyQaRule(page, rule, config);
      if (!applied) {
        return { status: "interactive_challenge", reason: "已找到问答答案，但页面选项结构无法安全提交" };
      }
      await sleep(config.actionWaitMs);
      const state = typeof waitForManagedChallenge === "function"
        ? await waitForManagedChallenge(page, config)
        : { status: "interactive_challenge" };
      const verified = ["signed", "already_signed"].includes(state.status);
      return {
        ...(verified ? state : { status: "interactive_challenge", reason: "问答答案已提交，但页面未确认签到成功" }),
        qa: {
          question: challenge.question,
          answer: String(rule.answerText),
          submitText: String(rule.submitText || "提交"),
          source,
          verified,
        },
      };
    }

    if (changeIndex < maxChanges && await clickQaChange(page, config)) continue;
    return {
      status: "interactive_challenge",
      reason: `遇到未知站内问答：${challenge.question.slice(0, 120)}`,
    };
  }
  return null;
}
