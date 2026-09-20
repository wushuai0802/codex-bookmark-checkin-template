import { createRequire } from "node:module";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import process from "node:process";

const require = createRequire(import.meta.url);

// classic-level 不是本项目依赖，它随 Codex 的 chrome 插件分发。
// 按「环境变量 -> 本地 node_modules -> 插件缓存(取最新版本)」的顺序解析，避免硬编码机器路径。
function resolveClassicLevel() {
  const candidates = [];
  if (process.env.CLASSIC_LEVEL_PATH) candidates.push(process.env.CLASSIC_LEVEL_PATH);
  candidates.push("classic-level");

  const home = process.env.USERPROFILE || process.env.HOME;
  if (home) {
    const pluginRoot = path.join(home, ".codex", "plugins", "cache", "openai-bundled", "chrome");
    let versions = [];
    try {
      versions = fsSync.readdirSync(pluginRoot, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort()
        .reverse();
    } catch {}
    for (const version of versions) {
      candidates.push(path.join(pluginRoot, version, "scripts", "node_modules", "classic-level"));
    }
  }

  const errors = [];
  for (const candidate of candidates) {
    try {
      return require(candidate);
    } catch (error) {
      errors.push(candidate + " -> " + error.code);
    }
  }
  throw new Error(
    "\u672a\u627e\u5230 classic-level \u6a21\u5757\uff0c\u8bf7\u8bbe\u7f6e CLASSIC_LEVEL_PATH \u73af\u5883\u53d8\u91cf\u3002\u5df2\u5c1d\u8bd5: " + errors.join("; ")
  );
}

const { ClassicLevel } = resolveClassicLevel();

const [databasePath, requestedOrigin, outputPath] = process.argv.slice(2);
if (!databasePath || !requestedOrigin || !outputPath) {
  throw new Error("usage: Extract-ChromeSessionStorage.mjs <session-storage-db> <origin> <output>");
}
const origin = new URL(requestedOrigin).origin;

function decodeDomString(buffer) {
  if (!Buffer.isBuffer(buffer)) buffer = Buffer.from(buffer);
  if (buffer.length === 0) return "";
  if (buffer[0] === 0) return buffer.subarray(1).toString("utf16le");
  if (buffer[0] === 1) return buffer.subarray(1).toString("utf8");
  return buffer.toString("utf8");
}

function decodeMapId(buffer) {
  if (!Buffer.isBuffer(buffer)) buffer = Buffer.from(buffer);
  const plain = buffer.toString("utf8");
  if (/^\d+$/.test(plain)) return plain;
  let value = 0;
  let shift = 0;
  for (const byte of buffer) {
    value |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return String(value);
    shift += 7;
    if (shift > 28) break;
  }
  return "";
}

const database = new ClassicLevel(databasePath, { keyEncoding: "buffer", valueEncoding: "buffer" });
const rows = [];
try {
  await database.open();
  for await (const [key, value] of database.iterator()) rows.push([Buffer.from(key), Buffer.from(value)]);
} finally {
  await database.close().catch(() => {});
}

const namespaceRows = rows.filter(([key]) => key.toString("utf8").includes(origin));
const mapIds = new Set(namespaceRows.map(([, value]) => decodeMapId(value)).filter(Boolean));
const entries = new Map();
for (const [key, value] of rows) {
  const keyText = key.toString("utf8");
  for (const mapId of mapIds) {
    const prefix = `map-${mapId}-`;
    if (!keyText.startsWith(prefix)) continue;
    const storageKey = decodeDomString(key.subarray(Buffer.byteLength(prefix)));
    if (storageKey) entries.set(storageKey, decodeDomString(value));
  }
}

await fs.mkdir(path.dirname(outputPath), { recursive: true });
const current = await fs.readFile(outputPath, "utf8").then(JSON.parse).catch(() => null);
const temporary = `${outputPath}.${process.pid}.tmp`;
await fs.writeFile(temporary, `${JSON.stringify({
  version: 1,
  origin,
  capturedAt: new Date().toISOString(),
  local: Array.isArray(current?.local) ? current.local : [],
  session: [...entries.entries()],
}, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
await fs.rename(temporary, outputPath);
process.stdout.write(JSON.stringify({
  namespaceCount: namespaceRows.length,
  mapCount: mapIds.size,
  mapIds: [...mapIds],
  entryCount: entries.size,
  keyNames: [...entries.keys()],
  matchingKeySamples: namespaceRows.slice(0, 10).map(([key, value]) => ({
    key: key.toString("utf8").replace(/[\u0000-\u001f\u007f]/g, "?"),
    keyLength: key.length,
    valueLength: value.length,
  })),
  structuralKeySamples: rows
    .map(([key]) => key.toString("utf8"))
    .filter((key) => /namespace|map-/i.test(key))
    .slice(0, 30)
    .map((key) => key.replace(/[\u0000-\u001f\u007f]/g, "?")),
}));
