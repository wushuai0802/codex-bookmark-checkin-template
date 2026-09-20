import fs from "node:fs/promises";
import { atomicWriteJson } from "./security.mjs";

function normalize(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function sanitizeQaSearchQuestion(value) {
  return normalize(value)
    .replace(/(?:用户名|账号|帳號|用户\s*ID|user\s*id)\s*[:：]?\s*\S+/gi, " ")
    .replace(/https?:\/\/\S+/gi, " ")
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, " ")
    .replace(/\b(?:[a-z0-9-]+\.)+(?:com|net|org|xyz|top|site|club|me|do|cc|cn)\b/gi, " ")
    .replace(/\b(?:\d[ -]?){6,}\b/g, " ")
    .replace(/\b[a-f0-9]{24,}\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 260);
}

export function selectAnswerFromSearchText(options, searchText) {
  const text = normalize(searchText).slice(0, 40000);
  const scored = options.map((rawOption) => {
    const option = normalize(rawOption);
    const escaped = escapeRegex(option);
    let score = 0;
    if (new RegExp(`(?:正确答案|正確答案|答案|answer)\\s*[:：]?\\s*(?:选项\\s*)?[《【]?${escaped}`, "i").test(text)) score += 12;
    if (new RegExp(`${escaped}.{0,24}(?:是正确|是正確|为正确答案|為正確答案|is correct)`, "i").test(text)) score += 10;
    const occurrences = text.match(new RegExp(escaped, "gi"))?.length ?? 0;
    if (occurrences >= 3) score += Math.min(4, occurrences - 2);
    return { option, score };
  }).sort((left, right) => right.score - left.score);
  const winner = scored[0];
  const runnerUp = scored[1] ?? { score: 0 };
  if (!winner || winner.score < 10 || winner.score - runnerUp.score < 5) {
    return { answer: null, confidence: 0, scored };
  }
  return {
    answer: winner.option,
    confidence: Math.min(99, 70 + (winner.score - runnerUp.score) * 2),
    scored,
  };
}

export async function resolveQaByWebSearch(page, question, options, config = {}) {
  if (config.qaWebSearchEnabled === false || !question || options.length < 2) return null;
  const endpoint = String(config.qaWebSearchUrl || "https://www.google.com/search?q=");
  if (!endpoint.startsWith("https://www.google.com/search?q=")) return null;
  const sanitizedQuestion = sanitizeQaSearchQuestion(question);
  if (sanitizedQuestion.length < 4) return null;
  const query = `${sanitizedQuestion} 正确答案`;
  const searchPage = await page.context().newPage();
  try {
    await searchPage.goto(`${endpoint}${encodeURIComponent(query)}`, {
      waitUntil: "domcontentloaded",
      timeout: Math.max(5000, Number(config.qaWebSearchTimeoutMs) || 15000),
    });
    const text = await searchPage.locator("body").innerText({ timeout: 5000 });
    const selection = selectAnswerFromSearchText(options, text);
    return selection.answer ? { ...selection, source: "web_search" } : null;
  } catch {
    return null;
  } finally {
    await searchPage.close().catch(() => {});
  }
}

export async function loadQaCache(filePath) {
  try {
    const value = JSON.parse(await fs.readFile(filePath, "utf8"));
    return Array.isArray(value?.entries) ? value : { version: 1, entries: [] };
  } catch {
    return { version: 1, entries: [] };
  }
}

export function updateQaCache(cache, results, now = new Date()) {
  const entries = [...(cache?.entries ?? [])];
  for (const result of results) {
    const qa = result.qa;
    if (result.status !== "signed" || !qa?.verified || !qa.question || !qa.answer) continue;
    const existing = entries.find((entry) => entry.origin === result.origin && entry.questionIncludes === qa.question);
    const next = {
      origin: result.origin,
      questionIncludes: qa.question,
      answerText: qa.answer,
      submitText: qa.submitText || "提交",
      source: qa.source || "verified",
      verifiedAt: now.toISOString(),
    };
    if (existing) Object.assign(existing, next);
    else entries.push(next);
  }
  return { version: 1, updatedAt: now.toISOString(), entries: entries.slice(-500) };
}

export async function writeQaCache(filePath, cache) {
  await atomicWriteJson(filePath, cache);
}
