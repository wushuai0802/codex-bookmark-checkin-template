import dns from "node:dns";
import https from "node:https";
import net from "node:net";

const DEFAULT_DNS_SERVERS = ["1.1.1.1", "9.9.9.9", "8.8.8.8"];
const DEFAULT_ROUTE_TTL_MS = 5 * 60 * 1000;
const MIN_ROUTE_TTL_MS = 30 * 1000;
const MAX_ROUTE_TTL_MS = 60 * 60 * 1000;
const DEFAULT_PROBE_TIMEOUT_MS = 7000;
const MAX_PROBE_TIMEOUT_MS = 15000;
const routeCache = new Map();

function cleanOrigin(value) {
  try {
    const parsed = new URL(String(value));
    if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.pathname !== "/"
      && parsed.pathname !== "") return null;
    return parsed.origin;
  } catch {
    return null;
  }
}

function cleanAddress(value) {
  return net.isIPv4(String(value)) ? String(value) : null;
}

function boundedInteger(value, fallback, minimum, maximum) {
  const number = Number(value);
  return Number.isInteger(number) ? Math.max(minimum, Math.min(maximum, number)) : fallback;
}

function routeEntries(config = {}) {
  const configured = config.dynamicOriginRoutes;
  if (!configured || typeof configured !== "object" || Array.isArray(configured)) return [];
  return Object.entries(configured).flatMap(([rawOrigin, rawPolicy]) => {
    const origin = cleanOrigin(rawOrigin);
    if (!origin || !rawPolicy || typeof rawPolicy !== "object" || Array.isArray(rawPolicy)) return [];
    const host = new URL(origin).hostname;
    const dnsNames = [...new Set([host, ...(Array.isArray(rawPolicy.dnsNames) ? rawPolicy.dnsNames : [])
      .map((value) => String(value).trim().toLowerCase())])]
      .filter((value) => /^[a-z0-9.-]{1,253}$/i.test(value) && !value.includes(".."));
    const hosts = [...new Set([host, ...(Array.isArray(rawPolicy.hostnames) ? rawPolicy.hostnames : [])
      .map((value) => String(value).trim().toLowerCase())])]
      .filter((value) => /^[a-z0-9.-]{1,253}$/i.test(value) && !value.includes(".."));
    const dnsServers = [...new Set((Array.isArray(rawPolicy.dnsServers) ? rawPolicy.dnsServers : DEFAULT_DNS_SERVERS)
      .map(cleanAddress)
      .filter(Boolean))].slice(0, 8);
    if (dnsServers.length === 0) return [];
    const probePath = String(rawPolicy.probePath || "/");
    if (!probePath.startsWith("/") || probePath.length > 200 || /[\r\n]/.test(probePath)) return [];
    return [{
      origin,
      host,
      hosts,
      dnsNames,
      dnsServers,
      probePath,
      ttlMs: boundedInteger(rawPolicy.ttlMs, DEFAULT_ROUTE_TTL_MS, MIN_ROUTE_TTL_MS, MAX_ROUTE_TTL_MS),
      timeoutMs: boundedInteger(rawPolicy.timeoutMs, DEFAULT_PROBE_TIMEOUT_MS, 1000, MAX_PROBE_TIMEOUT_MS),
      maxCandidates: boundedInteger(rawPolicy.maxCandidates, 8, 1, 16),
    }];
  });
}

function resolve4WithServer(host, server, timeoutMs) {
  const resolver = new dns.promises.Resolver();
  resolver.setServers([server]);
  return Promise.race([
    resolver.resolve4(host),
    new Promise((_, reject) => setTimeout(() => reject(new Error("DNS timeout")), timeoutMs)),
  ]).then((addresses) => addresses.map(cleanAddress).filter(Boolean));
}

function probeHttpsAddress(host, address, requestPath, timeoutMs, probe = null) {
  if (typeof probe === "function") return probe({ host, address, requestPath, timeoutMs });
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const request = https.request({
      hostname: address,
      port: 443,
      servername: host,
      method: "GET",
      path: requestPath,
      headers: { Host: host, Accept: "*/*", Connection: "close" },
      timeout: timeoutMs,
      rejectUnauthorized: true,
    }, (response) => {
      response.resume();
      response.once("end", () => finish({
        ok: response.statusCode >= 100 && response.statusCode < 600,
        statusCode: response.statusCode ?? 0,
      }));
    });
    request.once("error", () => finish({ ok: false, statusCode: 0 }));
    request.once("timeout", () => {
      request.destroy();
      finish({ ok: false, statusCode: 0 });
    });
    request.end();
  });
}

async function resolveRoute(policy, dependencies = {}) {
  const resolve4 = dependencies.resolve4 ?? resolve4WithServer;
  const probe = dependencies.probe;
  const dnsTimeoutMs = Math.max(1000, Math.min(10000, policy.timeoutMs));
  const discovered = [];
  for (const queryHost of policy.dnsNames ?? [policy.host]) {
    for (const server of policy.dnsServers) {
      try {
        const addresses = await resolve4(queryHost, server, dnsTimeoutMs);
        for (const address of addresses) if (!discovered.includes(address)) discovered.push(address);
      } catch {
        // One resolver can be filtered or unavailable; continue with the others.
      }
    }
  }
  const candidates = discovered.slice(0, policy.maxCandidates);
  const probes = await Promise.all(candidates.map(async (address) => ({
    address,
    ...(await probeHttpsAddress(policy.host, address, policy.probePath, policy.timeoutMs, probe)),
  })));
  const selected = probes.find((value) => value.ok && value.statusCode >= 200 && value.statusCode < 500);
  if (!selected) return null;
  return {
    origin: policy.origin,
    host: policy.host,
    hosts: policy.hosts,
    address: selected.address,
    statusCode: selected.statusCode,
    expiresAt: Date.now() + policy.ttlMs,
  };
}

export function configuredDynamicOriginRoutes(config = {}) {
  return routeEntries(config);
}

export async function resolveDynamicOriginRoutes(config = {}, options = {}) {
  const requestedOrigins = options.origins ? new Set(options.origins.map(cleanOrigin).filter(Boolean)) : null;
  const entries = routeEntries(config).filter((entry) => !requestedOrigins || requestedOrigins.has(entry.origin));
  const now = Date.now();
  const resolved = [];
  for (const entry of entries) {
    const cached = routeCache.get(entry.origin);
    if (cached && cached.expiresAt > now) {
      resolved.push(cached);
      continue;
    }
    const route = await resolveRoute(entry, options);
    if (route) {
      routeCache.set(entry.origin, route);
      resolved.push(route);
    } else {
      routeCache.delete(entry.origin);
    }
  }
  return resolved;
}

export function chromiumRouting(config = {}, routes = []) {
  const directHosts = new Set();
  for (const value of config.directConnectionOrigins ?? []) {
    try {
      const parsed = new URL(String(value));
      if (parsed.protocol === "https:" && parsed.hostname) {
        directHosts.add(parsed.hostname);
        directHosts.add(`*.${parsed.hostname}`);
      }
    } catch { /* ignore malformed optional entries */ }
  }
  const resolverRules = [];
  for (const route of routes) {
    for (const host of route.hosts ?? [route.host]) {
      directHosts.add(host);
      directHosts.add(`*.${host}`);
      resolverRules.push(`MAP ${host} ${route.address}`);
    }
  }
  return {
    directHosts: [...directHosts],
    hostResolverRules: resolverRules.length > 0 ? [...new Set(resolverRules)].join(",") : "",
  };
}

export function clearDynamicOriginRouteCache() {
  routeCache.clear();
}
