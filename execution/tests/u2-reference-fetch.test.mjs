import test from "node:test";
import assert from "node:assert/strict";
import { createU2ReferenceFetch } from "../src/u2-reference-fetch.mjs";

const aniList = "https://graphql.anilist.co/";
const mal = "https://myanimelist.net/anime.php?q=Reference";
const cover = "https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/test.jpg";
const emptyState = { cookies: [], origins: [] };
const fixtureValue = "synthetic";

function withFixtureCredentials(value) {
  const url = new URL(value);
  url.username = fixtureValue;
  url.password = fixtureValue;
  return url.href;
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function bounded(promise, ms = 750) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(Object.assign(new Error("mock operation did not settle"), {
          code: "fixture_watchdog",
        })), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function transportRejection(error) {
  assert.notEqual(error.code, "fixture_watchdog", "the transport must enforce its own deadline");
  return true;
}

function apiResponse({ status = 200, headers = {}, body = Buffer.from("public reference") } = {}) {
  return {
    status: () => status,
    headers: () => headers,
    body: typeof body === "function" ? body : async () => Buffer.from(body),
  };
}

function mockContexts(respond = () => apiResponse()) {
  const contexts = [];
  const requests = [];
  const newContext = async (options) => {
    const context = {
      options,
      cookies: [],
      disposeCalls: 0,
      async fetch(url, init) {
        const request = { url: String(url), init, context, cookies: [...context.cookies] };
        requests.push(request);
        const response = await respond(request, requests.length - 1);
        const cookie = Object.entries(response.headers()).find(([name]) => name.toLowerCase() === "set-cookie")?.[1];
        if (cookie) context.cookies.push(cookie);
        return response;
      },
      async dispose() { context.disposeCalls += 1; },
    };
    contexts.push(context);
    return context;
  };
  return { contexts, requests, newContext };
}

async function fixture(t, config = {}, respond, env = {}) {
  const mock = mockContexts(respond);
  const transport = await createU2ReferenceFetch(config, { env, newContext: mock.newContext });
  t.after(() => transport.close());
  return { ...mock, ...transport };
}

function assertIsolated(context) {
  assert.deepEqual(context.options.storageState, emptyState);
  assert.equal(context.options.httpCredentials, undefined);
  const headers = new Headers(context.options.extraHTTPHeaders);
  for (const name of ["cookie", "authorization", "proxy-authorization"]) {
    assert.equal(headers.get(name), null);
  }
}

test("public reference transport produces a standard Response from an isolated GraphQL request", async (t) => {
  const body = JSON.stringify({ query: "query { Page { media { id } } }" });
  const transport = await fixture(t, {
    storageState: "private-profile-state.json",
    httpCredentials: { username: fixtureValue, password: fixtureValue },
    extraHTTPHeaders: { Cookie: fixtureValue },
  }, () => apiResponse({ status: 202, headers: { "content-type": "application/json" }, body: '{"id":42}' }));
  const response = await transport.fetchImpl(new URL(aniList), {
    method: "POST",
    credentials: "omit",
    headers: new Headers({ Accept: "application/json", "Content-Type": "application/json" }),
    body,
  });
  assert.ok(response instanceof Response);
  assert.equal(response.status, 202);
  assert.equal(response.ok, true);
  assert.equal(response.headers.get("content-type"), "application/json");
  assert.deepEqual(await response.json(), { id: 42 });
  assert.equal(transport.requests.length, 1);
  assert.equal(transport.requests[0].init.method, "POST");
  assert.equal(transport.requests[0].init.data, body);
  assert.equal(transport.requests[0].init.maxRedirects, 0);
  assert.ok(transport.requests[0].init.timeout > 0 && transport.requests[0].init.timeout <= 8000);
  assertIsolated(transport.contexts[0]);
  assert.equal(transport.contexts[0].disposeCalls, 1);
});

test("reference image bytes and empty HTTP responses remain valid standard Responses", async (t) => {
  const image = Buffer.from([0, 255, 128, 1, 13, 10]);
  const transport = await fixture(t, {}, () => apiResponse({
    headers: { "content-type": "image/jpeg" }, body: image,
  }));
  const response = await transport.fetchImpl(cover);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), image);
  assert.equal(response.headers.get("content-type"), "image/jpeg");
  for (const status of [204, 205, 304]) {
    const empty = await fixture(t, {}, () => apiResponse({ status, body: "" }));
    const result = await empty.fetchImpl(mal);
    assert.equal(result.status, status);
    assert.equal(await result.text(), "");
    assert.equal(empty.contexts[0].disposeCalls, 1);
  }
});

test("Playwright's newline-joined Set-Cookie values do not prevent public HTML from being read", async (t) => {
  const transport = await fixture(t, {}, () => apiResponse({
    headers: {
      "content-type": "text/html; charset=utf-8",
      "set-cookie": `fixture-one=${fixtureValue}; Secure\nfixture-two=${fixtureValue}; Secure`,
      "set-cookie2": `fixture-three=${fixtureValue}; Version=1\nfixture-four=${fixtureValue}; Version=1`,
    },
    body: '<img alt="Reference" src="https://cdn.myanimelist.net/images/anime/4/75488.jpg">',
  }));
  const response = await transport.fetchImpl(mal);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "text/html; charset=utf-8");
  assert.equal(response.headers.get("set-cookie"), null);
  assert.equal(response.headers.get("set-cookie2"), null);
  assert.match(await response.text(), /images\/anime\/4\/75488\.jpg/);
  await transport.fetchImpl(mal);
  assert.deepEqual(transport.requests[1].cookies, []);
  assert.ok(transport.contexts.every((context) => context.disposeCalls === 1));
});

test("the public URL whitelist accepts only the intended API, search and anime image routes", async (t) => {
  const transport = await fixture(t);
  for (const url of [
    "https://graphql.anilist.co",
    "https://graphql.anilist.co:443/",
    mal,
    cover,
    "https://s2.anilist.co/file/anilistcdn/media/anime/cover/medium/test.png",
    "https://cdn.myanimelist.net/images/anime/4/75488.jpg?s=public",
  ]) {
    const result = await transport.fetchImpl(url);
    assert.equal(result.status, 200);
  }
  assert.equal(transport.requests.length, 6);
  assert.ok(transport.contexts.every((context) => context.disposeCalls === 1));
});

test("initial private, insecure, credential-bearing and unrelated URLs never create a context", async (t) => {
  const transport = await fixture(t);
  for (const url of [
    "http://graphql.anilist.co/",
    withFixtureCredentials(aniList),
    "https://graphql.anilist.co:444/",
    "https://graphql.anilist.co/v2",
    "https://graphql.anilist.co/?query=fixture",
    "https://graphql.anilist.co/#fixture",
    "https://graphql.anilist.co.evil.invalid/",
    "https://api.graphql.anilist.co/",
    "https://myanimelist.net/login.php",
    "https://myanimelist.net/anime.php/",
    "https://myanimelist.net:8080/anime.php",
    "https://myanimelist.net/anime.php#fixture",
    "https://s4.anilist.co/file/anilistcdn/media/manga/cover/test.jpg",
    "https://s4.anilist.co/file/anilistcdn/media/anime",
    "https://s4.anilist.co/file/anilistcdn/media/anime/../manga/test.jpg",
    "https://cdn.myanimelist.net/r/50x70/images/anime/4/75488.jpg",
    "https://cdn.myanimelist.net/images/manga/4/75488.jpg",
    "https://127.0.0.1/anime.php",
    "https://localhost/anime.php",
    "https://100.64.0.1/anime.php",
    "file:///private/reference.jpg",
  ]) {
    await assert.rejects(() => transport.fetchImpl(url), transportRejection, url);
  }
  assert.equal(transport.contexts.length, 0);
  assert.equal(transport.requests.length, 0);
});

test("credential modes and credential headers are rejected before any public request", async (t) => {
  const transport = await fixture(t);
  for (const credentials of ["include", "same-origin"]) {
    await assert.rejects(() => transport.fetchImpl(mal, { credentials }), transportRejection);
  }
  for (const headers of [
    { Cookie: fixtureValue },
    { cOoKiE: fixtureValue },
    new Headers({ Authorization: ["Bearer", fixtureValue].join(" ") }),
    [["Proxy-Authorization", ["Basic", fixtureValue].join(" ")]],
  ]) {
    await assert.rejects(() => transport.fetchImpl(mal, { headers }), transportRejection);
  }
  assert.equal(transport.contexts.length, 0);
  await transport.fetchImpl(mal);
  await transport.fetchImpl(mal, { credentials: "omit" });
  assert.equal(transport.requests.length, 2);
});

test("only public Accept, Content-Type and User-Agent headers reach the request context", async (t) => {
  const transport = await fixture(t);
  await transport.fetchImpl(aniList, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "User-Agent": "public-reference-test",
      "X-Private-Token": "fixture-private-value",
      Referer: "https://private.invalid/",
      Origin: "https://private.invalid",
      Host: "private.invalid",
    },
    body: "{}",
  });
  const headers = new Headers(transport.requests[0].init.headers);
  assert.equal(headers.get("accept"), "application/json");
  assert.equal(headers.get("content-type"), "application/json");
  assert.equal(headers.get("user-agent"), "public-reference-test");
  assert.deepEqual([...headers.keys()].sort(), ["accept", "content-type", "user-agent"]);
});

test("writes are limited to the public AniList GraphQL POST", async (t) => {
  const transport = await fixture(t, {}, () => apiResponse({ body: "" }));
  for (const [url, method] of [[mal, "POST"], [cover, "POST"], [aniList, "PUT"], [mal, "DELETE"]]) {
    await assert.rejects(() => transport.fetchImpl(url, { method, body: "fixture" }), transportRejection);
  }
  assert.equal(transport.contexts.length, 0);
  await transport.fetchImpl(mal, { method: "HEAD" });
  assert.equal(transport.requests[0].init.method, "HEAD");
  await transport.fetchImpl(aniList, { method: "POST", body: "{}" });
  assert.equal(transport.requests[1].init.method, "POST");
});

test("proxy selection uses only credential-free loopback HTTP candidates and preserves precedence", async (t) => {
  const cases = [
    [{ u2ReferenceProxyServer: "http://127.0.0.1:7890" }, { HTTPS_PROXY: "http://localhost:8080" }, "http://127.0.0.1:7890"],
    [{ u2ReferenceProxyServer: withFixtureCredentials("http://localhost:7890") }, { HTTPS_PROXY: "http://127.0.0.1:8080" }, "http://127.0.0.1:8080"],
    [{}, { HTTPS_PROXY: "http://remote.invalid:8080", https_proxy: "http://localhost:7890" }, "http://localhost:7890"],
    [{}, { HTTPS_PROXY: "invalid", https_proxy: "https://localhost:7890", HTTP_PROXY: "http://[::1]:8080" }, "http://[::1]:8080"],
    [{}, { http_proxy: "http://127.0.0.1:7890/" }, "http://127.0.0.1:7890"],
  ];
  for (const [config, env, expected] of cases) {
    const transport = await fixture(t, config, undefined, env);
    await transport.fetchImpl(mal);
    const proxy = transport.contexts[0].options.proxy;
    assert.equal(new URL(proxy.server).origin, expected);
    assert.equal(proxy.username, undefined);
    assert.equal(proxy.password, undefined);
    assertIsolated(transport.contexts[0]);
  }
});

test("invalid or absent proxy settings use an isolated direct context", async (t) => {
  for (const candidate of [
    undefined, "", "not a URL", "https://localhost:7890", "socks5://127.0.0.1:7890",
    "http://remote.invalid:7890", "http://127.0.0.2:7890", "http://localhost",
    "http://localhost:7890/private", "http://localhost:7890/?token=fixture", "http://localhost:7890/#fixture",
    withFixtureCredentials("http://localhost:7890"),
  ]) {
    const transport = await fixture(t, { u2ReferenceProxyServer: candidate }, undefined, {
      HTTPS_PROXY: candidate, https_proxy: candidate, HTTP_PROXY: candidate, http_proxy: candidate,
    });
    await transport.fetchImpl(mal);
    assert.ok(transport.contexts[0].options.proxy == null);
    assertIsolated(transport.contexts[0]);
  }
});

test("each redirect and independent fetch uses a new jar without forwarding Set-Cookie", async (t) => {
  const transport = await fixture(t, {}, (_, index) => index === 0
    ? apiResponse({ status: 302, headers: { location: "/anime.php?q=Next", "set-cookie": `fixture-cookie=${fixtureValue}; Secure` } })
    : apiResponse({ body: "final public reference" }));
  const response = await transport.fetchImpl(mal, { headers: { Accept: "text/html" } });
  assert.equal(await response.text(), "final public reference");
  await transport.fetchImpl(mal);
  assert.equal(transport.contexts.length, 3);
  assert.equal(new Set(transport.contexts).size, 3);
  assert.equal(new Set(transport.contexts.map((context) => context.options.storageState)).size, 3);
  assert.equal(transport.requests[1].url, "https://myanimelist.net/anime.php?q=Next");
  for (const request of transport.requests) {
    assert.deepEqual(request.cookies, []);
    assert.equal(new Headers(request.init.headers).get("cookie"), null);
    assert.equal(request.init.maxRedirects, 0);
    assertIsolated(request.context);
    assert.equal(request.context.disposeCalls, 1);
  }
});

test("every redirect target is revalidated before a second context or request is created", async (t) => {
  for (const location of [
    "http://myanimelist.net/anime.php",
    "https://private.invalid/reference.jpg",
    withFixtureCredentials(mal),
    "/login.php",
    "https://myanimelist.net:444/anime.php",
    "https://cdn.myanimelist.net/images/manga/private.jpg",
    "https://127.0.0.1/private",
  ]) {
    const transport = await fixture(t, {}, () => apiResponse({ status: 302, headers: { location } }));
    await assert.rejects(() => transport.fetchImpl(mal), transportRejection, location);
    assert.equal(transport.requests.length, 1);
    assert.equal(transport.contexts.length, 1);
    assert.equal(transport.contexts[0].disposeCalls, 1);
  }
});

test("a GraphQL POST never redirects its payload to another public origin", async (t) => {
  for (const status of [301, 302, 303, 307, 308]) {
    const transport = await fixture(t, {}, () => apiResponse({ status, headers: { location: cover } }));
    await assert.rejects(() => transport.fetchImpl(aniList, { method: "POST", body: "fixture-graphql-payload" }), transportRejection);
    assert.equal(transport.requests.length, 1);
    assert.equal(transport.contexts[0].disposeCalls, 1);
  }
});

test("same-origin POST redirects preserve or drop their payload according to HTTP status", async (t) => {
  for (const status of [301, 302, 303, 307, 308]) {
    const transport = await fixture(t, {}, (_, index) => index === 0
      ? apiResponse({ status, headers: { location: aniList } }) : apiResponse());
    await transport.fetchImpl(aniList, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: "fixture-payload",
    });
    assert.equal(transport.requests.length, 2);
    const second = transport.requests[1].init;
    const preservesPost = status === 307 || status === 308;
    assert.equal(second.method, preservesPost ? "POST" : "GET");
    assert.equal(second.data, preservesPost ? "fixture-payload" : undefined);
    assert.equal(new Headers(second.headers).get("content-type"), preservesPost ? "application/json" : null);
    assert.ok(transport.contexts.every((context) => context.disposeCalls === 1));
  }
});

test("redirect loops are bounded and release every context", async (t) => {
  const transport = await fixture(t, {}, () => apiResponse({ status: 302, headers: { location: mal } }));
  await assert.rejects(() => bounded(transport.fetchImpl(mal)), transportRejection);
  assert.ok(transport.requests.length > 0 && transport.requests.length <= 20);
  assert.ok(transport.contexts.every((context) => context.disposeCalls === 1));
});

test("redirect hops share a decreasing request deadline", async (t) => {
  const transport = await fixture(t, { u2ReferenceRequestTimeoutMs: 200 }, async (_, index) => {
    if (index < 2) {
      await pause(20);
      return apiResponse({ status: 302, headers: { location: `/anime.php?q=Next${index}` } });
    }
    return apiResponse();
  });
  await transport.fetchImpl(mal);
  const timeouts = transport.requests.map((request) => request.init.timeout);
  assert.equal(timeouts.length, 3);
  assert.ok(timeouts[0] > 0 && timeouts[0] <= 200);
  assert.ok(timeouts[1] < timeouts[0] - 10);
  assert.ok(timeouts[2] < timeouts[1] - 10);
  assert.ok(transport.contexts.every((context) => context.disposeCalls === 1));
});

test("request and body stalls time out promptly and dispose the active context", async (t) => {
  for (const stage of ["request", "body"]) {
    const never = new Promise(() => {});
    const transport = await fixture(t, { u2ReferenceRequestTimeoutMs: 30 }, () => stage === "request"
      ? never : apiResponse({ body: () => never }));
    const started = Date.now();
    await assert.rejects(() => bounded(transport.fetchImpl(mal)), transportRejection, stage);
    assert.ok(Date.now() - started < 500);
    assert.equal(transport.requests.length, 1);
    assert.equal(transport.contexts[0].disposeCalls, 1);
  }
});

test("pre-aborted signals do not create a context", async (t) => {
  const transport = await fixture(t);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(() => bounded(transport.fetchImpl(mal, { signal: controller.signal })), transportRejection);
  assert.equal(transport.contexts.length, 0);
});

test("abort interrupts stalled request and body reads and disposes their contexts", async (t) => {
  for (const stage of ["request", "body"]) {
    const reached = deferred();
    const never = new Promise(() => {});
    const transport = await fixture(t, { u2ReferenceRequestTimeoutMs: 5000 }, () => {
      if (stage === "request") { reached.resolve(); return never; }
      return apiResponse({ body: () => { reached.resolve(); return never; } });
    });
    const controller = new AbortController();
    const pending = bounded(transport.fetchImpl(mal, { signal: controller.signal }));
    const rejected = assert.rejects(() => pending, transportRejection);
    await bounded(reached.promise);
    controller.abort();
    await rejected;
    assert.equal(transport.contexts[0].disposeCalls, 1);
  }
});

test("cancelled context creation settles promptly and disposes a context that arrives late", async (t) => {
  for (const cancellation of ["abort", "timeout", "close"]) {
    const creation = deferred();
    const reached = deferred();
    let disposeCalls = 0;
    let fetchCalls = 0;
    const transport = await createU2ReferenceFetch({ u2ReferenceRequestTimeoutMs: cancellation === "timeout" ? 30 : 5000 }, {
      env: {},
      newContext: () => { reached.resolve(); return creation.promise; },
    });
    t.after(() => transport.close());
    const controller = new AbortController();
    const pending = bounded(transport.fetchImpl(mal, { signal: controller.signal }));
    const rejected = assert.rejects(() => pending, transportRejection);
    await bounded(reached.promise);
    if (cancellation === "abort") controller.abort();
    if (cancellation === "close") await bounded(transport.close());
    await rejected;
    await bounded(transport.close());
    await bounded(transport.close());
    creation.resolve({
      async fetch() { fetchCalls += 1; return apiResponse(); },
      async dispose() { disposeCalls += 1; },
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(fetchCalls, 0);
    assert.equal(disposeCalls, 1);
  }
});

test("request failures release their context and leave later references usable", async (t) => {
  const transport = await fixture(t, {}, (_, index) => {
    if (index === 0) throw new Error("fixture network failure");
    return apiResponse();
  });
  await assert.rejects(() => transport.fetchImpl(mal), /fixture network failure/);
  assert.equal(transport.contexts[0].disposeCalls, 1);
  assert.equal((await transport.fetchImpl(mal)).status, 200);
  assert.equal(transport.contexts[1].disposeCalls, 1);
});

test("close cancels concurrent active references, disposes once and is idempotent", async (t) => {
  const reached = [deferred(), deferred()];
  const never = new Promise(() => {});
  const transport = await fixture(t, { u2ReferenceRequestTimeoutMs: 5000 }, (_, index) => {
    if (index === 0) { reached[index].resolve(); return never; }
    return apiResponse({ body: () => { reached[index].resolve(); return never; } });
  });
  const pending = Promise.allSettled([
    bounded(transport.fetchImpl(mal)),
    bounded(transport.fetchImpl(cover)),
  ]);
  await bounded(Promise.all(reached.map((entry) => entry.promise)));
  await bounded(transport.close());
  await bounded(transport.close());
  const results = await pending;
  assert.ok(results.every((result) => result.status === "rejected"));
  for (const result of results) transportRejection(result.reason);
  assert.equal(transport.contexts.length, 2);
  assert.ok(transport.contexts.every((context) => context.disposeCalls === 1));
  await assert.rejects(() => transport.fetchImpl(mal), transportRejection);
  assert.equal(transport.contexts.length, 2);
});
