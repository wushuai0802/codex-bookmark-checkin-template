import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readBookmarkPlanWithBackup } from "./bookmarks.mjs";
import { isTerminalResult } from "./result-contract.mjs";

const sourceDirectory = path.dirname(fileURLToPath(import.meta.url));
const rootDirectory = path.dirname(sourceDirectory);
const config = JSON.parse(await fs.readFile(path.join(rootDirectory, "config", "config.json"), "utf8"));
const latest = JSON.parse(await fs.readFile(path.join(rootDirectory, "logs", "latest.json"), "utf8"));
const plan = await readBookmarkPlanWithBackup(config.bookmarksPath, config);

const items = [];
for (const result of latest.results) {
  if (isTerminalResult(result)) continue;
  const target = plan.targets.find((candidate) => candidate.origin === result.origin);
  if (!target?.candidates?.length) continue;
  items.push({ origin: result.origin, url: target.candidates[0], status: result.status });
}

const preferred = config.attentionPreferredOrigins ?? [];
items.sort((left, right) => {
  const leftIndex = preferred.indexOf(left.origin);
  const rightIndex = preferred.indexOf(right.origin);
  if (leftIndex >= 0 || rightIndex >= 0) return (leftIndex < 0 ? 99 : leftIndex) - (rightIndex < 0 ? 99 : rightIndex);
  return left.origin.localeCompare(right.origin);
});

process.stdout.write(JSON.stringify(items));
