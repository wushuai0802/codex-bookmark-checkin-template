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
      user_defined_dpi: "300",
    });
    const lineResult = await worker.recognize(processed, {}, { text: true, box: true });
    const lineCode = String(lineResult.data.text || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
    // Colored interference can make SINGLE_LINE split a glyph into several
    // characters. SINGLE_WORD preserves the six fixed-width glyphs, so use it
    // whenever it returns an exact six-character candidate.
    await worker.setParameters({ tessedit_pageseg_mode: PSM.SINGLE_WORD });
    const wordResult = await worker.recognize(processed, {}, { text: true, box: true });
    const wordCode = String(wordResult.data.text || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
    const wholeCode = wordCode.length === 6 ? wordCode : lineCode;
    const wholeResult = wordCode.length === 6 ? wordResult : lineResult;
    const glyphs = prepared.components
      .filter((component) => component.height >= prepared.height * 0.22 && component.width >= 2)
      .sort((left, right) => left.minX - right.minX);
    if (wholeCode.length === 6 && Number(wholeResult.data.confidence) >= 55) {
      return {
        code: correctCaptchaConfusions(wholeCode, glyphs),
        rawCode: wholeCode,
        glyphs: glyphs.map((glyph) => ({
          width: glyph.width,
          height: glyph.height,
          leftStemCoverage: Math.max(...glyph.columnInk.slice(0, Math.min(2, glyph.columnInk.length))) / glyph.height,
        })),
        confidence: wholeResult.data.confidence,
        processed,
      };
    }
    if (glyphs.length === 6) {
      const recognizedBoxes = String(lineResult.data.box || "").split(/\r?\n/).map((line) => {
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
      if (Number(lineResult.data.confidence) >= 55 && boxMapped.every((mapping) => mapping?.overlap >= 3)) {
        const mappedCode = boxMapped.map((mapping) => mapping.item.character).join("");
        return {
          code: correctCaptchaConfusions(mappedCode, glyphs),
           confidence: wholeResult.data.confidence,
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
         if (character.length !== 1) {
          return { code: null, rawCode: wholeCode, confidence: wholeResult.data.confidence, processed };
        }
        characters.push(character);
        confidences.push(characterResult.data.confidence);
      }
      const characterCode = characters.join("");
      return {
        code: correctCaptchaConfusions(characterCode, glyphs),
        rawCode: characterCode,
        confidence: confidences.reduce((sum, value) => sum + value, 0) / confidences.length,
        processed,
      };
    }
    return { code: null, rawCode: wholeCode, confidence: wholeResult.data.confidence, processed };
  } finally {
    await worker.terminate();
  }
}

const NEXUS_CAPTCHA_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const NEXUS_CAPTCHA_SLOTS = 6;

function parseTesseractBoxes(boxText, scale, padding) {
  return String(boxText || "").split(/\r?\n/).map((line) => {
    const match = line.match(/^([A-Z0-9])\s+(\d+)\s+\d+\s+(\d+)\s+\d+/i);
    if (!match) return null;
    return {
      character: match[1].toUpperCase(),
      left: (Number(match[2]) - padding) / scale,
      right: (Number(match[3]) - padding) / scale,
    };
  }).filter(Boolean);
}

function mapNexusBoxesToSlots(boxes, centers) {
  return centers.map((center) => boxes.map((box) => ({
    box,
    distance: Math.abs((box.left + box.right) / 2 - center),
    overlap: Math.max(0, Math.min(box.right, center + 8) - Math.max(box.left, center - 8)),
  }))
    .filter((candidate) => candidate.distance <= 13 || candidate.overlap >= 3)
    .sort((left, right) => left.distance - right.distance || right.overlap - left.overlap)[0]?.box.character ?? null);
}

function nexusGlyphMetrics(data, width, height, center) {
  const left = Math.max(0, Math.round(center) - 9);
  const right = Math.min(width - 1, Math.round(center) + 9);
  const top = Math.max(0, Math.round(height * 0.2));
  const bottom = Math.min(height - 1, Math.round(height * 0.84));
  const localWidth = right - left + 1;
  const localHeight = bottom - top + 1;
  const binary = new Uint8Array(localWidth * localHeight);
  for (let y = top; y <= bottom; y += 1) {
    for (let x = left; x <= right; x += 1) {
      const offset = (y * width + x) * 3;
      binary[(y - top) * localWidth + (x - left)] = Math.max(
        data[offset], data[offset + 1], data[offset + 2],
      ) < 110 ? 1 : 0;
    }
  }

  const visited = new Uint8Array(binary.length);
  const components = [];
  const queue = new Int32Array(binary.length);
  for (let start = 0; start < binary.length; start += 1) {
    if (!binary[start] || visited[start]) continue;
    let head = 0;
    let tail = 0;
    queue[tail++] = start;
    visited[start] = 1;
    let size = 0;
    let minX = localWidth;
    let maxX = 0;
    let minY = localHeight;
    let maxY = 0;
    while (head < tail) {
      const point = queue[head++];
      size += 1;
      const x = point % localWidth;
      const y = Math.floor(point / localWidth);
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          if (dx === 0 && dy === 0) continue;
          const nextX = x + dx;
          const nextY = y + dy;
          if (nextX < 0 || nextX >= localWidth || nextY < 0 || nextY >= localHeight) continue;
          const next = nextY * localWidth + nextX;
          if (!binary[next] || visited[next]) continue;
          visited[next] = 1;
          queue[tail++] = next;
        }
      }
    }
    components.push({ size, minX, maxX, minY, maxY });
  }
  const glyph = components
    .filter((component) => component.size >= 12 && component.maxY - component.minY + 1 >= 7)
    .sort((leftComponent, rightComponent) => rightComponent.size - leftComponent.size)[0];
  if (!glyph) return null;
  let upperRightInk = 0;
  let middleCenterInk = 0;
  const glyphWidth = glyph.maxX - glyph.minX + 1;
  const glyphHeight = glyph.maxY - glyph.minY + 1;
  const upperStart = glyph.minY + Math.max(1, Math.floor(glyphHeight * 0.2));
  const upperEnd = glyph.minY + Math.max(1, Math.floor(glyphHeight * 0.4));
  const rightStart = glyph.maxX - Math.max(1, Math.floor(glyphWidth * 0.25)) + 1;
  for (let y = upperStart; y <= upperEnd; y += 1) {
    for (let x = rightStart; x <= glyph.maxX; x += 1) {
      upperRightInk += binary[y * localWidth + x];
    }
  }
  const middleStart = glyph.minY + Math.max(1, Math.floor(glyphHeight * 0.35));
  const middleEnd = glyph.minY + Math.max(1, Math.floor(glyphHeight * 0.65));
  const centerStart = glyph.minX + Math.max(1, Math.floor(glyphWidth * 0.3));
  const centerEnd = glyph.minX + Math.max(1, Math.floor(glyphWidth * 0.7));
  for (let y = middleStart; y <= middleEnd; y += 1) {
    for (let x = centerStart; x <= centerEnd; x += 1) {
      middleCenterInk += binary[y * localWidth + x];
    }
  }
  return {
    width: glyphWidth,
    height: glyphHeight,
    size: glyph.size,
    upperRightInk,
    middleCenterInk,
  };
}

export function correctNexusCaptchaConfusions(code, glyphs) {
  if (!/^[A-Z0-9]{6}$/.test(String(code || "")) || glyphs.length !== NEXUS_CAPTCHA_SLOTS) return code;
  const characters = [...code];
  for (let index = 0; index < characters.length; index += 1) {
    const glyph = glyphs[index];
    if (!glyph) continue;
    // Digit 6 closes its loop through the centre; G keeps that area open and
    // draws the horizontal stroke at the right. This survives nearby noise
    // better than relying on the glyph's outer width.
    if (characters[index] === "6" && glyph.middleCenterInk <= 1) characters[index] = "G";
    else if (characters[index] === "G" && glyph.middleCenterInk >= 3) characters[index] = "6";
  }
  return characters.join("");
}

/**
 * NexusPHP's legacy CAPTCHA uses six fixed-width glyphs over coloured noise.
 * Whole-image OCR is run over several dark-pixel projections, then boxes are
 * assigned to fixed slots. This avoids treating the decorative lines and
 * shapes as extra characters while keeping the request count bounded.
 */
export async function recognizeNexusCaptcha(input) {
  const source = sharp(input).removeAlpha();
  const metadata = await source.metadata();
  const border = Math.min(2, Math.max(0, Math.floor(Math.min(metadata.width ?? 1, metadata.height ?? 1) / 10)));
  const width = Math.max(1, (metadata.width ?? 1) - border * 2);
  const height = Math.max(1, (metadata.height ?? 1) - border * 2);
  const { data, info } = await source.extract({ left: border, top: border, width, height })
    .raw()
    .toBuffer({ resolveWithObject: true });
  const originalWidth = info.width + border * 2;
  const centers = Array.from({ length: NEXUS_CAPTCHA_SLOTS }, (_, index) => (
    originalWidth * (0.2 + index * 0.12) - border
  ));
  const votes = centers.map(() => new Map());
  const scale = 6;
  const padding = 40;
  const variants = [
    ...Array.from({ length: 8 }, (_, index) => ({ kind: "max", threshold: 70 + index * 10 })),
    ...Array.from({ length: 7 }, (_, index) => ({ kind: "luma", threshold: 60 + index * 10 })),
  ];
  const worker = await createWorker("eng", 1, { logger: () => {} });
  try {
    await worker.setParameters({
      tessedit_char_whitelist: NEXUS_CAPTCHA_ALPHABET,
      tessedit_pageseg_mode: PSM.SINGLE_LINE,
      user_defined_dpi: "300",
    });
    for (const variant of variants) {
      const raw = Buffer.alloc(info.width * info.height, 255);
      for (let pixel = 0; pixel < raw.length; pixel += 1) {
        const offset = pixel * 3;
        const red = data[offset];
        const green = data[offset + 1];
        const blue = data[offset + 2];
        const value = variant.kind === "max"
          ? Math.max(red, green, blue)
          : 0.299 * red + 0.587 * green + 0.114 * blue;
        if (value < variant.threshold) raw[pixel] = 0;
      }
      const image = await sharp(raw, { raw: { width: info.width, height: info.height, channels: 1 } })
        .resize({ width: info.width * scale, height: info.height * scale, kernel: "nearest" })
        .extend({ top: padding, bottom: padding, left: padding, right: padding, background: "white" })
        .png()
        .toBuffer();
      const result = await worker.recognize(image, {}, { text: true, box: true });
      const mapped = mapNexusBoxesToSlots(parseTesseractBoxes(result.data.box, scale, padding), centers);
      const weight = 1 + Math.max(0, Math.min(80, Number(result.data.confidence) || 0)) / 80;
      mapped.forEach((character, slot) => {
        if (!character || !NEXUS_CAPTCHA_ALPHABET.includes(character)) return;
        votes[slot].set(character, (votes[slot].get(character) || 0) + weight);
      });
    }
  } finally {
    await worker.terminate();
  }

  const ranked = votes.map((row) => [...row.entries()]
    .sort((left, right) => right[1] - left[1])
    .map(([character, score]) => ({ character, score })));
  if (ranked.some((row) => row.length === 0)) {
    return { code: null, confidence: 0, margin: 0, candidates: ranked.map((row) => row.slice(0, 3)) };
  }
  const glyphs = centers.map((center) => nexusGlyphMetrics(data, info.width, info.height, center));
  const rawCode = ranked.map((row) => row[0].character).join("");
  const code = correctNexusCaptchaConfusions(rawCode, glyphs);
  const ratios = ranked.map((row) => row[0].score / Math.max(row.reduce((sum, item) => sum + item.score, 0), 0.001));
  const margins = ranked.map((row) => row[0].score / Math.max(row[1]?.score ?? 0.001, 0.001));
  return {
    code,
    rawCode,
    confidence: Math.round(Math.min(...ratios) * 100),
    margin: Math.min(...margins),
    candidates: ranked.map((row) => row.slice(0, 3)),
    glyphs,
  };
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
