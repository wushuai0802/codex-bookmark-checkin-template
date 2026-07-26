import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { findBookmarkTarget, listBookmarkFolderCandidates, listBookmarkFolderCandidatesWithBackup, readBookmarkPlan, readBookmarkPlanWithBackup } from "../src/bookmarks.mjs";

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

test("合并 Chrome 与 Edge 书签并跨浏览器去重", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "checkin-browser-sources-"));
  const chromeFile = path.join(directory, "ChromeBookmarks");
  const edgeFile = path.join(directory, "EdgeBookmarks");
  try {
    await fs.writeFile(chromeFile, JSON.stringify({
      roots: { synced: { id: "1", type: "folder", name: "我的自动任务", children: [{
        id: "2", type: "folder", name: "每日领取", children: [
          { id: "3", type: "url", name: "共同站点", url: "https://shared.example/checkin" },
        ],
      }] } },
    }));
    await fs.writeFile(edgeFile, JSON.stringify({
      roots: { synced: { id: "10", type: "folder", name: "Edge收藏", children: [{
        id: "11", type: "folder", name: "每日领取", children: [
          { id: "12", type: "url", name: "共同站点", url: "https://shared.example/checkin" },
          { id: "13", type: "url", name: "Edge 新站", url: "https://edge-only.example/console" },
        ],
      }] } },
    }));

    const plan = await readBookmarkPlan(chromeFile, {
      bookmarkSourceName: "Chrome",
      additionalBookmarkSources: [{
        name: "Edge",
        path: edgeFile,
        mobileFolderNames: ["Edge收藏"],
        targetFolderNames: ["每日领取"],
        optional: true,
      }],
      mobileFolderNames: ["我的自动任务"],
      targetFolderNames: ["每日领取"],
    });

    assert.equal(plan.bookmarkFiles.length, 2);
    assert.equal(plan.exactUrlCount, 2);
    assert.equal(plan.targetCount, 2);
    assert.ok(plan.sources.some((source) => source.path === "Chrome: 我的自动任务"));
    assert.ok(plan.sources.some((source) => source.path === "Edge: Edge收藏"));
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("可选 Edge 主文件损坏时独立回退到 Edge 备份", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "checkin-edge-backup-"));
  const chromeFile = path.join(directory, "ChromeBookmarks");
  const edgeFile = path.join(directory, "EdgeBookmarks");
  try {
    await fs.writeFile(chromeFile, JSON.stringify({
      roots: { synced: { id: "1", type: "folder", name: "我的自动任务", children: [{
        id: "2", type: "folder", name: "每日领取", children: [
          { id: "3", type: "url", name: "Chrome 站点", url: "https://chrome.example/checkin" },
        ],
      }] } },
    }));
    await fs.writeFile(edgeFile, "not-json");
    await fs.writeFile(`${edgeFile}.bak`, JSON.stringify({
      roots: { synced: { id: "10", type: "folder", name: "Edge收藏", children: [{
        id: "11", type: "folder", name: "每日领取", children: [
          { id: "12", type: "url", name: "Edge 站点", url: "https://edge.example/console" },
        ],
      }] } },
    }));

    const plan = await readBookmarkPlanWithBackup(chromeFile, {
      bookmarkSourceName: "Chrome",
      additionalBookmarkSources: [{
        name: "Edge",
        path: edgeFile,
        mobileFolderNames: ["Edge收藏"],
        targetFolderNames: ["每日领取"],
        optional: true,
      }],
      mobileFolderNames: ["我的自动任务"],
      targetFolderNames: ["每日领取"],
      minimumBookmarkTargetCount: 2,
    });

    assert.equal(plan.targetCount, 2);
    assert.equal(plan.recoveredFromBackup, true);
    assert.deepEqual(plan.recoveredSources, ["Edge"]);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
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

test("用户显式配置的站点在书签尚未落盘时仍会加入任务", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "checkin-configured-target-"));
  const file = path.join(directory, "Bookmarks");
  try {
    await fs.writeFile(file, JSON.stringify({
      roots: { synced: { id: "3", type: "folder", name: "我的自动任务", children: [] } },
    }));
    const plan = await readBookmarkPlan(file, {
      mobileFolderNames: ["我的自动任务"],
      targetFolderNames: ["每日领取"],
      configuredTargets: [{
        title: "Configured service",
        url: "https://configured.example/console",
        folderName: "每日领取",
      }],
    });
    assert.equal(plan.targetCount, 1);
    assert.equal(plan.targets[0].origin, "https://configured.example");
    assert.deepEqual(plan.targets[0].folderNames, ["每日领取"]);
    assert.equal(plan.sources.find((source) => source.id === "configured").sections["每日领取"].length, 1);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("显式站点拒绝 HTTP 和内嵌凭据", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "checkin-configured-security-"));
  const file = path.join(directory, "Bookmarks");
  try {
    await fs.writeFile(file, JSON.stringify({
      roots: { synced: { id: "3", type: "folder", name: "我的自动任务", children: [] } },
    }));
    const embeddedCredentialUrl = `https://user:secret${"@"}configured.example/`;
    for (const url of ["http://configured.example/", embeddedCredentialUrl]) {
      await assert.rejects(readBookmarkPlan(file, {
        mobileFolderNames: ["我的自动任务"],
        targetFolderNames: ["每日领取"],
        configuredTargets: [{ url, folderName: "每日领取" }],
      }), /无凭据 HTTPS/);
    }
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("登录恢复可从 Bookmarks.bak 找到主文件缺失的目标", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "checkin-login-bookmarks-"));
  const file = path.join(directory, "Bookmarks");
  await fs.writeFile(file, JSON.stringify({
    roots: { synced: { id: "1", type: "folder", name: "我的自动任务", children: [] } },
  }));
  await fs.writeFile(`${file}.bak`, JSON.stringify({
    roots: {
      synced: {
        id: "1", type: "folder", name: "我的自动任务", children: [{
          id: "2", type: "folder", name: "每日领取", children: [
            { id: "3", type: "url", name: "Vibe Code", url: "https://service.example/dashboard" },
          ],
        }],
      },
    },
  }));

  const found = await findBookmarkTarget(file, "https://service.example", {
    mobileFolderNames: ["我的自动任务"],
    targetFolderNames: ["每日领取"],
  });
  assert.equal(found.target.origin, "https://service.example");
  assert.equal(found.recoveredFromBackup, true);
  assert.equal(found.plan.recoveredFromBackup, true);
  const fallbackPlan = await readBookmarkPlanWithBackup(file, {
    mobileFolderNames: ["我的自动任务"],
    targetFolderNames: ["每日领取"],
  });
  assert.equal(fallbackPlan.targetCount, 1);
  assert.equal(fallbackPlan.recoveredFromBackup, true);
  assert.equal(fallbackPlan.bookmarkPath, `${file}.bak`);
  const fallbackCandidates = await listBookmarkFolderCandidatesWithBackup(file);
  assert.equal(fallbackCandidates.recoveredFromBackup, true);
  assert.ok(fallbackCandidates.candidates.some((value) => value.name === "我的自动任务"));
});

test("显式站点不会阻止低目标主文件回退到完整备份", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "checkin-configured-backup-"));
  const file = path.join(directory, "Bookmarks");
  const options = {
    mobileFolderNames: ["我的自动任务"],
    targetFolderNames: ["每日领取"],
    minimumBookmarkTargetCount: 2,
    configuredTargets: [{
      title: "Configured", url: "https://configured.example/console", folderName: "每日领取",
    }],
  };
  try {
    await fs.writeFile(file, JSON.stringify({
      roots: { synced: { id: "1", type: "folder", name: "我的自动任务", children: [] } },
    }));
    await fs.writeFile(`${file}.bak`, JSON.stringify({
      roots: { synced: { id: "1", type: "folder", name: "我的自动任务", children: [{
        id: "2", type: "folder", name: "每日领取", children: [{
          id: "3", type: "url", name: "Existing", url: "https://existing.example/console",
        }],
      }] } },
    }));
    const plan = await readBookmarkPlanWithBackup(file, options);
    assert.equal(plan.recoveredFromBackup, true);
    assert.equal(plan.targetCount, 2);
    assert.ok(plan.targets.some((target) => target.origin === "https://configured.example"));
    assert.ok(plan.targets.some((target) => target.origin === "https://existing.example"));
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
