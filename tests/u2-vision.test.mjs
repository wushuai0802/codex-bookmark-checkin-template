import test from "node:test";
import assert from "node:assert/strict";
import { parseMyAnimeListSearchImages } from "../src/u2-vision.mjs";

test("U2 备用作品源只接受标题匹配的 MyAnimeList CDN 图片", () => {
  const html = `
    <img alt="School Rumble" data-src="https://cdn.myanimelist.net/r/50x70/images/anime/4/75488.jpg?s=abc">
    <img alt="Unrelated School" data-src="https://cdn.myanimelist.net/r/50x70/images/anime/1/2.jpg?s=def">
    <img alt="School Rumble: Extra Class" data-src="https://cdn.myanimelist.net/r/100x140/images/anime/3/4.jpg?s=ghi">
    <img alt="School Rumble" data-src="https://attacker.invalid/image.jpg">
  `;
  assert.deepEqual(parseMyAnimeListSearchImages(html, ["School Rumble"]), [
    "https://cdn.myanimelist.net/images/anime/4/75488.jpg?s=abc",
    "https://cdn.myanimelist.net/images/anime/3/4.jpg?s=ghi",
  ]);
});
