import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { uploadToPlatforms } from "../scripts/upload-platforms.mjs";

const TOKEN_URL = "https://open.tiktokapis.com/v2/oauth/token/";
const CREATOR_URL = "https://open.tiktokapis.com/v2/post/publish/creator_info/query/";
const DIRECT_URL = "https://open.tiktokapis.com/v2/post/publish/video/init/";
const INBOX_URL = "https://open.tiktokapis.com/v2/post/publish/inbox/video/init/";
const UPLOAD_URL = "https://upload.example/video";
const ENV_KEYS = [
  "UPLOAD_ENABLED",
  "FACEBOOK_PAGE_ID",
  "FACEBOOK_PAGE_ACCESS_TOKEN",
  "YOUTUBE_CLIENT_ID",
  "YOUTUBE_CLIENT_SECRET",
  "YOUTUBE_REFRESH_TOKEN",
  "TIKTOK_CLIENT_KEY",
  "TIKTOK_CLIENT_SECRET",
  "TIKTOK_REFRESH_TOKEN",
  "TIKTOK_PRIVACY_LEVEL"
];

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}

async function runTikTokUpload(fetchHandler) {
  const originalCwd = process.cwd();
  const originalFetch = globalThis.fetch;
  const originalEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "upload-platforms-test-"));
  const outDir = path.join(tempDir, "output");
  const videoPath = path.join(tempDir, "video.mp4");
  const calls = [];

  await mkdir(outDir);
  await writeFile(videoPath, Buffer.from("fake-video"));
  for (const key of ENV_KEYS) delete process.env[key];
  Object.assign(process.env, {
    UPLOAD_ENABLED: "true",
    TIKTOK_CLIENT_KEY: "client-key",
    TIKTOK_CLIENT_SECRET: "client-secret",
    TIKTOK_REFRESH_TOKEN: "refresh-token"
  });

  globalThis.fetch = async (url, options = {}) => {
    const call = { url: String(url), options };
    calls.push(call);
    return fetchHandler(call, calls);
  };
  process.chdir(tempDir);

  try {
    const report = await uploadToPlatforms({ outDir, videoPath });
    const persistedReport = JSON.parse(await readFile(path.join(outDir, "upload-report.json"), "utf8"));
    let persistedErrors;
    try {
      persistedErrors = JSON.parse(await readFile(path.join(outDir, "upload-errors.json"), "utf8"));
    } catch {
      persistedErrors = undefined;
    }
    return { report, calls, persistedReport, persistedErrors };
  } finally {
    process.chdir(originalCwd);
    globalThis.fetch = originalFetch;
    for (const key of ENV_KEYS) {
      if (originalEnv[key] === undefined) delete process.env[key];
      else process.env[key] = originalEnv[key];
    }
    await rm(tempDir, { recursive: true, force: true });
  }
}

function commonResponse(call) {
  if (call.url === TOKEN_URL) return jsonResponse({ access_token: "access-token" });
  if (call.url === CREATOR_URL) {
    return jsonResponse({
      data: { privacy_level_options: ["PUBLIC_TO_EVERYONE"] },
      error: { code: "ok", message: "" }
    });
  }
  return null;
}

test("TikTok direct post success does not call inbox", async () => {
  const { report, calls } = await runTikTokUpload((call) => {
    const response = commonResponse(call);
    if (response) return response;
    if (call.url === DIRECT_URL) {
      return jsonResponse({ data: { publish_id: "direct-id", upload_url: UPLOAD_URL }, error: { code: "ok" } });
    }
    if (call.url === UPLOAD_URL) return new Response(null, { status: 201 });
    throw new Error(`Unexpected request: ${call.url}`);
  });

  assert.deepEqual(report.platforms.tiktok, {
    status: "uploaded",
    privacyStatus: "PUBLIC_TO_EVERYONE",
    publishId: "direct-id"
  });
  assert.equal(calls.some((call) => call.url === INBOX_URL), false);
});

test("TikTok daily direct-post limit falls back to an inbox draft", async () => {
  const { report, calls } = await runTikTokUpload((call) => {
    const response = commonResponse(call);
    if (response) return response;
    if (call.url === DIRECT_URL) {
      return jsonResponse({ error: { code: "spam_risk_too_many_posts", message: "Too many posts" } }, 403);
    }
    if (call.url === INBOX_URL) {
      return jsonResponse({ data: { publish_id: "draft-id", upload_url: UPLOAD_URL }, error: { code: "ok" } });
    }
    if (call.url === UPLOAD_URL) return new Response(null, { status: 201 });
    throw new Error(`Unexpected request: ${call.url}`);
  });

  assert.deepEqual(report.platforms.tiktok, {
    status: "draft_uploaded",
    delivery: "tiktok_inbox",
    requiresManualPost: true,
    publishId: "draft-id"
  });
  const inboxCall = calls.find((call) => call.url === INBOX_URL);
  assert.deepEqual(JSON.parse(inboxCall.options.body), {
    source_info: {
      source: "FILE_UPLOAD",
      video_size: 10,
      chunk_size: 10,
      total_chunk_count: 1
    }
  });
});

test("TikTok does not fall back for a different 403 error", async () => {
  const { report, calls } = await runTikTokUpload((call) => {
    const response = commonResponse(call);
    if (response) return response;
    if (call.url === DIRECT_URL) {
      return jsonResponse({ error: { code: "scope_not_authorized", message: "Missing scope" } }, 403);
    }
    throw new Error(`Unexpected request: ${call.url}`);
  });

  assert.equal(report.platforms.tiktok.status, "failed");
  assert.match(report.platforms.tiktok.error, /scope_not_authorized/);
  assert.equal(calls.some((call) => call.url === INBOX_URL), false);
});

test("TikTok reports an inbox initialization failure", async () => {
  const { report } = await runTikTokUpload((call) => {
    const response = commonResponse(call);
    if (response) return response;
    if (call.url === DIRECT_URL) {
      return jsonResponse({ error: { code: "spam_risk_too_many_posts", message: "Too many posts" } }, 403);
    }
    if (call.url === INBOX_URL) {
      return jsonResponse({ error: { code: "scope_not_authorized", message: "Missing video.upload" } }, 401);
    }
    throw new Error(`Unexpected request: ${call.url}`);
  });

  assert.equal(report.platforms.tiktok.status, "failed");
  assert.match(report.platforms.tiktok.error, /scope_not_authorized/);
});

test("TikTok reports a binary upload failure after inbox fallback", async () => {
  const { report, persistedReport, persistedErrors } = await runTikTokUpload((call) => {
    const response = commonResponse(call);
    if (response) return response;
    if (call.url === DIRECT_URL) {
      return jsonResponse({ error: { code: "spam_risk_too_many_posts", message: "Too many posts" } }, 403);
    }
    if (call.url === INBOX_URL) {
      return jsonResponse({ data: { publish_id: "draft-id", upload_url: UPLOAD_URL }, error: { code: "ok" } });
    }
    if (call.url === UPLOAD_URL) return new Response("upload rejected", { status: 403 });
    throw new Error(`Unexpected request: ${call.url}`);
  });

  assert.equal(report.platforms.tiktok.status, "failed");
  assert.match(report.platforms.tiktok.error, /TikTok binary upload failed/);
  assert.equal(persistedReport.platforms.tiktok.status, "failed");
  assert.match(persistedErrors.tiktok.message, /TikTok binary upload failed/);
});
