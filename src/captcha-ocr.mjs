import fs from "node:fs/promises";
import sharp from "sharp";
import { createWorker, PSM } from "tesseract.js";

function removeNoise(data, width, height) {
  const binary = new Uint8Array(width * height);
  for (let index = 0; index < binary.length; index += 1) {
    const offset = index * 3;
    const red = data[offset];
    const green = data[offset + 1];
    const blue = data[offset + 2];
    binary[index] = Math.max(red, green, blue) < 125 ? 1 : 0;
  }

  const visited = new Uint8Array(binary.length);
  const output = Buffer.alloc(binary.length, 255);
  const keptComponents = [];
  const queue = new Int32Array(binary.length);
  for (let start = 0; start < binary.length; start += 1) {
    if (!binary[start] || visited[start]) continue;
    let head = 0;
    let tail = 0;
    queue[tail++] = start;
    visited[start] = 1;
    const component = [];
    let minX = width;
    let minY = height;
    let maxX = 0;
    let maxY = 0;
    while (head < tail) {
      const point = queue[head++];
      component.push(point);
      const x = point % width;
      const y = Math.floor(point / width);
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
      const neighbors = [point - 1, point + 1, point - width, point + width];
      for (const neighbor of neighbors) {
        if (neighbor < 0 || neighbor >= binary.length || visited[neighbor] || !binary[neighbor]) continue;
        const neighborX = neighbor % width;
        if (Math.abs(neighborX - x) > 1) continue;
        visited[neighbor] = 1;
        queue[tail++] = neighbor;
      }
    }
    const componentWidth = maxX - minX + 1;
    const componentHeight = maxY - minY + 1;
    const touchesBorder = minX === 0 || minY === 0 || maxX === width - 1 || maxY === height - 1;
    if (!touchesBorder && component.length >= 5 && componentHeight >= 3 && componentWidth >= 1) {
      for (const point of component) output[point] = 0;
      const rowInk = Array(componentHeight).fill(0);
      const columnInk = Array(componentWidth).fill(0);
      for (const point of component) {
        const x = point % width;
        const y = Math.floor(point / width);
        rowInk[y - minY] += 1;
        columnInk[x - minX] += 1;
      }
      keptComponents.push({
        minX, minY, maxX, maxY,
        width: componentWidth,
        height: componentHeight,
        size: component.length,
        rowInk,
        columnInk,
      });
    }
  }
  return { output, keptComponents };
}

export function correctCaptchaConfusions(rawCode, glyphs) {
  if (!/^[A-Z0-9]{6}$/.test(rawCode) || glyphs.length !== 6) return rawCode;
  const characters = [...rawCode];
  for (let index = 0; index < glyphs.length; index += 1) {
    const glyph = glyphs[index];
    const leftStemCoverage = Math.max(...glyph.columnInk.slice(0, Math.min(2, glyph.columnInk.length))) / glyph.height;

    // HDSky uses a fixed block font. Tesseract regularly reads its wide B/R
    // as E, while a real E in this font is at most eight source pixels wide.
    if (characters[index] === "E" && glyph.width >= 10) characters[index] = "R";
    else if (characters[index] === "E" && glyph.width === 9) characters[index] = "B";

    // The same font's D has a continuous left stem; zero has rounded top and
    // bottom edges, so its left-side coverage is lower.
    if (characters[index] === "0" && leftStemCoverage >= 0.95) characters[index] = "D";
  }
  return characters.join("");
}

async function prepareOpenCdCaptcha(input) {
  const source = sharp(input).removeAlpha();
  const metadata = await source.metadata();
  const left = Math.min(2, Math.max(0, (metadata.width ?? 1) - 1));
  const top = Math.min(2, Math.max(0, (metadata.height ?? 1) - 1));
  const width = Math.max(1, (metadata.width ?? 1) - left * 2);
  const height = Math.max(1, (metadata.height ?? 1) - top * 2);
  const { data, info } = await source
    .extract({ left, top, width, height })
    .raw()
    .toBuffer({ resolveWithObject: true });
  const cleaned = removeNoise(data, info.width, info.height);
  const processed = await sharp(cleaned.output, { raw: { width: info.width, height: info.height, channels: 1 } })
    .resize({ width: info.width * 6, height: info.height * 6, kernel: "nearest" })
    .png()
    .toBuffer();
  return { processed, components: cleaned.keptComponents, width: info.width, height: info.height, scale: 6 };
}

export async function preprocessOpenCdCaptcha(input) {
  return (await prepareOpenCdCaptcha(input)).processed;
}

export async function recognizeOpenCdCaptcha(input) {
  const prepared = await prepareOpenCdCaptcha(input);
  const { processed } = prepared;
  const worker = await createWorker("eng", 1, { logger: () => {} });
  try {
    await worker.setParameters({
      tessedit_char_whitelist: "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789",
      tessedit_pageseg_mode: PSM.SINGLE_LINE,
    });
    const result = await worker.recognize(processed, {}, { text: true, box: true });
    const wholeCode = String(result.data.text || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
    const glyphs = prepared.components
      .filter((component) => component.height >= prepared.height * 0.22 && component.width >= 2)
      .sort((left, right) => left.minX - right.minX);
    if (wholeCode.length === 6) {
      return {
        code: correctCaptchaConfusions(wholeCode, glyphs),
        rawCode: wholeCode,
        glyphs: glyphs.map((glyph) => ({
          width: glyph.width,
          height: glyph.height,
          leftStemCoverage: Math.max(...glyph.columnInk.slice(0, Math.min(2, glyph.columnInk.length))) / glyph.height,
        })),
        confidence: result.data.confidence,
        processed,
      };
    }
    if (glyphs.length === 6) {
      const recognizedBoxes = String(result.data.box || "").split(/\r?\n/).map((line) => {
        const match = line.match(/^([A-Z0-9])\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+\d+$/i);
        return match ? { character: match[1].toUpperCase(), left: Number(match[2]), right: Number(match[4]) } : null;
      }).filter(Boolean);
      const boxMapped = glyphs.map((glyph) => {
        const left = glyph.minX * prepared.scale;
        const right = (glyph.maxX + 1) * prepared.scale;
        return recognizedBoxes
          .map((item) => ({ item, overlap: Math.max(0, Math.min(right, item.right) - Math.max(left, item.left)) }))
          .sort((a, b) => b.overlap - a.overlap)[0];
      });
      if (boxMapped.every((mapping) => mapping?.overlap >= 3)) {
        const mappedCode = boxMapped.map((mapping) => mapping.item.character).join("");
        return {
          code: correctCaptchaConfusions(mappedCode, glyphs),
          confidence: result.data.confidence,
          processed,
        };
      }
      await worker.setParameters({
        tessedit_char_whitelist: "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789",
        tessedit_pageseg_mode: PSM.SINGLE_CHAR,
      });
      const characters = [];
      const confidences = [];
      for (const glyph of glyphs) {
        const padding = 2;
        const left = Math.max(0, glyph.minX - padding);
        const top = Math.max(0, glyph.minY - padding);
        const right = Math.min(prepared.width - 1, glyph.maxX + padding);
        const bottom = Math.min(prepared.height - 1, glyph.maxY + padding);
        const characterImage = await sharp(processed).extract({
          left: left * prepared.scale,
          top: top * prepared.scale,
          width: (right - left + 1) * prepared.scale,
          height: (bottom - top + 1) * prepared.scale,
        }).extend({ top: 24, bottom: 24, left: 24, right: 24, background: "white" }).png().toBuffer();
        const characterResult = await worker.recognize(characterImage);
        const character = String(characterResult.data.text || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
        if (character.length !== 1) return { code: wholeCode, confidence: result.data.confidence, processed };
        characters.push(character);
        confidences.push(characterResult.data.confidence);
      }
      const characterCode = characters.join("");
      return {
        code: correctCaptchaConfusions(characterCode, glyphs),
        confidence: confidences.reduce((sum, value) => sum + value, 0) / confidences.length,
        processed,
      };
    }
    return { code: wholeCode, confidence: result.data.confidence, processed };
  } finally {
    await worker.terminate();
  }
}

const NEW_API_CAPTCHA_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const NEW_API_CAPTCHA_CENTERS = [23, 49, 75, 100, 126];

function normalizeCaptchaCode(value) {
  return String(value || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function addCaptchaVote(votes, slot, character, weight) {
  if (slot < 0 || slot >= votes.length || !NEW_API_CAPTCHA_ALPHABET.includes(character)) return;
  const row = votes[slot];
  row.set(character, (row.get(character) || 0) + weight);
}

function rankCaptchaVotes(votes) {
  return votes.map((row) => [...row.entries()]
    .sort((left, right) => right[1] - left[1])
    .map(([character, score]) => ({ character, score })));
}

function mapTesseractBoxes(boxText, votes, scale = 8, leftPadding = 80) {
  for (const line of String(boxText || "").split(/\r?\n/)) {
    const match = line.match(/^([A-Z0-9])\s+(\d+)\s+\d+\s+(\d+)\s+\d+/i);
    if (!match) continue;
    const center = ((Number(match[2]) + Number(match[3])) / 2 - leftPadding) / scale;
    const slot = NEW_API_CAPTCHA_CENTERS
      .map((expected, index) => ({ index, distance: Math.abs(center - expected) }))
      .sort((left, right) => left.distance - right.distance)[0];
    if (slot && slot.distance <= 14) addCaptchaVote(votes, slot.index, match[1].toUpperCase(), 3);
  }
}

function bestCaptchaCode(votes) {
  const ranked = rankCaptchaVotes(votes);
  if (ranked.some((row) => row.length === 0)) return null;
  const selected = ranked.map((row) => row[0]);
  const weakest = Math.min(...selected.map((item) => item.score));
  const margins = selected.map((item, index) => item.score / Math.max(0.001, ranked[index][1]?.score || 0.001));
  const confidence = Math.min(100, Math.round((weakest / 12) * 100));
  const margin = Math.min(...margins);
  if (weakest < 2 || margin < 1.12) return null;
  return {
    code: selected.map((item) => item.character).join(""),
    confidence,
    margin,
    candidates: ranked.map((row) => row.slice(0, 4)),
  };
}

// Jianzhile and compatible New API deployments use a small five-character
// image CAPTCHA.  The characters are fixed-width and the interference lines
// are much lighter than the glyphs, so a few thresholded OCR passes are more
// reliable than sending the full colourful image to Tesseract once.  The
// caller treats a low-margin result as unresolved and requests a fresh image.
export async function recognizeNewApiCaptcha(input) {
  const source = sharp(input).resize({ width: 160, height: 58, kernel: "lanczos3" });
  const { data, info } = await source.clone().removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const worker = await createWorker("eng", 1, { logger: () => {} });
  const votes = Array.from({ length: 5 }, () => new Map());
  try {
    await worker.setParameters({
      tessedit_char_whitelist: NEW_API_CAPTCHA_ALPHABET,
      user_defined_dpi: "300",
    });

    for (const threshold of [120, 160]) {
      const y0 = 18;
      const y1 = 50;
      const raw = Buffer.alloc(info.width * (y1 - y0), 255);
      for (let y = y0; y < y1; y += 1) {
        for (let x = 10; x < 145; x += 1) {
          const offset = (y * info.width + x) * 3;
          if (Math.min(data[offset], data[offset + 1], data[offset + 2]) < threshold) {
            raw[(y - y0) * info.width + x] = 0;
          }
        }
      }
      const image = await sharp(raw, { raw: { width: info.width, height: y1 - y0, channels: 1 } })
        .resize({ width: info.width * 8, height: (y1 - y0) * 8, kernel: "nearest" })
        .extend({ top: 80, bottom: 80, left: 80, right: 80, background: "white" })
        .png()
        .toBuffer();
      for (const psm of [PSM.SINGLE_LINE, PSM.SINGLE_WORD]) {
        await worker.setParameters({ tessedit_pageseg_mode: psm });
        const result = await worker.recognize(image, {}, { text: true, box: true });
        mapTesseractBoxes(result.data.box, votes);
      }
    }

    // Isolated glyph passes recover cases where a noise line makes the full
    // OCR line shift by one character.  Keep the pass count bounded because
    // this runs inside the scheduled daily task.
    await worker.setParameters({ tessedit_pageseg_mode: PSM.SINGLE_CHAR });
    for (let slot = 0; slot < NEW_API_CAPTCHA_CENTERS.length; slot += 1) {
      for (const width of [18, 22]) {
        const left = Math.max(0, Math.round(NEW_API_CAPTCHA_CENTERS[slot] - width / 2));
        for (const threshold of [120, 160]) {
          const y0 = 18;
          const y1 = 50;
          const raw = Buffer.alloc(width * (y1 - y0), 255);
          for (let y = y0; y < y1; y += 1) {
            for (let x = left; x < left + width; x += 1) {
              const offset = (y * info.width + x) * 3;
              if (Math.min(data[offset], data[offset + 1], data[offset + 2]) < threshold) {
                raw[(y - y0) * width + (x - left)] = 0;
              }
            }
          }
          const image = await sharp(raw, { raw: { width, height: y1 - y0, channels: 1 } })
            .resize({ width: width * 16, height: (y1 - y0) * 16, kernel: "nearest" })
            .extend({ top: 80, bottom: 80, left: 80, right: 80, background: "white" })
            .png()
            .toBuffer();
          for (const psm of [PSM.SINGLE_CHAR, PSM.SINGLE_WORD]) {
            await worker.setParameters({ tessedit_pageseg_mode: psm });
            const result = await worker.recognize(image);
            const character = normalizeCaptchaCode(result.data.text);
            if (character.length === 1) {
              addCaptchaVote(votes, slot, character, 1 + Math.max(0, Number(result.data.confidence) || 0) / 20);
            }
          }
        }
      }
    }
  } finally {
    await worker.terminate();
  }
  return bestCaptchaCode(votes) ?? {
    code: null,
    confidence: 0,
    margin: 0,
    candidates: rankCaptchaVotes(votes).map((row) => row.slice(0, 4)),
  };
}

export const NEW_API_CAPTCHA_MAX_SUBMISSIONS = 6;

// Keep the Cartesian product deliberately small.  A New API CAPTCHA id is
// single-use after a wrong answer, so callers request a fresh challenge for
// every candidate and stop after the configured bounded attempts.
export function newApiCaptchaCandidates(recognition, limit = NEW_API_CAPTCHA_MAX_SUBMISSIONS) {
  const rows = recognition?.candidates;
  if (!Array.isArray(rows) || rows.length !== 5 || rows.some((row) => !Array.isArray(row) || row.length === 0)) return [];
  let candidates = [{ code: "", score: 0 }];
  for (const row of rows) {
    candidates = candidates.flatMap((prefix) => row.slice(0, 2).map((item) => ({
      code: `${prefix.code}${item.character}`,
      score: prefix.score + Number(item.score || 0),
    }))).sort((left, right) => right.score - left.score).slice(0, Math.max(1, limit));
  }
  return [...new Set(candidates.map((item) => item.code))].filter((code) => code.length === 5).slice(0, limit);
}

if (process.argv[1] && new URL(import.meta.url).pathname.replace(/^\/(?:[A-Za-z]:)/, (value) => value.slice(1)) === process.argv[1].replace(/\\/g, "/")) {
  const inputPath = process.argv[2];
  if (!inputPath) throw new Error("用法: node src/captcha-ocr.mjs <image>");
  const result = await recognizeOpenCdCaptcha(await fs.readFile(inputPath));
  console.log(JSON.stringify({ code: result.code, rawCode: result.rawCode, confidence: result.confidence, glyphs: result.glyphs }));
}
