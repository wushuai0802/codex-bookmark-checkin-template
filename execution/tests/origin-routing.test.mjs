import assert from "node:assert/strict";
import test from "node:test";
import {
  chromiumRouting,
  clearDynamicOriginRouteCache,
  configuredDynamicOriginRoutes,
  resolveDynamicOriginRoutes,
} from "../src/origin-routing.mjs";

test("动态来源路由只接受无凭据 HTTPS 来源并限制参数", () => {
  const entries = configuredDynamicOriginRoutes({
    dynamicOriginRoutes: {
      "https://example.test": {
        dnsServers: ["1.1.1.1", "invalid", "9.9.9.9"],
        hostnames: ["api.example.test"],
        ttlMs: 1,
        timeoutMs: 999999,
        maxCandidates: 99,
      },
      "http://plain.test": { dnsServers: ["1.1.1.1"] },
      [["https://", "user", ":", "pass", "@", "example", ".test"].join("")]: { dnsServers: ["1.1.1.1"] },
    },
  });
  assert.equal(entries.length, 1);
  assert.deepEqual(entries[0].hosts, ["example.test", "api.example.test"]);
  assert.equal(entries[0].ttlMs, 30000);
  assert.equal(entries[0].timeoutMs, 15000);
  assert.equal(entries[0].maxCandidates, 16);
});

test("动态路由只选择严格 HTTPS 探测通过的地址并可短期缓存", async () => {
  clearDynamicOriginRouteCache();
  let dnsCalls = 0;
  let probeCalls = 0;
  const config = {
    dynamicOriginRoutes: {
      "https://example.test": {
        dnsServers: ["1.1.1.1", "9.9.9.9"],
        ttlMs: 30000,
        timeoutMs: 1000,
      },
    },
  };
  const options = {
    resolve4: async (_host, server) => {
      dnsCalls += 1;
      return server === "1.1.1.1" ? ["192.0.2.10", "192.0.2.11"] : ["192.0.2.11"];
    },
    probe: async ({ address }) => {
      probeCalls += 1;
      return { ok: address === "192.0.2.11", statusCode: 200 };
    },
  };
  const first = await resolveDynamicOriginRoutes(config, options);
  assert.equal(first.length, 1);
  assert.equal(first[0].address, "192.0.2.11");
  assert.equal(first[0].statusCode, 200);
  const second = await resolveDynamicOriginRoutes(config, options);
  assert.deepEqual(second, first);
  assert.equal(dnsCalls, 2);
  assert.equal(probeCalls, 2);
});

test("Chromium 路由参数同时保留既有直连来源并生成 MAP 规则", () => {
  assert.deepEqual(
    chromiumRouting(
      { directConnectionOrigins: ["https://piggo.me"] },
      [{ origin: "https://example.test", host: "example.test", hosts: ["example.test", "api.example.test"], address: "192.0.2.11" }],
    ),
    {
      directHosts: ["piggo.me", "*.piggo.me", "example.test", "*.example.test", "api.example.test", "*.api.example.test"],
      hostResolverRules: "MAP example.test 192.0.2.11,MAP api.example.test 192.0.2.11",
    },
  );
});
