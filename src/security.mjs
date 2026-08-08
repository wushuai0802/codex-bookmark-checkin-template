import fs from "node:fs/promises";
import path from "node:path";

const SENSITIVE_QUERY_KEY = /(token|key|secret|auth|session|cookie|password|passwd|code)/i;

export function safeLogUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    url.username = "";
    url.password = "";
    for (const key of [...url.searchParams.keys()]) {
      url.searchParams.set(key, SENSITIVE_QUERY_KEY.test(key) ? "[REDACTED]" : "[VALUE]");
    }
    if (url.hash && /(token|key|secret|auth|session|cookie|password|code)/i.test(url.hash)) {
      url.hash = "#[REDACTED]";
    }
    return url.href;
  } catch {
    return "[INVALID_URL]";
  }
}

export function safeErrorMessage(error) {
  const raw = String(error?.message ?? error ?? "未知错误").slice(0, 1000);
  return raw
    .replace(/(token|secret|password|passwd|cookie|authorization)(\s*[:=]\s*)[^\s,;]+/gi, "$1$2[REDACTED]")
    .replace(/https?:\/\/[^\s)\]]+/gi, (value) => safeLogUrl(value));
}

export function assertBookmarkNavigation(candidate, expectedOrigin) {
  const url = new URL(candidate);
  if (url.protocol !== "https:" || url.username || url.password) throw new Error("仅允许无凭据 HTTPS 书签");
  const allowedOrigins = new Set(Array.isArray(expectedOrigin) ? expectedOrigin : [expectedOrigin]);
  if (!allowedOrigins.has(url.origin)) throw new Error("拒绝跨站导航");
  return url.href;
}

export async function ensurePrivateDirectory(directory) {
  await fs.mkdir(directory, { recursive: true });
  if (process.platform !== "win32") await fs.chmod(directory, 0o700);
}

export async function atomicWriteJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await fs.rename(temporary, filePath);
}
