import assert from "node:assert/strict";
import test from "node:test";

import { parseManualArticleUrl } from "../scripts/hot-story-sources.mjs";

test("manual VnExpress URL is normalized and assigned to VnExpress", () => {
  const result = parseManualArticleUrl("  https://vnexpress.net/thoi-su/bai-viet.html#video  ");

  assert.equal(result.url, "https://vnexpress.net/thoi-su/bai-viet.html");
  assert.equal(result.source.key, "vnexpress");
  assert.equal(result.source.name, "VnExpress");
});

test("manual Vietnamnet subdomain URL is assigned to Vietnamnet", () => {
  const result = parseManualArticleUrl("https://video.vietnamnet.vn/bai-viet-123.html");

  assert.equal(result.url, "https://video.vietnamnet.vn/bai-viet-123.html");
  assert.equal(result.source.key, "vietnamnet");
  assert.equal(result.source.name, "Vietnamnet");
});

test("empty manual URL keeps automatic RSS selection enabled", () => {
  assert.equal(parseManualArticleUrl("   "), null);
});

test("manual URL accepts another HTTPS news site and derives its source", () => {
  const result = parseManualArticleUrl("https://www.tuoitre.vn/thoi-su/bai-viet.html#comments");

  assert.equal(result.url, "https://www.tuoitre.vn/thoi-su/bai-viet.html");
  assert.equal(result.source.key, "tuoitre-vn");
  assert.equal(result.source.name, "tuoitre.vn");
  assert.equal(result.source.role, "manual");
});

test("manual URL rejects malformed and non-HTTPS links", () => {
  assert.throws(() => parseManualArticleUrl("not-a-url"), /không hợp lệ/);
  assert.throws(() => parseManualArticleUrl("http://vnexpress.net/bai-viet"), /HTTPS/);
});
