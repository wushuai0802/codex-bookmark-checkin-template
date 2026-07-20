import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { listBookmarkFolderCandidates, readBookmarkPlan } from "../src/bookmarks.mjs";

test("不预设名称时列出候选书签目录供用户选择", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "checkin-candidates-"));
  const file = path.join(directory, "Bookmarks");
  await fs.writeFile(file, JSON.stringify({
    roots: {
      custom: {
        id: "1", type: "folder", name: "我的自动任务", children: [{
          id: "2", type: "folder", name: "每日领取", children: [
            { id: "3", type: "url", name: "示例", url: "https://example.test/daily" },
          ],
        }],
      },
    },
  }));
  const candidates = await listBookmarkFolderCandidates(file);
  const container = candidates.find((value) => value.name === "我的自动任务");
  assert.ok(container);
  assert.equal(container.descendantUrlCount, 1);
  assert.deepEqual(container.childFolders, [{ name: "每日领取", urlCount: 1 }]);
});

test("合并两个移动设备书签并按来源与站点去重", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "checkin-bookmarks-"));
  const file = path.join(directory, "Bookmarks");
  const fixture = {
    roots: {
      bookmark_bar: {
        id: "1", type: "folder", name: "书签栏", children: [{
          id: "10", type: "folder", name: "移动设备书签", children: [{
            id: "11", type: "folder", name: "签到", children: [
              { id: "12", type: "url", name: "A", url: "https://a.example/attendance.php" },
              { id: "13", type: "url", name: "B 控制台", url: "https://b.example/console" },
            ],
          }],
        }],
      },
      synced: {
        id: "3", type: "folder", name: "移动设备书签", children: [{
          id: "20", type: "folder", name: "公益站", children: [
            { id: "21", type: "url", name: "B 首页", url: "https://b.example/dashboard/overview" },
            { id: "22", type: "url", name: "C", url: "https://c.example/checkin" },
          ],
        }],
      },
    },
  };
  await fs.writeFile(file, JSON.stringify(fixture));
  const plan = await readBookmarkPlan(file, {
    mobileFolderNames: ["移动设备书签"],
    targetFolderNames: ["签到", "公益站"],
  });

  assert.equal(plan.sources.length, 2);
  assert.equal(plan.exactUrlCount, 4);
  assert.equal(plan.targetCount, 3);
  assert.equal(plan.comparison["签到"].unionUrlCount, 2);
  assert.equal(plan.comparison["公益站"].unionUrlCount, 2);
  const bTarget = plan.targets.find((target) => target.origin === "https://b.example");
  assert.deepEqual(bTarget.candidates, ["https://b.example/dashboard/overview", "https://b.example/console"]);
  assert.deepEqual(bTarget.allowedOrigins, ["https://b.example"]);
});

test("仅从显式配置加入关联签到入口", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "checkin-related-"));
  const file = path.join(directory, "Bookmarks");
  await fs.writeFile(file, JSON.stringify({
    roots: {
      synced: {
        id: "1", type: "folder", name: "移动设备书签", children: [{
          id: "2", type: "folder", name: "公益站", children: [
            { id: "3", type: "url", name: "旧入口", url: "https://old.example/console" },
          ],
        }],
      },
    },
  }));
  const plan = await readBookmarkPlan(file, {
    mobileFolderNames: ["移动设备书签"],
    targetFolderNames: ["公益站"],
    relatedCandidateUrls: { "https://old.example": ["https://new.example/"] },
  });
  assert.deepEqual(plan.targets[0].candidates, ["https://old.example/console", "https://new.example/"]);
  assert.deepEqual(plan.targets[0].allowedOrigins, ["https://old.example", "https://new.example"]);
});
