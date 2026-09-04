import { createHash } from "node:crypto";

const TOKEN_ENDPOINT = "https://aip.baidubce.com/oauth/2.0/token";
const OCR_ENDPOINT = "https://aip.baidubce.com/rest/2.0/ocr/v1/general_basic";
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
let tokenCache = null;

function normalizedCode(value, length, alphabet) {
  const code = String(value ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  return code.length === length && [...code].every((character) => alphabet.includes(character)) ? code : null;
}

function externalOcrRule(config, origin, env) {
  const raw = config?.baiduOcr;
  if (raw?.enabled !== true) return null;
  let expectedOrigin;
  try { expectedOrigin = new URL(origin).origin; } catch { return null; }
  const allowedOrigins = new Set((raw.allowedOrigins ?? []).map((value) => {
    try { return new URL(String(value)).origin; } catch { return null; }
  }).filter(Boolean));
  if (!allowedOrigins.has(expectedOrigin)) return null;
  const apiKey = String(env?.CHECKIN_BAIDU_OCR_API_KEY ?? "").trim();
  const secretKey = String(env?.CHECKIN_BAIDU_OCR_SECRET_KEY ?? "").trim();
  if (!apiKey || !secretKey || apiKey.length > 256 || secretKey.length > 256) return null;
  return {
    apiKey,
    secretKey,
    timeoutMs: Math.max(1000, Math.min(10000, Number(raw.timeoutMs) || 5000)),
  };
}

async function fetchWithTimeout(fetchImpl, url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try { return await fetchImpl(url, { ...options, signal: controller.signal }); }
  finally { clearTimeout(timer); }
}

async function accessToken(rule, fetchImpl) {
  const fingerprint = createHash("sha256").update(`${rule.apiKey}\0${rule.secretKey}`).digest("hex");
  if (tokenCache?.fingerprint === fingerprint && tokenCache.expiresAt > Date.now() + 60_000) {
    return tokenCache.value;
  }
  const url = new URL(TOKEN_ENDPOINT);
  url.searchParams.set("grant_type", "client_credentials");
  url.searchParams.set("client_id", rule.apiKey);
  url.searchParams.set("client_secret", rule.secretKey);
  const response = await fetchWithTimeout(fetchImpl, url, { method: "POST" }, rule.timeoutMs);
  if (!response.ok) return null;
  const body = await response.json().catch(() => null);
  const value = String(body?.access_token ?? "").trim();
  if (!value || value.length > 4096) return null;
  const expiresIn = Math.max(120, Math.min(30 * 24 * 60 * 60, Number(body?.expires_in) || 3600));
  tokenCache = { fingerprint, value, expiresAt: Date.now() + expiresIn * 1000 };
  return value;
}

export function applyExternalOcrConsensus(localRecognition, externalValue, { length, alphabet }) {
  const local = localRecognition && typeof localRecognition === "object" ? localRecognition : {};
  const externalCode = normalizedCode(externalValue, length, alphabet);
  if (!externalCode) return local;
  const localCode = normalizedCode(local.code, length, alphabet);
  const rows = Array.isArray(local.candidates) && local.candidates.length === length
    ? local.candidates
    : null;
  const supportedByLocalCandidates = rows?.every((row, index) => (
    Array.isArray(row) && row.slice(0, 4).some((item) => item?.character === externalCode[index])
  )) === true;
  if (externalCode !== localCode && !supportedByLocalCandidates) {
    return {
      ...local,
      code: null,
      externalConsensus: false,
      externalProvider: "baidu",
    };
  }
  return {
    ...local,
    code: externalCode,
    confidence: Math.max(Number(local.confidence) || 0, 70),
    externalConsensus: true,
    externalProvider: "baidu",
  };
}

export async function tryBaiduOcrSecondOpinion(input, {
  config = {},
  origin,
  length,
  alphabet,
  fetchImpl = globalThis.fetch,
  env = process.env,
} = {}) {
  const rule = externalOcrRule(config, origin, env);
  if (!rule || typeof fetchImpl !== "function" || !Buffer.isBuffer(input)
    || input.length === 0 || input.length > MAX_IMAGE_BYTES) return null;
  try {
    const token = await accessToken(rule, fetchImpl);
    if (!token) return null;
    const url = new URL(OCR_ENDPOINT);
    url.searchParams.set("access_token", token);
    const form = new URLSearchParams({
      image: input.toString("base64"),
      language_type: "ENG",
      detect_direction: "false",
      paragraph: "false",
      probability: "false",
    });
    const response = await fetchWithTimeout(fetchImpl, url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form,
    }, rule.timeoutMs);
    if (!response.ok) return null;
    const body = await response.json().catch(() => null);
    const words = Array.isArray(body?.words_result)
      ? body.words_result.map((item) => String(item?.words ?? "")).join("")
      : "";
    return normalizedCode(words, length, alphabet);
  } catch {
    return null;
  }
}

export async function applyOptionalBaiduSecondOpinion(input, localRecognition, options) {
  const threshold = Math.max(0, Math.min(100, Number(options?.config?.baiduOcr?.minimumLocalConfidence) || 70));
  const localCode = normalizedCode(localRecognition?.code, options.length, options.alphabet);
  if (localCode && Number(localRecognition?.confidence) >= threshold) return localRecognition;
  const externalCode = await tryBaiduOcrSecondOpinion(input, options);
  return externalCode
    ? applyExternalOcrConsensus(localRecognition, externalCode, options)
    : localRecognition;
}
