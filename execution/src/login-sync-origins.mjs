import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readBookmarkPlanWithBackup } from "./bookmarks.mjs";

const sourceDirectory = path.dirname(fileURLToPath(import.meta.url));
const rootDirectory = path.dirname(sourceDirectory);
const config = JSON.parse(await fs.readFile(path.join(rootDirectory, "config", "config.json"), "utf8"));
const origins = new Set(config.syncSavedLoginOrigins ?? []);

if (config.syncBookmarkSavedLogins !== false) {
  const plan = await readBookmarkPlanWithBackup(config.bookmarksPath, config);
  for (const target of plan.targets) {
    origins.add(target.origin);
    for (const allowedOrigin of target.allowedOrigins ?? []) origins.add(allowedOrigin);
  }
}

process.stdout.write(JSON.stringify([...origins].sort()));
