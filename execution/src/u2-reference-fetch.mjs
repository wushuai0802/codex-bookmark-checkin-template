import { request } from "playwright-core";

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const PUBLIC_HEADERS = new Set(["accept", "content-type", "user-agent"]);
const PRIVATE_HEADERS = new Set(["cookie", "authorization", "proxy-authorization"]);

function referenceUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error("U2 reference URL is not approved"); }
  const approved = url.protocol === "https:" && !url.username && !url.password && !url.port && !url.hash && (
    url.hostname === "graphql.anilist.co" && url.pathname === "/" && !url.search
    || url.hostname === "myanimelist.net" && url.pathname === "/anime.php"
    || ["s4.anilist.co", "s2.anilist.co"].includes(url.hostname) && url.pathname.startsWith("/file/anilistcdn/media/anime/")
    || url.hostname === "cdn.myanimelist.net" && url.pathname.startsWith("/images/anime/")
  );
  if (!approved) throw new Error("U2 reference URL is not approved");
  return url;
}

function referenceProxy(config, env) {
  for (const value of [config.u2ReferenceProxyServer, env.HTTPS_PROXY, env.https_proxy, env.HTTP_PROXY, env.http_proxy]) {
    if (!value) continue;
    try {
      const url = new URL(value);
      if (url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
        && url.port && !url.username && !url.password && url.pathname === "/" && !url.search && !url.hash) {
        return { server: url.origin };
      }
    } catch { /* An invalid proxy candidate never supplies a credential or remote route. */ }
  }
  return undefined;
}

function publicHeaders(value) {
  const headers = new Headers(value);
  const publicValues = {};
  for (const [name, content] of headers) {
    if (PRIVATE_HEADERS.has(name)) throw new Error("U2 public reference requests cannot use authentication headers");
    if (PUBLIC_HEADERS.has(name)) publicValues[name] = content;
  }
  return publicValues;
}

// Public references use their own request context. No site profile or cookie
// jar is reused, and every redirect gets another empty jar.
export function createU2ReferenceFetch(config = {}, {
  env = process.env,
  newContext = (options) => request.newContext(options),
} = {}) {
  const proxy = referenceProxy(config, env);
  const configuredTimeout = config.u2ReferenceRequestTimeoutMs;
  const timeoutMs = Number.isFinite(configuredTimeout) && configuredTimeout > 0 ? Math.ceil(configuredTimeout) : 8000;
  const activeCalls = new Set();
  const disposals = new Set();
  let closed = false;

  async function readHop(url, init, signal, deadline) {
    let context;
    let stopped = false;
    let stopReason;
    let disposal;
    let timer;
    let rejectCancellation;
    const dispose = () => {
      if (!context) return Promise.resolve();
      if (!disposal) {
        disposal = Promise.resolve().then(() => context.dispose());
        disposals.add(disposal);
        disposal.then(() => disposals.delete(disposal), () => disposals.delete(disposal));
      }
      return disposal;
    };
    const cancel = (reason) => {
      if (stopped) return;
      stopped = true;
      stopReason = reason;
      void dispose().catch(() => {});
      rejectCancellation(reason);
    };
    const onAbort = () => cancel(signal.reason ?? new DOMException("U2 reference request aborted", "AbortError"));
    const cancellation = new Promise((_, reject) => { rejectCancellation = reject; });
    activeCalls.add(cancel);
    signal?.addEventListener("abort", onAbort, { once: true });
    const remaining = deadline - Date.now();
    if (closed) cancel(new Error("U2 public reference transport is closed"));
    else if (signal?.aborted) onAbort();
    else if (remaining <= 0) cancel(new DOMException("U2 reference request timed out", "TimeoutError"));
    else timer = setTimeout(() => cancel(new DOMException("U2 reference request timed out", "TimeoutError")), remaining);

    const operation = (async () => {
      if (stopped) throw stopReason;
      context = await newContext({
        ...(proxy ? { proxy } : {}),
        storageState: { cookies: [], origins: [] },
        ignoreHTTPSErrors: false,
        timeout: Math.max(1, deadline - Date.now()),
      });
      if (stopped || closed) {
        await dispose().catch(() => {});
        throw stopReason ?? new Error("U2 public reference transport is closed");
      }
      const response = await context.fetch(url.href, {
        method: init.method,
        headers: init.headers,
        ...(init.body !== undefined ? { data: init.body } : {}),
        timeout: Math.max(1, deadline - Date.now()),
        maxRedirects: 0,
        failOnStatusCode: false,
      });
      const status = response.status();
      // Playwright joins multiple Set-Cookie values with newlines, which a
      // Web Headers object rejects. Public references never need cookie headers.
      const headers = new Headers(Object.entries(response.headers())
        .filter(([name]) => !["set-cookie", "set-cookie2"].includes(name.toLowerCase())));
      const body = REDIRECT_STATUSES.has(status) ? null : await response.body();
      return { status, headers, body };
    })();
    try {
      return await Promise.race([operation, cancellation]);
    } finally {
      stopped = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      activeCalls.delete(cancel);
      await dispose().catch(() => {});
    }
  }

  async function fetchImpl(value, init = {}) {
    if (closed) throw new Error("U2 public reference transport is closed");
    if (init.credentials !== undefined && init.credentials !== "omit") {
      throw new Error("U2 public reference requests require omitted credentials");
    }
    let url = referenceUrl(value);
    let method = String(init.method ?? "GET").toUpperCase();
    if (!["GET", "HEAD", "POST"].includes(method) || method === "POST" && url.hostname !== "graphql.anilist.co") {
      throw new Error("U2 public reference request method is not approved");
    }
    const headers = publicHeaders(init.headers);
    let body = method === "POST" ? init.body : undefined;
    const deadline = Date.now() + timeoutMs;
    for (let redirects = 0; redirects <= 4; redirects += 1) {
      const response = await readHop(url, { method, headers, body }, init.signal, deadline);
      if (!REDIRECT_STATUSES.has(response.status)) {
        return new Response([204, 205, 304].includes(response.status) || method === "HEAD" ? null : response.body, {
          status: response.status,
          headers: response.headers,
        });
      }
      if (redirects === 4 || !response.headers.has("location")) throw new Error("U2 reference redirect could not be followed");
      const next = referenceUrl(new URL(response.headers.get("location"), url));
      if (method === "POST" && next.origin !== url.origin) throw new Error("U2 reference POST redirect changed origin");
      if (response.status === 303 && method !== "HEAD" || [301, 302].includes(response.status) && method === "POST") {
        method = "GET";
        body = undefined;
        delete headers["content-type"];
      }
      url = next;
    }
  }

  async function close() {
    closed = true;
    for (const cancel of [...activeCalls]) cancel(new Error("U2 public reference transport is closed"));
    await Promise.allSettled([...disposals]);
  }
  return { fetchImpl, close };
}
