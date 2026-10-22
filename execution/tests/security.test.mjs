import test from "node:test";
import assert from "node:assert/strict";
import { assertBookmarkNavigation, safeErrorMessage, atomicWriteJson } from "../src/security.mjs";

test("导航仅允许书签源站与显式关联源站", () => {
  assert.equal(
    assertBookmarkNavigation("https://new.example/checkin", ["https://old.example", "https://new.example"]),
    "https://new.example/checkin",
  );
  assert.throws(
    () => assertBookmarkNavigation("https://unexpected.example/", ["https://old.example", "https://new.example"]),
    /拒绝跨站导航/,
  );
  assert.throws(
    () => assertBookmarkNavigation("http://new.example/checkin", ["http://new.example"]),
    /无凭据 HTTPS/,
  );
});

test("错误原因会移除用户目录、邮箱、令牌和 URL 查询凭据", () => {
  const value = safeErrorMessage(new Error(
    "failed C:\\Users\\private-user\\profile user" + "@example.net "
      + "token=secret-value https://example.test/callback?code=secret-value",
  ));
  assert.doesNotMatch(value, /private-user|user@example\.net|secret-value/);
  assert.match(value, /\[USER_PATH\]|\[EMAIL\]|\[REDACTED\]/);
});

function memoryFiles(failures = [], initial = 'old report') {
  const files = new Map([['result.json', initial]]), writes = [], renames = [], waits = [];
  const io = {
    mkdir: async () => {},
    writeFile: async (file, bytes, options) => { assert.equal(options.mode, 0o600); assert.equal(options.flag, 'wx'); writes.push(file); files.set(file, bytes); },
    rename: async (from, to) => {
      renames.push([from, to]);
      const code = failures.shift();if (code) throw Object.assign(Error('replacement unavailable'), {code});
      if (!files.has(from)) throw Error('temporary file lost');
      files.set(to, files.get(from));files.delete(from);
    },
    unlink: async file => { files.delete(file); },
  };
  return {files, writes, renames, waits, options:{io, platform:'win32', wait:async ms=>{waits.push(ms);}}};
}

for (const code of ['EPERM', 'EACCES', 'EBUSY']) test(`atomic state replacement retries Windows ${code} without rewriting or replaying work`, async () => {
  const f = memoryFiles([code]);
  await atomicWriteJson('result.json', {status:'signed'}, f.options);
  assert.equal(f.writes.length, 1);assert.deepEqual(f.renames[0], f.renames[1]);
  assert.deepEqual(f.waits, [50]);assert.deepEqual(JSON.parse(f.files.get('result.json')), {status:'signed'});
  assert.equal(f.files.size, 1);
});

test('permanent file contention preserves the previous report and cleans only its own temporary file', async () => {
  const f = memoryFiles(Array(6).fill('EBUSY'));
  await assert.rejects(atomicWriteJson('result.json', {status:'signed'}, f.options), /unavailable/);
  assert.equal(f.writes.length, 1);assert.equal(f.renames.length, 6);
  assert.deepEqual(f.waits, [50,100,200,400,800]);assert.deepEqual([...f.files], [['result.json','old report']]);
});

test('non-Windows errors and non-contention failures are not retried', async () => {
  for (const [platform, code] of [['linux','EPERM'], ['win32','ENOSPC'], ['win32','ENOENT']]) {
    const f = memoryFiles([code]);
    await assert.rejects(atomicWriteJson('result.json', {}, {...f.options, platform}));
    assert.equal(f.renames.length, 1);assert.deepEqual(f.waits, []);
    assert.deepEqual([...f.files], [['result.json','old report']]);
  }
});

test('concurrent writes from one process use different temporary files', async () => {
  const f = memoryFiles();
  await Promise.all([atomicWriteJson('result.json', {run:1}, f.options), atomicWriteJson('result.json', {run:2}, f.options)]);
  assert.equal(new Set(f.writes).size, 2);assert.equal(f.files.size, 1);
  assert.ok([1,2].includes(JSON.parse(f.files.get('result.json')).run));
});
