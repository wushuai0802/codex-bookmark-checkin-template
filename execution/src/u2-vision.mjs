import sharp from "sharp";
import { u2DiagnosticCodes } from "./checkin-contract.generated.mjs";

// Report boundary: never copy solver objects, option text, URLs or exceptions.
export function projectU2Diagnostics(value) {
  if (!value || typeof value !== "object") return undefined;
  const codes = new Set(u2DiagnosticCodes);
  const numbers = ["referenceCount", "bestTotal", "alternativeTotal", "matchGap", "distanceRatio", "circleRatio",
    "requests", "failedRequests", "timedOutRequests", "questionCount"];
  const project = (row) => {
    const result = {};
    for (const key of numbers) if (typeof row?.[key] === "number" && Number.isFinite(row[key]) && row[key] >= 0) result[key] = row[key];
    for (const key of ["timedOut", "referenceDeadlineReached", "stepTimedOut"]) if (typeof row?.[key] === "boolean") result[key] = row[key];
    for (const key of ["subreason", "stopCode"]) if (codes.has(row?.[key])) result[key] = row[key];
    if (typeof row?.originalFailureCode === "string" && /^[a-z][a-z0-9_]{0,79}$/.test(row.originalFailureCode)) result.originalFailureCode = row.originalFailureCode;
    if (Array.isArray(row?.optionReferenceCounts)) result.optionReferenceCounts = row.optionReferenceCounts.slice(0, 100)
      .map(count => Number.isSafeInteger(count) && count >= 0 ? count : 0);
    return result;
  };
  return { ...project(value),
    ...(Array.isArray(value.questions) ? { questions: value.questions.slice(0, 5).map(project) } : {}),
    ...(Array.isArray(value.subreasons) ? { subreasons: value.subreasons.slice(0, 5).filter(code => codes.has(code)) } : {}) };
}

const ANILIST_ENDPOINT = "https://graphql.anilist.co";
const MYANIMELIST_SEARCH = "https://myanimelist.net/anime.php";
const REFERENCE_USER_AGENT = "codex-bookmark-checkin/1.0";
const ANILIST_QUERY = `
  query ($search: String) {
    Page(perPage: 4) {
      media(search: $search, type: ANIME) {
        id
        title { romaji english native }
        coverImage { extraLarge large }
        bannerImage
      }
    }
  }
`;

function normalizedAliases(text) {
  return [...new Set(String(text || "").split("/")
    .map((value) => value.trim())
    .filter((value) => value.length >= 3)
    .sort((left, right) => {
      const leftAscii = /^[\x00-\x7F]+$/.test(left) ? 0 : 1;
      const rightAscii = /^[\x00-\x7F]+$/.test(right) ? 0 : 1;
      return leftAscii - rightAscii;
    })
    .map((value) => value
      .replace(/[()[\]{}:;,.!☆†~～—–-]+/g, " ")
      .replace(/\s+/g, " ")
      .trim()))];
}

async function imageVector(input, width = 24, height = 24) {
  const { data } = await sharp(input)
    .resize(width, height, { fit: "fill" })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const vector = new Float32Array(data.length);
  for (let index = 0; index < data.length; index += 1) vector[index] = data[index] / 255;
  return vector;
}

function vectorDistance(left, right) {
  let sum = 0;
  for (let index = 0; index < left.length; index += 1) sum += Math.abs(left[index] - right[index]);
  return sum / left.length;
}

function createReferenceReader(fetchImpl, requestTimeoutMs, timeoutMs, signal) {
  const positiveTimeout = (value, fallback) => Number.isFinite(value) && value > 0 ? Math.ceil(value) : fallback;
  const requestTimeout = positiveTimeout(requestTimeoutMs, 8000);
  const deadline = Date.now() + positiveTimeout(timeoutMs, 60000);
  const diagnostics = { requests: 0, failedRequests: 0, timedOutRequests: 0 };
  return {
    diagnostics,
    expired: () => signal?.aborted || Date.now() >= deadline,
    async read(url, init, bodyType) {
      const remaining = deadline - Date.now();
      if (signal?.aborted || remaining <= 0) return null;
      diagnostics.requests += 1;
      const controller = new AbortController();
      const abort = () => controller.abort();
      signal?.addEventListener("abort", abort, { once: true });
      let timer;
      const request = (async () => {
        try {
          const response = await fetchImpl(url, { ...init, credentials: "omit", signal: controller.signal });
          if (!response?.ok) return null;
          return await response[bodyType]();
        } catch (error) {
          if (error?.name === "TimeoutError" && !controller.signal.aborted) diagnostics.timedOutRequests += 1;
          return null;
        }
      })();
      try {
        const result = await Promise.race([
          request,
          new Promise((resolve) => {
            timer = setTimeout(() => {
              diagnostics.timedOutRequests += 1;
              controller.abort();
              resolve(null);
            }, Math.min(requestTimeout, remaining));
          }),
        ]);
        if (result === null) diagnostics.failedRequests += 1;
        return result;
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
      }
    },
  };
}

async function fetchOptionReferences(option, optionIndex, reader) {
  const media = new Map();
  for (const alias of normalizedAliases(option.text).slice(0, 4)) {
    if (reader.expired()) break;
    const body = await reader.read(ANILIST_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json", "user-agent": REFERENCE_USER_AGENT },
      body: JSON.stringify({ query: ANILIST_QUERY, variables: { search: alias } }),
    }, "json");
    for (const item of body?.data?.Page?.media ?? []) media.set(item.id, item);
    if (media.size >= 2) break;
  }

  const references = [];
  for (const item of [...media.values()].slice(0, 5)) {
    for (const [kind, url] of [["cover", item.coverImage?.extraLarge || item.coverImage?.large], ["banner", item.bannerImage]]) {
      if (!url || reader.expired()) continue;
      const body = await reader.read(url, {}, "arrayBuffer");
      if (!body) continue;
      const vector = await imageVector(Buffer.from(body)).catch(() => null);
      if (!vector) continue;
      references.push({
        optionIndex,
        optionName: option.name,
        optionText: option.text,
        mediaId: item.id,
        kind,
        url,
        vector,
      });
    }
  }
  return references;
}

function decodeHtmlAttribute(value) {
  return String(value || "")
    .replaceAll("&amp;", "&")
    .replaceAll("&quot;", '"')
    .replaceAll("&#039;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">");
}

function normalizedTitle(value) {
  return decodeHtmlAttribute(value).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

export function parseMyAnimeListSearchImages(html, aliases) {
  const expected = aliases.map(normalizedTitle).filter(Boolean);
  const matches = [];
  for (const match of String(html || "").matchAll(/<img\b[^>]*\balt="([^"]+)"[^>]*\bdata-src="(https:\/\/cdn\.myanimelist\.net\/[^\"]+)"[^>]*>/gi)) {
    const title = normalizedTitle(match[1]);
    if (!expected.some((alias) => title === alias || title.startsWith(`${alias} `))) continue;
    const url = decodeHtmlAttribute(match[2]);
    if (!url.startsWith("https://cdn.myanimelist.net/")) continue;
    matches.push(url.replace(/\/r\/\d+x\d+\//, "/"));
  }
  return [...new Set(matches)].slice(0, 5);
}

async function fetchMyAnimeListReferences(option, optionIndex, reader) {
  const aliases = normalizedAliases(option.text).slice(0, 4);
  const urls = new Set();
  for (const alias of aliases) {
    if (reader.expired()) break;
    const search = new URL(MYANIMELIST_SEARCH);
    search.searchParams.set("q", alias);
    search.searchParams.set("cat", "anime");
    const html = await reader.read(search, {
      headers: { "user-agent": REFERENCE_USER_AGENT, accept: "text/html" },
    }, "text");
    if (html === null) continue;
    for (const url of parseMyAnimeListSearchImages(html, aliases)) urls.add(url);
    if (urls.size >= 3) break;
  }

  const references = [];
  for (const url of [...urls].slice(0, 5)) {
    if (reader.expired()) break;
    const body = await reader.read(url, { headers: { "user-agent": REFERENCE_USER_AGENT } }, "arrayBuffer");
    if (!body) continue;
    const vector = await imageVector(Buffer.from(body)).catch(() => null);
    if (!vector) continue;
    references.push({ optionIndex, optionName: option.name, optionText: option.text, kind: "mal-cover", url, vector });
  }
  return references;
}

async function circleEdgeScore(input) {
  const { data, info } = await sharp(input).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const channels = info.channels;
  const pixel = (x, y) => {
    const offset = (y * info.width + x) * channels;
    return [data[offset], data[offset + 1], data[offset + 2]];
  };
  const colorDistance = (left, right) => (
    Math.abs(left[0] - right[0]) + Math.abs(left[1] - right[1]) + Math.abs(left[2] - right[2])
  );
  let best = 0;
  for (const radius of [20, 24, 28, 32, 36, 40, 44]) {
    const margin = radius + 4;
    for (let centerY = margin; centerY < info.height - margin; centerY += 4) {
      for (let centerX = margin; centerX < info.width - margin; centerX += 4) {
        const differences = [];
        for (let angleIndex = 0; angleIndex < 32; angleIndex += 1) {
          const angle = (Math.PI * 2 * angleIndex) / 32;
          const insideX = Math.round(centerX + Math.cos(angle) * (radius - 3));
          const insideY = Math.round(centerY + Math.sin(angle) * (radius - 3));
          const outsideX = Math.round(centerX + Math.cos(angle) * (radius + 3));
          const outsideY = Math.round(centerY + Math.sin(angle) * (radius + 3));
          differences.push(colorDistance(pixel(insideX, insideY), pixel(outsideX, outsideY)));
        }
        differences.sort((left, right) => left - right);
        const score = differences[8] * 0.6 + differences[16] * 0.4;
        best = Math.max(best, score);
      }
    }
  }
  return best;
}

export async function solveU2VisualChallenge(image, options, {
  fetchImpl = fetch,
  requestTimeoutMs = 8000,
  timeoutMs = 60000,
  referenceCache = new Map(),
  signal,
} = {}) {
  if (!Buffer.isBuffer(image) || !Array.isArray(options) || options.length < 2) {
    return { answer: null, failureCode: "u2_challenge_changed", reason: "U2 题目输入无效" };
  }
  const metadata = await sharp(image).metadata();
  const width = metadata.width ?? 0;
  const height = metadata.height ?? 0;
  if (width < 300 || height < 200) return { answer: null, failureCode: "u2_image_unavailable", reason: "U2 验证图片尺寸异常" };
  const contentHeight = Math.max(1, height - 33);

  const reader = createReferenceReader(fetchImpl, requestTimeoutMs, timeoutMs, signal);
  const workKey = option => JSON.stringify(normalizedAliases(option.text).sort());
  const rebind = (references, option, index) => references.map(reference => ({ ...reference,
    optionIndex: index, optionName: option.name, optionText: option.text }));
  const cachedReferences = async (option, index, source, read) => {
    const work = referenceCache.get("work:" + workKey(option));
    if (work) return source === "anilist" ? rebind(work, option, index) : [];
    const key = source + ":" + workKey(option);
    let cached = referenceCache.get(key);
    if (!cached) {
      cached = await read(option, index, reader);
      // Failed lookups are not cached: a later question may recover. Retain only
      // successful cover vectors, and rebind their option index on every use.
      if (cached.length) referenceCache.set(key, cached);
    }
    return rebind(cached, option, index);
  };
  let referenceGroups = await Promise.all(options.map((option, index) => cachedReferences(option, index, "anilist", fetchOptionReferences)));
  let references = referenceGroups.flat();
  if (new Set(references.map((item) => item.optionIndex)).size < 2) {
    referenceGroups = await Promise.all(options.map((option, index) => cachedReferences(option, index, "mal", fetchMyAnimeListReferences)));
    references.push(...referenceGroups.flat());
  }
  options.forEach((option, index) => {
    const available = references.filter(reference => reference.optionIndex === index);
    if (available.length) referenceCache.set("work:" + workKey(option), available);
  });
  const diagnostics = { ...reader.diagnostics, referenceDeadlineReached: reader.expired(),
    timedOut: reader.expired() || reader.diagnostics.timedOutRequests > 0,
    referenceCount: references.length,
    optionReferenceCounts: options.map((_, index) => references.filter(reference => reference.optionIndex === index).length) };
  if (new Set(references.map((item) => item.optionIndex)).size < 2) {
    return {
      answer: null,
      failureCode: reader.expired() || reader.diagnostics.timedOutRequests > 0 ? "u2_reference_timeout" : "u2_reference_unavailable",
      reason: reader.expired() ? "候选作品封面读取超时，未继续识别" : "AniList 与 MyAnimeList 均未返回足够的候选作品封面",
      diagnostics,
    };
  }

  const rows = [];
  for (let seam = Math.floor(width * 0.28); seam <= Math.ceil(width * 0.72); seam += 4) {
    signal?.throwIfAborted();
    const leftBuffer = await sharp(image).extract({ left: 0, top: 0, width: seam, height: contentHeight }).toBuffer();
    const rightBuffer = await sharp(image).extract({ left: seam, top: 0, width: width - seam, height: contentHeight }).toBuffer();
    const [leftVector, rightVector] = await Promise.all([imageVector(leftBuffer), imageVector(rightBuffer)]);
    const leftScores = references.map((reference) => ({ reference, distance: vectorDistance(leftVector, reference.vector) }));
    const rightScores = references.map((reference) => ({ reference, distance: vectorDistance(rightVector, reference.vector) }));
    for (const left of leftScores) {
      for (const right of rightScores) {
        if (left.reference.optionIndex === right.reference.optionIndex) continue;
        rows.push({ seam, left, right, total: left.distance + right.distance });
      }
    }
  }
  rows.sort((left, right) => left.total - right.total);
  const best = rows[0];
  const alternative = best && rows.find((row) => (
    row.left.reference.optionIndex !== best.left.reference.optionIndex
    || row.right.reference.optionIndex !== best.right.reference.optionIndex
  ));
  if (best) diagnostics.bestTotal = best.total;
  if (alternative) { diagnostics.alternativeTotal = alternative.total; diagnostics.matchGap = alternative.total - best.total; }
  if (!best || (alternative && alternative.total - best.total < 0.01)) {
    return {
      answer: null,
      failureCode: "u2_visual_ambiguous",
      reason: "候选作品封面匹配不够明确",
      diagnostics: { ...diagnostics, subreason: best ? "u2_match_gap_insufficient" : "u2_no_best_match" },
    };
  }

  const leftBuffer = await sharp(image).extract({ left: 0, top: 0, width: best.seam, height: contentHeight }).toBuffer();
  const rightBuffer = await sharp(image).extract({ left: best.seam, top: 0, width: width - best.seam, height: contentHeight }).toBuffer();
  const [leftCircle, rightCircle] = await Promise.all([circleEdgeScore(leftBuffer), circleEdgeScore(rightBuffer)]);
  const distanceRatio = Math.max(best.left.distance, best.right.distance) / Math.max(0.001, Math.min(best.left.distance, best.right.distance));
  const circleRatio = Math.max(leftCircle, rightCircle) / Math.max(1, Math.min(leftCircle, rightCircle));
  Object.assign(diagnostics, { distanceRatio, circleRatio });
  let dottedSide = null;
  if (distanceRatio >= 1.22) dottedSide = best.left.distance > best.right.distance ? "left" : "right";
  else if (circleRatio >= 1.3) dottedSide = leftCircle > rightCircle ? "left" : "right";
  if (!dottedSide) return { answer: null, failureCode: "u2_visual_ambiguous", reason: "无法可靠确定圆点位于哪一侧",
    diagnostics: { ...diagnostics, subreason: "u2_dot_side_unclear" } };

  const chosen = dottedSide === "left" ? best.left.reference : best.right.reference;
  return {
    answer: options[chosen.optionIndex],
    reason: "已通过封面匹配与圆形边缘检测确定答案",
    diagnostics: {
      ...diagnostics,
      subreason: "u2_answer_reliable",
      seam: best.seam,
      leftDistance: best.left.distance,
      rightDistance: best.right.distance,
      leftCircle,
      rightCircle,
      dottedSide,
    },
  };
}
