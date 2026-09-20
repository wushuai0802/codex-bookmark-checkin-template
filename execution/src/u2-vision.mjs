import sharp from "sharp";

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

async function fetchOptionReferences(option, optionIndex) {
  const media = new Map();
  for (const alias of normalizedAliases(option.text).slice(0, 4)) {
    const response = await fetch(ANILIST_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json", "user-agent": REFERENCE_USER_AGENT },
      body: JSON.stringify({ query: ANILIST_QUERY, variables: { search: alias } }),
    }).catch(() => null);
    if (!response?.ok) continue;
    const body = await response.json().catch(() => null);
    for (const item of body?.data?.Page?.media ?? []) media.set(item.id, item);
    if (media.size >= 2) break;
  }

  const references = [];
  for (const item of [...media.values()].slice(0, 5)) {
    for (const [kind, url] of [["cover", item.coverImage?.extraLarge || item.coverImage?.large], ["banner", item.bannerImage]]) {
      if (!url) continue;
      const response = await fetch(url).catch(() => null);
      if (!response?.ok) continue;
      const buffer = Buffer.from(await response.arrayBuffer());
      references.push({
        optionIndex,
        optionName: option.name,
        optionText: option.text,
        mediaId: item.id,
        kind,
        url,
        vector: await imageVector(buffer),
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

async function fetchMyAnimeListReferences(option, optionIndex) {
  const aliases = normalizedAliases(option.text).slice(0, 4);
  const urls = new Set();
  for (const alias of aliases) {
    const search = new URL(MYANIMELIST_SEARCH);
    search.searchParams.set("q", alias);
    search.searchParams.set("cat", "anime");
    const response = await fetch(search, {
      headers: { "user-agent": REFERENCE_USER_AGENT, accept: "text/html" },
    }).catch(() => null);
    if (!response?.ok) continue;
    for (const url of parseMyAnimeListSearchImages(await response.text(), aliases)) urls.add(url);
    if (urls.size >= 3) break;
  }

  const references = [];
  for (const url of [...urls].slice(0, 5)) {
    const response = await fetch(url, { headers: { "user-agent": REFERENCE_USER_AGENT } }).catch(() => null);
    if (!response?.ok) continue;
    const buffer = Buffer.from(await response.arrayBuffer());
    references.push({ optionIndex, optionName: option.name, optionText: option.text, kind: "mal-cover", url, vector: await imageVector(buffer) });
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

export async function solveU2VisualChallenge(image, options) {
  if (!Buffer.isBuffer(image) || !Array.isArray(options) || options.length < 2) {
    return { answer: null, reason: "U2 题目输入无效" };
  }
  const metadata = await sharp(image).metadata();
  const width = metadata.width ?? 0;
  const height = metadata.height ?? 0;
  if (width < 300 || height < 200) return { answer: null, reason: "U2 验证图片尺寸异常" };
  const contentHeight = Math.max(1, height - 33);

  let referenceGroups = await Promise.all(options.map(fetchOptionReferences));
  let references = referenceGroups.flat();
  if (new Set(references.map((item) => item.optionIndex)).size < 2) {
    referenceGroups = await Promise.all(options.map(fetchMyAnimeListReferences));
    references = referenceGroups.flat();
  }
  if (new Set(references.map((item) => item.optionIndex)).size < 2) {
    return { answer: null, reason: "AniList 与 MyAnimeList 均未返回足够的候选作品封面" };
  }

  const rows = [];
  for (let seam = Math.floor(width * 0.28); seam <= Math.ceil(width * 0.72); seam += 4) {
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
  const alternative = rows.find((row) => (
    row.left.reference.optionIndex !== best.left.reference.optionIndex
    || row.right.reference.optionIndex !== best.right.reference.optionIndex
  ));
  if (!best || (alternative && alternative.total - best.total < 0.01)) {
    return {
      answer: null,
      reason: "候选作品封面匹配不够明确",
      diagnostics: best ? {
        best: {
          seam: best.seam,
          left: best.left.reference.optionText,
          right: best.right.reference.optionText,
          total: best.total,
        },
        alternative: alternative ? {
          seam: alternative.seam,
          left: alternative.left.reference.optionText,
          right: alternative.right.reference.optionText,
          total: alternative.total,
        } : null,
      } : null,
    };
  }

  const leftBuffer = await sharp(image).extract({ left: 0, top: 0, width: best.seam, height: contentHeight }).toBuffer();
  const rightBuffer = await sharp(image).extract({ left: best.seam, top: 0, width: width - best.seam, height: contentHeight }).toBuffer();
  const [leftCircle, rightCircle] = await Promise.all([circleEdgeScore(leftBuffer), circleEdgeScore(rightBuffer)]);
  const distanceRatio = Math.max(best.left.distance, best.right.distance) / Math.max(0.001, Math.min(best.left.distance, best.right.distance));
  const circleRatio = Math.max(leftCircle, rightCircle) / Math.max(1, Math.min(leftCircle, rightCircle));
  let dottedSide = null;
  if (distanceRatio >= 1.22) dottedSide = best.left.distance > best.right.distance ? "left" : "right";
  else if (circleRatio >= 1.3) dottedSide = leftCircle > rightCircle ? "left" : "right";
  if (!dottedSide) return { answer: null, reason: "无法可靠确定圆点位于哪一侧" };

  const chosen = dottedSide === "left" ? best.left.reference : best.right.reference;
  return {
    answer: options[chosen.optionIndex],
    reason: "已通过封面匹配与圆形边缘检测确定答案",
    diagnostics: {
      seam: best.seam,
      leftOption: best.left.reference.optionText,
      rightOption: best.right.reference.optionText,
      leftDistance: best.left.distance,
      rightDistance: best.right.distance,
      leftCircle,
      rightCircle,
      dottedSide,
    },
  };
}
