function positiveInteger(value, fallback, maximum) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, maximum);
}

export async function connectOverCdpWithRetry(chromium, port, options = {}) {
  if (!chromium?.connectOverCDP || !Number.isInteger(port) || port <= 0) {
    throw new Error("原生 Chrome 调试连接参数无效");
  }

  const timeoutMs = positiveInteger(options.timeoutMs, 15000, 60000);
  const attemptTimeoutMs = positiveInteger(options.attemptTimeoutMs, 2000, 10000);
  const retryDelayMs = positiveInteger(options.retryDelayMs, 500, 5000);
  const deadline = Date.now() + timeoutMs;
  let lastError = null;

  do {
    try {
      return await chromium.connectOverCDP(`http://127.0.0.1:${port}`, {
        timeout: Math.min(attemptTimeoutMs, Math.max(1, deadline - Date.now())),
      });
    } catch (error) {
      lastError = error;
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      await new Promise((resolve) => setTimeout(resolve, Math.min(retryDelayMs, remaining)));
    }
  } while (Date.now() < deadline);

  throw new Error("原生 Chrome 未在限定时间内开放调试端口", { cause: lastError });
}
