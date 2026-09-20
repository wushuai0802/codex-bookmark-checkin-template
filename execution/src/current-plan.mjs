import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readBookmarkPlanWithBackup } from "./bookmarks.mjs";
import { accountMetadataForOrigin, planFingerprint, resultIdentity } from "./result-identity.mjs";
import { configuredSupplementalOAuthAccounts } from "./supplemental-oauth-accounts.mjs";

const rootDirectory = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const config = JSON.parse(await fs.readFile(path.join(rootDirectory, "config", "config.json"), "utf8"));
const plan = await readBookmarkPlanWithBackup(config.bookmarksPath, config);
const targets = [
  ...plan.targets.map((target) => ({ ...target, ...accountMetadataForOrigin(target.origin, config) })),
  ...configuredSupplementalOAuthAccounts(config, rootDirectory),
];
const identities = targets.map(resultIdentity).sort();
if (new Set(identities).size !== identities.length) throw new Error("当前签到计划包含重复身份");
console.log(JSON.stringify({ targetCount: targets.length, identities, planFingerprint: planFingerprint(targets) }));
