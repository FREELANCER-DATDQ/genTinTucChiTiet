import test from "node:test";
import assert from "node:assert/strict";
import { createAiClient, resolveAiConfig, selectWithAi } from "../scripts/hot-story-ai.mjs";

function validSelection(overrides = {}) {
  return {
    selectedId: "candidate-1",
    hotScore: 80,
    reason: "Tin có tác động rộng.",
    angle: "Tóm tắt diễn biến chính.",
    videoTitle: "Một thay đổi đáng chú ý vừa được công bố",
    voiceoverScript: Array.from({ length: 180 }, (_, index) => `từ${index + 1}`).join(" "),
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
    })),
    ...overrides
  };
}

const items = [{
  id: "candidate-1",
  title: "Tiêu đề sự kiện",
  summary: "Cơ quan A công bố thay đổi mới.",
  articleText: "Cơ quan A công bố 20 trường hợp.",
  sourceName: "VnExpress",
  link: "https://vnexpress.net/test"
}];
const sources = [{ name: "VnExpress", domain: "vnexpress.net" }];

test("AI config defaults to Vertex and accepts standard Google Cloud env fallbacks", () => {
  assert.deepEqual(resolveAiConfig({ GOOGLE_CLOUD_PROJECT: "project-a" }), {
    provider: "vertex",
    model: "gemini-2.5-flash",
    project: "project-a",
    location: "us-central1"
  });
});

test("AI config resolves Gemini without leaking or transforming its key", () => {
  assert.deepEqual(resolveAiConfig({
    HOT_STORY_AI_PROVIDER: "gemini",
    GEMINI_API_KEY: "secret-key",
    GEMINI_MODEL: "gemini-test"
  }), {
    provider: "gemini",
    model: "gemini-test",
    apiKey: "secret-key"
  });
});

test("AI config rejects invalid providers and missing provider credentials", () => {
  assert.throws(() => resolveAiConfig({ HOT_STORY_AI_PROVIDER: "other" }), /must be "vertex" or "gemini"/);
  assert.throws(() => resolveAiConfig({}), /VERTEX_PROJECT_ID/);
  assert.throws(() => resolveAiConfig({ HOT_STORY_AI_PROVIDER: "gemini" }), /GEMINI_API_KEY/);
});

test("client factory uses API key for Gemini and ADC configuration for Vertex", () => {
  class FakeClient {
    constructor(options) { this.options = options; }
  }
  const gemini = createAiClient({ provider: "gemini", apiKey: "key" }, FakeClient);
  assert.deepEqual(gemini.options, { apiKey: "key" });
  const vertex = createAiClient({ provider: "vertex", project: "project-a", location: "asia-southeast1" }, FakeClient);
  assert.deepEqual(vertex.options, {
    vertexai: true,
    project: "project-a",
    location: "asia-southeast1",
    apiVersion: "v1"
  });
});

for (const provider of ["vertex", "gemini"]) {
  test(`${provider} uses the shared structured-output contract and returns provider metadata`, async () => {
    const requests = [];
    const client = {
      models: {
        async generateContent(request) {
          requests.push(request);
          return { text: JSON.stringify(validSelection()) };
        }
      }
    };
    const selection = await selectWithAi(items, sources, {
      config: { provider, model: "model-test" },
      client
    });
    assert.equal(selection.provider, provider);
    assert.equal(selection.model, "model-test");
    assert.equal("apiKey" in selection, false);
    assert.equal(requests[0].config.responseMimeType, "application/json");
    assert.equal(requests[0].config.responseJsonSchema.type, "object");
    assert.doesNotMatch(requests[0].contents, /vnexpress|https?:\/\//i);
  });
}

test("provider retries a leaking response once and then accepts corrected content", async () => {
  let calls = 0;
  const client = {
    models: {
      async generateContent() {
        calls += 1;
        return {
          text: JSON.stringify(validSelection(calls === 1
            ? { caption: "Nguồn: https://vnexpress.net/test" }
            : {}))
        };
      }
    }
  };
  const selection = await selectWithAi(items, sources, {
    config: { provider: "vertex", model: "model-test" },
    client
  });
  assert.equal(calls, 2);
  assert.doesNotMatch(selection.caption, /Nguồn|https?:\/\//i);
});

test("provider fails closed after two request failures", async () => {
  const client = { models: { async generateContent() { throw new Error("ADC unavailable"); } } };
  await assert.rejects(
    selectWithAi(items, sources, { config: { provider: "vertex", model: "model-test" }, client }),
    /failed closed.*ADC unavailable.*Verify Vertex ADC/s
  );
});
