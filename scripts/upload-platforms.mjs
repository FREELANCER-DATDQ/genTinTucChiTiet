import { createReadStream } from "node:fs";
import { readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

const GRAPH_VERSION = "v23.0";
const TIKTOK_DIRECT_POST_URL = "https://open.tiktokapis.com/v2/post/publish/video/init/";
const TIKTOK_INBOX_UPLOAD_URL = "https://open.tiktokapis.com/v2/post/publish/inbox/video/init/";
const TIKTOK_DAILY_POST_LIMIT_CODE = "spam_risk_too_many_posts";
const TIKTOK_DEFAULT_PRIVACY_LEVEL = "PUBLIC_TO_EVERYONE";
const TIKTOK_PRIVACY_LEVELS = new Set([
  "PUBLIC_TO_EVERYONE",
  "MUTUAL_FOLLOW_FRIENDS",
  "FOLLOWER_OF_CREATOR",
  "SELF_ONLY"
]);
const CAPTION =
  "10 tin nổi bật hôm nay. Theo dõi @tintucchatluong để cập nhật tin tức nhanh mỗi sáng và tối. #tintuc #vnexpress #tintucchatluong";

export async function writeCaption(outDir, caption = CAPTION) {
  const captionPath = path.join(outDir, "caption.txt");
  await writeFile(captionPath, caption, "utf8");
  return caption;
}

export async function uploadToPlatforms({ outDir, videoPath, dryRun = false, caption: captionOverride, title: titleOverride, tags: tagsOverride }) {
  const env = await loadEnv();
  const caption = await writeCaption(outDir, captionOverride || CAPTION);
  const title = titleOverride || "10 tin nổi bật hôm nay";
  const tags = Array.isArray(tagsOverride) && tagsOverride.length ? tagsOverride : ["tin tức", "vnexpress", "tintucchatluong", "shorts"];
  const report = {
    generatedAt: new Date().toISOString(),
    dryRun,
    caption,
    title,
    videoPath,
    platforms: {}
  };
  const errors = {};

  if (!dryRun && String(env.UPLOAD_ENABLED || "").toLowerCase() !== "true") {
    for (const platform of ["facebook", "youtube", "tiktok"]) {
      report.platforms[platform] = skipped("UPLOAD_ENABLED is not true");
    }
    await writeJson(path.join(outDir, "upload-report.json"), report);
    return report;
  }

  const jobs = [
    ["facebook", uploadFacebookReel],
    ["youtube", uploadYoutubeShort],
    ["tiktok", uploadTikTok]
  ];

  for (const [platform, upload] of jobs) {
    try {
      report.platforms[platform] = await upload({ env, caption, title, tags, videoPath, dryRun });
    } catch (error) {
      report.platforms[platform] = { status: "failed", error: error.message };
      errors[platform] = {
        message: error.message,
        stack: error.stack
      };
    }
  }

  await writeJson(path.join(outDir, "upload-report.json"), report);
  if (Object.keys(errors).length > 0) {
    await writeJson(path.join(outDir, "upload-errors.json"), errors);
  }
  return report;
}

async function loadEnv() {
  const env = { ...process.env };
  const envPath = path.resolve(".env");
  try {
    const text = await readFile(envPath, "utf8");
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const index = trimmed.indexOf("=");
      if (index < 0) continue;
      const key = trimmed.slice(0, index).trim();
      let value = trimmed.slice(index + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      env[key] = value;
    }
  } catch {
    // .env is optional; missing credentials become skipped platform statuses.
  }
  return env;
}

function missing(env, keys) {
  return keys.filter((key) => !env[key]);
}

function skipped(reason, missingKeys = []) {
  return { status: "skipped", reason, missing: missingKeys };
}

async function uploadFacebookReel({ env, caption, title, videoPath, dryRun }) {
  const missingKeys = missing(env, ["FACEBOOK_PAGE_ID", "FACEBOOK_PAGE_ACCESS_TOKEN"]);
  if (missingKeys.length) return skipped("missing_facebook_credentials", missingKeys);
  if (dryRun) return { status: "skipped", reason: "dry_run" };

  const pageId = env.FACEBOOK_PAGE_ID;
  const accessToken = env.FACEBOOK_PAGE_ACCESS_TOKEN;
  const videoSize = (await stat(videoPath)).size;

  const start = await graphPost(`https://graph.facebook.com/${GRAPH_VERSION}/${pageId}/video_reels`, {
    access_token: accessToken,
    upload_phase: "start"
  });
  const videoId = start.video_id;
  if (!videoId) throw new Error(`Facebook did not return video_id: ${JSON.stringify(start)}`);

  const uploadUrl = start.upload_url || `https://rupload.facebook.com/video-upload/${GRAPH_VERSION}/${videoId}`;
  const uploadResponse = await fetch(uploadUrl, {
    method: "POST",
    headers: {
      Authorization: `OAuth ${accessToken}`,
      offset: "0",
      file_size: String(videoSize),
      "Content-Type": "application/octet-stream",
      "Content-Length": String(videoSize),
      "X-Entity-Length": String(videoSize)
    },
    body: createReadStream(videoPath),
    duplex: "half"
  });
  await requireOk(uploadResponse, "Facebook reel binary upload failed");

  const finish = await graphPost(`https://graph.facebook.com/${GRAPH_VERSION}/${pageId}/video_reels`, {
    access_token: accessToken,
    upload_phase: "finish",
    video_id: videoId,
    video_state: "PUBLISHED",
    description: caption,
    title
  });

  return {
    status: "published",
    videoId,
    response: finish
  };
}

async function uploadYoutubeShort({ env, caption, title, tags, videoPath, dryRun }) {
  const missingKeys = missing(env, ["YOUTUBE_CLIENT_ID", "YOUTUBE_CLIENT_SECRET", "YOUTUBE_REFRESH_TOKEN"]);
  if (missingKeys.length) return skipped("missing_youtube_credentials", missingKeys);
  if (dryRun) return { status: "skipped", reason: "dry_run" };

  const accessToken = await refreshYoutubeAccessToken(env);
  const boundary = `codex_vnexpress_${Date.now()}`;
  const metadata = {
    snippet: {
      title: title.includes("#Shorts") ? title : `${title} #Shorts`,
      description: caption,
      categoryId: "25",
      tags
    },
    status: {
      privacyStatus: "public",
      selfDeclaredMadeForKids: false
    }
  };
  const video = await readFile(videoPath);
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n`),
    Buffer.from(`--${boundary}\r\nContent-Type: video/mp4\r\n\r\n`),
    video,
    Buffer.from(`\r\n--${boundary}--\r\n`)
  ]);

  const response = await fetch("https://www.googleapis.com/upload/youtube/v3/videos?part=snippet,status&uploadType=multipart", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": `multipart/related; boundary=${boundary}`,
      "Content-Length": String(body.length)
    },
    body
  });
  const json = await requireJsonOk(response, "YouTube upload failed");
  return {
    status: "uploaded",
    privacyStatus: "public",
    videoId: json.id,
    url: json.id ? `https://www.youtube.com/watch?v=${json.id}` : undefined,
    response: json
  };
}

async function uploadTikTok({ env, caption, videoPath, dryRun }) {
  const missingKeys = missing(env, ["TIKTOK_CLIENT_KEY", "TIKTOK_CLIENT_SECRET", "TIKTOK_REFRESH_TOKEN"]);
  if (missingKeys.length) return skipped("missing_tiktok_credentials", missingKeys);
  if (dryRun) return { status: "skipped", reason: "dry_run" };

  const accessToken = await refreshTikTokAccessToken(env);
  const creator = await tiktokPost("https://open.tiktokapis.com/v2/post/publish/creator_info/query/", accessToken, {});
  const options = creator.data?.privacy_level_options || [];
  const privacyLevel = env.TIKTOK_PRIVACY_LEVEL || TIKTOK_DEFAULT_PRIVACY_LEVEL;
  if (!TIKTOK_PRIVACY_LEVELS.has(privacyLevel)) {
    throw new Error(`Invalid TIKTOK_PRIVACY_LEVEL ${privacyLevel}; expected one of ${JSON.stringify([...TIKTOK_PRIVACY_LEVELS])}`);
  }
  if (!options.includes(privacyLevel)) {
    throw new Error(`TikTok creator privacy options do not include ${privacyLevel}: ${JSON.stringify(options)}`);
  }

  const videoSize = (await stat(videoPath)).size;
  const sourceInfo = {
    source: "FILE_UPLOAD",
    video_size: videoSize,
    chunk_size: videoSize,
    total_chunk_count: 1
  };
  let delivery = "direct_post";
  let init;
  try {
    init = await tiktokPost(TIKTOK_DIRECT_POST_URL, accessToken, {
      post_info: {
        title: caption,
        privacy_level: privacyLevel,
        disable_duet: false,
        disable_comment: false,
        disable_stitch: false,
        video_cover_timestamp_ms: 1000,
        brand_content_toggle: false,
        brand_organic_toggle: false
      },
      source_info: sourceInfo
    });
  } catch (error) {
    if (!(error instanceof TikTokRequestError) || error.code !== TIKTOK_DAILY_POST_LIMIT_CODE) {
      throw error;
    }
    delivery = "tiktok_inbox";
    init = await tiktokPost(TIKTOK_INBOX_UPLOAD_URL, accessToken, {
      source_info: sourceInfo
    });
  }

  const uploadUrl = init.data?.upload_url;
  const publishId = init.data?.publish_id;
  if (!uploadUrl || !publishId) throw new Error(`TikTok did not return upload_url/publish_id: ${JSON.stringify(init)}`);

  const uploadResponse = await fetch(uploadUrl, {
    method: "PUT",
    headers: {
      "Content-Type": "video/mp4",
      "Content-Length": String(videoSize),
      "Content-Range": `bytes 0-${videoSize - 1}/${videoSize}`
    },
    body: createReadStream(videoPath),
    duplex: "half"
  });
  await requireOk(uploadResponse, "TikTok binary upload failed");

  if (delivery === "tiktok_inbox") {
    return {
      status: "draft_uploaded",
      delivery,
      requiresManualPost: true,
      publishId
    };
  }

  return {
    status: "uploaded",
    privacyStatus: privacyLevel,
    publishId
  };
}

async function refreshYoutubeAccessToken(env) {
  const body = new URLSearchParams({
    client_id: env.YOUTUBE_CLIENT_ID,
    client_secret: env.YOUTUBE_CLIENT_SECRET,
    refresh_token: env.YOUTUBE_REFRESH_TOKEN,
    grant_type: "refresh_token"
  });
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body
  });
  const json = await requireJsonOk(response, "YouTube token refresh failed");
  return json.access_token;
}

async function refreshTikTokAccessToken(env) {
  const body = new URLSearchParams({
    client_key: env.TIKTOK_CLIENT_KEY,
    client_secret: env.TIKTOK_CLIENT_SECRET,
    refresh_token: env.TIKTOK_REFRESH_TOKEN,
    grant_type: "refresh_token"
  });
  const response = await fetch("https://open.tiktokapis.com/v2/oauth/token/", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body
  });
  const json = await requireJsonOk(response, "TikTok token refresh failed");
  return json.access_token;
}

async function tiktokPost(url, accessToken, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json; charset=UTF-8"
    },
    body: JSON.stringify(body)
  });
  const text = await response.text();
  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    throw new TikTokRequestError({
      url,
      status: response.status,
      message: `non-json response ${text.slice(0, 500)}`
    });
  }
  if (!response.ok) {
    throw new TikTokRequestError({
      url,
      status: response.status,
      code: json.error?.code,
      message: json.error?.message || JSON.stringify(json),
      response: json
    });
  }
  if (json.error && json.error.code !== "ok") {
    throw new TikTokRequestError({
      url,
      status: response.status,
      code: json.error.code,
      message: json.error.message || JSON.stringify(json.error),
      response: json
    });
  }
  return json;
}

class TikTokRequestError extends Error {
  constructor({ url, status, code, message, response }) {
    const codeLabel = code ? ` ${code}` : "";
    super(`TikTok request failed: ${url}: HTTP ${status}${codeLabel}: ${message}`);
    this.name = "TikTokRequestError";
    this.status = status;
    this.code = code;
    this.apiMessage = message;
    this.response = response;
  }
}

async function graphPost(url, fields) {
  const response = await fetch(url, {
    method: "POST",
    body: new URLSearchParams(fields)
  });
  return requireJsonOk(response, `Facebook Graph request failed: ${url}`);
}

async function requireOk(response, label) {
  if (response.ok) return;
  const text = await response.text();
  throw new Error(`${label}: HTTP ${response.status} ${text}`);
}

async function requireJsonOk(response, label) {
  const text = await response.text();
  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`${label}: HTTP ${response.status} non-json response ${text.slice(0, 500)}`);
  }
  if (!response.ok) throw new Error(`${label}: HTTP ${response.status} ${JSON.stringify(json)}`);
  return json;
}

async function writeJson(filePath, value) {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
