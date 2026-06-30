import test from "node:test";
import assert from "node:assert/strict";
import {
  countWords,
  geminiPrompt,
  normalizeSelection,
  sanitizeArticleText,
  sourceIdentifiers,
  validatePublicSelection
} from "../scripts/hot-story-content.mjs";
import { renderHotStoryComposition } from "../scripts/hot-story-visuals.mjs";

const items = [{
  id: "story-1",
  title: "Tiêu đề sự kiện",
  summary: "Cơ quan A công bố thay đổi mới.",
  articleText: "Phóng viên: Nguyễn Văn A\nCơ quan A công bố 20 trường hợp.\nNguồn: https://vnexpress.net/test",
  sourceName: "VnExpress",
  sourceUrl: "https://vnexpress.net/rss/tin-noi-bat.rss",
  link: "https://vnexpress.net/test",
  pubDate: "2026-06-29"
}];

function validSelection() {
  const voiceoverScript = Array.from({ length: 180 }, (_, index) => `từ${index + 1}`).join(" ");
  return {
    selectedId: "story-1",
    hotScore: 80,
    videoTitle: "Một thay đổi đáng chú ý vừa được công bố",
    voiceoverScript,
    caption: "Thông tin mới và những điểm cần lưu ý.\n\n#TinTuc #CapNhat #Shorts",
    hashtags: ["#TinTuc", "#CapNhat", "#Shorts"],
    scenes: Array.from({ length: 6 }, (_, index) => ({
      label: `Cảnh ${index + 1}`,
      headline: "Diễn biến chính",
      body: "Thông tin đã được tổng hợp lại.",
      narration: "Thông tin đã được tổng hợp lại.",
      visualType: "key-points",
      visualTitle: "Điểm cần biết",
      visualPrimary: "",
      visualSecondary: "",
      visualItems: ["Ý thứ nhất", "Ý thứ hai"],
      chartData: [],
      durationSeconds: 10
    }))
  };
}

test("article text sanitizer removes publication, URL and byline but keeps event entities", () => {
  const identifiers = sourceIdentifiers(items, [{ name: "VnExpress", domain: "vnexpress.net" }]);
  const clean = sanitizeArticleText(items[0].articleText, identifiers);
  assert.equal(clean, "Cơ quan A công bố 20 trường hợp.");
});

test("Gemini prompt omits source identity, links and media instructions", () => {
  const identifiers = sourceIdentifiers(items, [{ name: "VnExpress", domain: "vnexpress.net" }]);
  const prompt = geminiPrompt(items, identifiers);
  assert.doesNotMatch(prompt, /https:\/\/vnexpress\.net\/test/);
  assert.doesNotMatch(prompt, /mediaIndex|media gốc/iu);
  assert.match(prompt, /Cơ quan A công bố 20 trường hợp/);
});

test("selection normalization falls back from an invalid chart to key points", () => {
  const selection = validSelection();
  selection.scenes[0].visualType = "bar-chart";
  selection.scenes[0].chartData = [{ label: "Một", value: 1, displayValue: "1" }];
  const normalized = normalizeSelection(selection);
  assert.equal(normalized.scenes[0].visualType, "key-points");
});

test("selection normalization trims an oversized voiceover at a sentence boundary", () => {
  const selection = validSelection();
  selection.voiceoverScript = Array.from({ length: 30 }, (_, index) => (
    `Câu ${index + 1} có mười từ nội dung để kiểm tra giới hạn.`
  )).join(" ");
  const normalized = normalizeSelection(selection);
  assert.ok(countWords(normalized.voiceoverScript) <= 220);
  assert.match(normalized.voiceoverScript, /\.$/);
});

test("public validator rejects publication names, URLs and bylines", () => {
  const selection = validSelection();
  selection.caption = "Theo VnExpress https://vnexpress.net/test\nPhóng viên: A";
  const identifiers = sourceIdentifiers(items, [{ name: "VnExpress", domain: "vnexpress.net" }]);
  const violations = validatePublicSelection(selection, items, identifiers);
  assert.ok(violations.some((item) => item.includes("URL")));
  assert.ok(violations.some((item) => item.includes("byline")));
  assert.ok(violations.some((item) => item.includes("VnExpress")));
});

test("public validator accepts cleaned content and necessary entity names", () => {
  const selection = validSelection();
  selection.scenes[0].body = "Bộ Giao thông công bố thay đổi áp dụng từ tháng tới.";
  assert.deepEqual(validatePublicSelection(selection, items, sourceIdentifiers(items)), []);
});

test("code-native composition contains charts but no article image, video or source line", () => {
  const selection = normalizeSelection(validSelection());
  selection.scenes[0] = {
    ...selection.scenes[0],
    visualType: "bar-chart",
    chartData: [
      { label: "Nhóm A", value: 20, displayValue: "20 trường hợp" },
      { label: "Nhóm B", value: 10, displayValue: "10 trường hợp" }
    ]
  };
  const scenes = selection.scenes.map((scene, index) => ({
    ...scene,
    index: index + 1,
    startSeconds: index * 10,
    durationSeconds: 10
  }));
  const html = renderHotStoryComposition({
    selection,
    scenes,
    totalSeconds: 64,
    narrationAudio: null,
    publicDate: "29/06 23:00",
    width: 1080,
    height: 1920,
    fps: 30,
    outroSeconds: 4,
    transitionSeconds: 0.55,
    watermark: "@tintucchatluong",
    backgroundVolume: 0.42,
    narrationVolume: 1
  });
  assert.match(html, /class="bar-chart"/);
  assert.match(html, /window\.__timelines\.root = master/);
  assert.doesNotMatch(html, /<img\b|<video\b|source-line|vnexpress\.net|VnExpress/i);
});
