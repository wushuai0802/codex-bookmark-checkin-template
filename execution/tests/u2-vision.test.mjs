import test from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import { parseMyAnimeListSearchImages, solveU2VisualChallenge } from "../src/u2-vision.mjs";

const options = [
  { name: "captcha_red", text: "Reference Red" },
  { name: "captcha_blue", text: "Reference Blue" },
];

async function visualFixture() {
  const cover = (background) => sharp({ create: { width: 200, height: 240, channels: 3, background } }).png().toBuffer();
  const [red, blue] = await Promise.all([cover("red"), cover("blue")]);
  const image = await sharp({ create: { width: 400, height: 273, channels: 3, background: "white" } })
    .composite([
      { input: red, left: 0, top: 0 },
      { input: blue, left: 200, top: 0 },
      { input: Buffer.from('<svg width="400" height="240"><circle cx="100" cy="120" r="28" fill="white" stroke="black" stroke-width="3"/></svg>'), left: 0, top: 0 },
    ]).png().toBuffer();
  return { image, covers: [red, blue] };
}

function aniListResponse(index) {
  return new Response(JSON.stringify({ data: { Page: { media: [{
    id: index + 1,
    coverImage: { large: `https://s4.anilist.co/test-cover-${index}.png` },
  }] } } }));
}

function malResponse(index) {
  return new Response(`<img alt="${options[index].text}" data-src="https://cdn.myanimelist.net/test-cover-${index}.png">`);
}

function optionIndex(url, init) {
  const parsed = new URL(url);
  const search = parsed.hostname === "graphql.anilist.co" ? JSON.parse(init.body).variables.search : parsed.searchParams.get("q");
  return options.findIndex((option) => option.text === search);
}

test("U2 备用作品源只接受标题匹配的 MyAnimeList CDN 图片", () => {
  const html = `
    <img alt="School Rumble" data-src="https://cdn.myanimelist.net/r/50x70/images/anime/4/75488.jpg?s=abc">
    <img alt="Unrelated School" data-src="https://cdn.myanimelist.net/r/50x70/images/anime/1/2.jpg?s=def">
    <img alt="School Rumble: Extra Class" data-src="https://cdn.myanimelist.net/r/100x140/images/anime/3/4.jpg?s=ghi">
    <img alt="School Rumble" data-src="https://attacker.invalid/image.jpg">
  `;
  assert.deepEqual(parseMyAnimeListSearchImages(html, ["School Rumble"]), [
    "https://cdn.myanimelist.net/images/anime/4/75488.jpg?s=abc",
    "https://cdn.myanimelist.net/images/anime/3/4.jpg?s=ghi",
  ]);
});

test("U2 uses the supplied public reference transport and keeps the existing visual solver", async () => {
  const { image, covers } = await visualFixture();
  const requests = [];
  const result = await solveU2VisualChallenge(image, options, {
    fetchImpl: async (url, init) => {
      requests.push(String(url));
      assert.equal(init.credentials, "omit");
      assert.ok(init.signal instanceof AbortSignal);
      if (String(url) === "https://graphql.anilist.co") return aniListResponse(optionIndex(url, init));
      const match = new URL(url).pathname.match(/test-cover-(\d)\.png$/);
      assert.ok(match);
      return new Response(covers[Number(match[1])]);
    },
  });
  assert.equal(result.answer, options[0]);
  assert.equal(result.diagnostics.dottedSide, "left");
  assert.equal(requests.length, 4);
});

test("U2 bounds a stalled reference body and still tries the backup source", async () => {
  const { image, covers } = await visualFixture();
  const stalledSignals = [];
  const result = await solveU2VisualChallenge(image, options, {
    requestTimeoutMs: 20,
    timeoutMs: 2000,
    fetchImpl: async (url, init) => {
      const parsed = new URL(url);
      if (parsed.hostname === "graphql.anilist.co") {
        stalledSignals.push(init.signal);
        return { ok: true, json: () => new Promise(() => {}) };
      }
      if (parsed.hostname === "myanimelist.net") return malResponse(optionIndex(url, init));
      return new Response(covers[Number(parsed.pathname.match(/test-cover-(\d)\.png$/)[1])]);
    },
  });
  assert.equal(result.answer, options[0]);
  assert.equal(stalledSignals.length, 2);
  assert.ok(stalledSignals.every((signal) => signal.aborted));
});

test("U2 returns an unsubmitted answer on both-source network failure", async () => {
  const { image } = await visualFixture();
  const sources = new Set();
  const result = await solveU2VisualChallenge(image, options, {
    fetchImpl: async (url) => {
      sources.add(new URL(url).hostname);
      throw Object.assign(new Error("connection reset"), { code: "ECONNRESET" });
    },
  });
  assert.equal(result.answer, null);
  assert.equal(result.failureCode, "u2_reference_unavailable");
  assert.match(result.reason, /未返回足够/);
  assert.deepEqual([...sources].sort(), ["graphql.anilist.co", "myanimelist.net"]);
  assert.equal(result.diagnostics.failedRequests, 4);
  assert.equal(result.diagnostics.timedOutRequests, 0);
});

test("U2 applies one reference deadline even if the injected transport ignores abort", async () => {
  const { image } = await visualFixture();
  const requests = [];
  const started = Date.now();
  const result = await solveU2VisualChallenge(image, options, {
    requestTimeoutMs: 1000,
    timeoutMs: 25,
    fetchImpl: async (url) => {
      requests.push(String(url));
      return new Promise(() => {});
    },
  });
  assert.equal(result.answer, null);
  assert.equal(result.failureCode, "u2_reference_timeout");
  assert.match(result.reason, /读取超时/);
  assert.equal(result.diagnostics.referenceDeadlineReached, true);
  assert.equal(result.diagnostics.timedOutRequests, 2);
  assert.ok(Date.now() - started < 500);
  assert.equal(requests.length, 2);
});

test("U2 keeps a primary cover when the backup source only supplies the other candidate", async () => {
  const { image, covers } = await visualFixture();
  const result = await solveU2VisualChallenge(image, options, {
    fetchImpl: async (url, init) => {
      const parsed = new URL(url);
      if (parsed.hostname === "graphql.anilist.co") return optionIndex(url, init) === 0 ? aniListResponse(0) : new Response("", { status: 503 });
      if (parsed.hostname === "myanimelist.net") return optionIndex(url, init) === 1 ? malResponse(1) : new Response("");
      return new Response(covers[Number(parsed.pathname.match(/test-cover-(\d)\.png$/)[1])]);
    },
  });
  assert.equal(result.answer, options[0]);
});

test("U2 discards a malformed cover and recovers through backup references", async () => {
  const { image, covers } = await visualFixture();
  const result = await solveU2VisualChallenge(image, options, {
    fetchImpl: async (url, init) => {
      const parsed = new URL(url);
      if (parsed.hostname === "graphql.anilist.co") return aniListResponse(optionIndex(url, init));
      if (parsed.hostname === "s4.anilist.co") return new Response("not an image");
      if (parsed.hostname === "myanimelist.net") return malResponse(optionIndex(url, init));
      return new Response(covers[Number(parsed.pathname.match(/test-cover-(\d)\.png$/)[1])]);
    },
  });
  assert.equal(result.answer, options[0]);
});

test("U2 distinguishes an ambiguous visual match from missing public references", async () => {
  const { image, covers } = await visualFixture();
  const result = await solveU2VisualChallenge(image, options, {
    fetchImpl: async (url, init) => String(url) === "https://graphql.anilist.co"
      ? aniListResponse(optionIndex(url, init)) : new Response(covers[0]),
  });
  assert.equal(result.answer, null);
  assert.equal(result.failureCode, "u2_visual_ambiguous");
  assert.match(result.reason, /匹配不够明确/);
});
