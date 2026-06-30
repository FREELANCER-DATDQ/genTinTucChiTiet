import { spawnSync } from "node:child_process";
import { copyFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { NEWS_SOURCES, parseManualArticleUrl } from "./hot-story-sources.mjs";
import { resolveAiConfig, selectWithAi } from "./hot-story-ai.mjs";
import { renderHotStoryComposition } from "./hot-story-visuals.mjs";
import { uploadToPlatforms, writeCaption } from "./upload-platforms.mjs";

loadDotenv(path.resolve(".env"));

const PRIMARY_SOURCE = NEWS_SOURCES.find((source) => source.role === "primary") || NEWS_SOURCES[0];
const FALLBACK_SOURCES = NEWS_SOURCES.filter((source) => source.role === "fallback");
const BACKGROUND_AUDIO = process.env.BACKGROUND_AUDIO_PATH || path.resolve("assets", "background01.mp3");
const WATERMARK = "@tintucchatluong";
const WIDTH = 1080;
const HEIGHT = 1920;
const FPS = 30;
const OUTRO_SECONDS = 4;
const CANDIDATE_COUNT = envNumber("HOT_STORY_CANDIDATE_COUNT", 12);
const TARGET_DURATION = envNumber("HOT_STORY_DURATION_TARGET", 75);
const MIN_DURATION = 60;
const MAX_DURATION = 90;
const TRANSITION_SECONDS = 0.55;
const DEDUPE_STATE = process.env.VNEXPRESS_DEDUPE_STATE || path.resolve(".vnexpress-state", "seen-news.json");
const DEDUPE_UPDATED_MARKER = process.env.VNEXPRESS_DEDUPE_UPDATED_MARKER
  || path.join(path.dirname(DEDUPE_STATE), "updated.json");
const HOT_STORY_FORCE_URL = process.env.HOT_STORY_FORCE_URL || "";
const HOOK_TTS_ENABLED = envBool("HOOK_TTS_ENABLED", false);
const HOOK_TTS_PROVIDER = process.env.HOOK_TTS_PROVIDER || "vieneu";
const HOOK_TTS_VOLUME = envNumber("HOOK_TTS_VOLUME", 1.0);
const BACKGROUND_VOLUME = envNumber("BACKGROUND_VOLUME", 0.42);
const BACKGROUND_VOLUME_WITH_TTS = envNumber("BACKGROUND_VOLUME_WITH_TTS", 0.25);
const VIENEU_MODE = process.env.VIENEU_MODE || "standard";
const VIENEU_MODEL_NAME = process.env.VIENEU_MODEL_NAME || "pnnbao-ump/VieNeu-TTS-v2";
const VIENEU_TTS_SCRIPT = path.resolve("scripts", "vieneu-hook-tts.py");

const args = new Set(process.argv.slice(2));
const slotArg = valueAfter("--slot");
const skipRender = args.has("--skip-render");
const uploadRequested = args.has("--upload");
const dryRunUpload = args.has("--dry-run-upload");

function valueAfter(flag) {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function unquoteEnvValue(value) {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function loadDotenv(envPath) {
  if (!existsSync(envPath)) return;
  const content = readFileSync(envPath, "utf8");
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    const [, key, rawValue] = match;
    if (process.env[key] !== undefined) continue;
    process.env[key] = unquoteEnvValue(rawValue);
  }
}

function envBool(name, fallback = false) {
  const value = process.env[name];
  if (value === undefined || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

function envNumber(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? value : fallback;
}

function bangkokParts(date = new Date()) {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Bangkok",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  });
  const parts = Object.fromEntries(formatter.formatToParts(date).map((p) => [p.type, p.value]));
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    hour: Number(parts.hour),
    minute: Number(parts.minute)
  };
}

function currentSlot() {
  if (slotArg) return slotArg;
  const now = bangkokParts();
  return `${String(now.hour).padStart(2, "0")}00`;
}

function slotTimeWindow(slot) {
  const match = String(slot || "").match(/^([01]\d|2[0-3])([0-5]\d)$/);
  if (!match) return null;
  const nowMs = Date.now();
  const bangkokOffset = 7 * 60 * 60 * 1000;
  const todayMidnightBangkok = new Date(
    Math.floor((nowMs + bangkokOffset) / (24 * 60 * 60 * 1000)) * (24 * 60 * 60 * 1000) - bangkokOffset
  );
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  const to = todayMidnightBangkok.getTime() + (hour * 60 + minute) * 60 * 1000;
  const from = to - (2 * 60 + 2) * 60 * 1000;
  return { from, to };
}

function decodeEntities(value = "") {
  return value
    .replaceAll("<![CDATA[", "")
    .replaceAll("]]>", "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .trim();
}

function stripHtml(value = "") {
  return decodeEntities(value)
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeDedupeKey(value = "") {
  return stripHtml(value)
    .toLowerCase()
    .normalize("NFC")
    .replace(/^https?:\/\/(www\.)?/i, "")
    .replace(/[?#].*$/, "")
    .replace(/\/+$/, "")
    .replace(/[^\p{L}\p{N}./-]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

async function readDedupeState(statePath, date) {
  try {
    const raw = await readFile(statePath, "utf8");
    const parsed = JSON.parse(raw);
    const day = parsed.days?.[date] || {};
    return {
      version: 1,
      days: {
        [date]: {
          links: Array.isArray(day.links) ? day.links : [],
          titles: Array.isArray(day.titles) ? day.titles : [],
          items: Array.isArray(day.items) ? day.items : []
        }
      }
    };
  } catch (error) {
    if (error.code !== "ENOENT") {
      console.warn(`[dedupe] Khong doc duoc state ${statePath}: ${error.message}. Tao state moi.`);
    }
    return { version: 1, days: { [date]: { links: [], titles: [], items: [] } } };
  }
}

function dedupeItems(items, state, date, initialItems = []) {
  const day = state.days?.[date] || {};
  const seenLinks = new Set((day.links || []).map(normalizeDedupeKey).filter(Boolean));
  const seenTitles = new Set((day.titles || []).map(normalizeDedupeKey).filter(Boolean));

  for (const item of initialItems) {
    const linkKey = normalizeDedupeKey(item.link);
    const titleKey = normalizeDedupeKey(item.title || item.hook);
    if (linkKey) seenLinks.add(linkKey);
    if (titleKey) seenTitles.add(titleKey);
  }

  const fresh = [];
  for (const item of items) {
    const linkKey = normalizeDedupeKey(item.link);
    const titleKey = normalizeDedupeKey(item.title || item.hook);
    if ((linkKey && seenLinks.has(linkKey)) || (titleKey && seenTitles.has(titleKey))) continue;
    if (linkKey) seenLinks.add(linkKey);
    if (titleKey) seenTitles.add(titleKey);
    fresh.push(item);
  }

  return fresh.map((item, index) => ({ ...item, index: index + 1 }));
}

async function writeDedupeState(statePath, date, slot, selectedItems) {
  const state = await readDedupeState(statePath, date);
  const day = state.days[date] || { links: [], titles: [], items: [] };
  const links = new Set((day.links || []).map(normalizeDedupeKey).filter(Boolean));
  const titles = new Set((day.titles || []).map(normalizeDedupeKey).filter(Boolean));
  const existingItems = Array.isArray(day.items) ? day.items : [];
  const addedItems = [];

  for (const item of selectedItems) {
    const linkKey = normalizeDedupeKey(item.link);
    const titleKey = normalizeDedupeKey(item.title || item.hook);
    if (linkKey) links.add(linkKey);
    if (titleKey) titles.add(titleKey);
    addedItems.push({
      slot,
      link: item.link,
      title: item.title,
      savedAt: new Date().toISOString()
    });
  }

  const nextState = {
    version: 1,
    updatedAt: new Date().toISOString(),
    days: {
      [date]: {
        links: [...links],
        titles: [...titles],
        items: [...existingItems, ...addedItems]
      }
    }
  };

  await mkdir(path.dirname(statePath), { recursive: true });
  await writeFile(statePath, JSON.stringify(nextState, null, 2), "utf8");
  console.log(`[dedupe] Da luu ${selectedItems.length} tin vao ${statePath} cho ngay ${date}.`);
}

async function writeDedupeUpdatedMarker(markerPath, date, slot, selectedItems) {
  await mkdir(path.dirname(markerPath), { recursive: true });
  await writeFile(markerPath, JSON.stringify({
    date,
    slot,
    savedCount: selectedItems.length,
    updatedAt: new Date().toISOString()
  }, null, 2), "utf8");
}

function tag(block, name) {
  const match = block.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)<\\/${name}>`, "i"));
  return decodeEntities(match?.[1] ?? "");
}

function attrTag(block, name, attr) {
  const match = block.match(new RegExp(`<${name}[^>]*\\s${attr}=["']([^"']+)["'][^>]*\\/?>`, "i"));
  return decodeEntities(match?.[1] ?? "");
}

function extractImageFromHtml(html = "") {
  const og = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i)
    ?? html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i);
  if (og?.[1]) return decodeEntities(og[1]);
  const img = html.match(/<img[^>]+src=["']([^"']+)["']/i);
  return img?.[1] ? decodeEntities(img[1]) : "";
}

function absoluteUrl(value = "", base = "") {
  try {
    return new URL(decodeEntities(value), base).toString();
  } catch {
    return "";
  }
}

function unique(values) {
  const seen = new Set();
  const output = [];
  for (const value of values) {
    const clean = String(value || "").trim();
    if (!clean || seen.has(clean)) continue;
    seen.add(clean);
    output.push(clean);
  }
  return output;
}

function uniqueBy(values, keyFn) {
  const seen = new Set();
  const output = [];
  for (const value of values) {
    const key = keyFn(value);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    output.push(value);
  }
  return output;
}

function cleanMediaUrl(value = "", baseUrl = "") {
  const clean = String(value || "")
    .trim()
    .replace(/^url\((['"]?)(.*?)\1\)$/i, "$2");
  if (!clean || clean.startsWith("data:") || clean.startsWith("blob:")) return "";
  return absoluteUrl(clean, baseUrl);
}

function mediaTypeFromUrl(url = "", fallback = "image") {
  const clean = String(url).split("?")[0].toLowerCase();
  if (/\.(m3u8|mp4|mov|m4v|webm)$/i.test(clean)) return "video";
  return fallback;
}

function isLikelyImageUrl(url = "") {
  try {
    const parsed = new URL(url);
    const pathname = parsed.pathname.toLowerCase();
    if (/\.(svg|ico)$/i.test(pathname)) return false;
    if (/\.(jpg|jpeg|png|webp|gif)$/i.test(pathname)) return true;
    return parsed.searchParams.get("t") === "image";
  } catch {
    return false;
  }
}

function isRejectedImageUrl(url = "") {
  return /logo|avatar|icon|sprite|blank|grey|\/graphics\/|\/menu-|myvne/i.test(url);
}

function normalizeMediaCandidate(candidate = {}, baseUrl = "") {
  const sourceUrl = cleanMediaUrl(candidate.sourceUrl || candidate.url || candidate.src, baseUrl);
  const thumbnailUrl = cleanMediaUrl(candidate.thumbnailUrl || candidate.poster || candidate.thumb, baseUrl);
  if (!sourceUrl && !thumbnailUrl) return null;
  const type = candidate.type === "video" || mediaTypeFromUrl(sourceUrl, candidate.type) === "video" ? "video" : "image";
  return {
    type,
    sourceUrl: sourceUrl || thumbnailUrl,
    thumbnailUrl: thumbnailUrl || undefined,
    durationSeconds: Number.isFinite(Number(candidate.durationSeconds)) ? Number(candidate.durationSeconds) : undefined,
    width: Number.isFinite(Number(candidate.width)) ? Number(candidate.width) : undefined,
    height: Number.isFinite(Number(candidate.height)) ? Number(candidate.height) : undefined,
    caption: candidate.caption ? stripHtml(candidate.caption) : undefined,
    origin: candidate.origin || "article"
  };
}

function imageCandidateFromUrl(url, origin = "article", baseUrl = "", caption = "") {
  const sourceUrl = cleanMediaUrl(url, baseUrl);
  if (!sourceUrl) return null;
  return normalizeMediaCandidate({ type: "image", sourceUrl, caption, origin }, baseUrl);
}

function videoCandidateFromUrl(url, origin = "article", baseUrl = "", extra = {}) {
  const sourceUrl = cleanMediaUrl(url, baseUrl);
  if (!sourceUrl) return null;
  return normalizeMediaCandidate({ type: "video", sourceUrl, origin, ...extra }, baseUrl);
}

function extractAttribute(tagText = "", attr = "") {
  const match = tagText.match(new RegExp(`\\s${attr}=["']([^"']+)["']`, "i"));
  return decodeEntities(match?.[1] || "");
}

function metaContent(html = "", name = "") {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const patterns = [
    new RegExp(`<meta[^>]+(?:property|name|itemprop)=["']${escaped}["'][^>]+content=["']([^"']+)["'][^>]*>`, "i"),
    new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name|itemprop)=["']${escaped}["'][^>]*>`, "i")
  ];
  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match?.[1]) return decodeEntities(match[1]);
  }
  return "";
}

function parseIsoDurationSeconds(value = "") {
  const match = String(value).match(/^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?$/i);
  if (!match) return undefined;
  const [, days, hours, minutes, seconds] = match;
  return (Number(days || 0) * 86400) + (Number(hours || 0) * 3600) + (Number(minutes || 0) * 60) + Number(seconds || 0);
}

function collectVideoObjects(node, output = []) {
  if (!node) return output;
  if (Array.isArray(node)) {
    for (const item of node) collectVideoObjects(item, output);
    return output;
  }
  if (typeof node !== "object") return output;
  const types = Array.isArray(node["@type"]) ? node["@type"] : [node["@type"]];
  if (types.some((type) => String(type || "").toLowerCase() === "videoobject")) output.push(node);
  for (const value of Object.values(node)) collectVideoObjects(value, output);
  return output;
}

function extractJsonLdMediaCandidates(html = "", baseUrl = "") {
  const candidates = [];
  for (const match of html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const parsed = JSON.parse(decodeEntities(match[1]).trim());
      for (const video of collectVideoObjects(parsed)) {
        const thumbnail = Array.isArray(video.thumbnailUrl) ? video.thumbnailUrl[0] : video.thumbnailUrl;
        const source = video.contentUrl || video.embedUrl || video.url;
        const candidate = videoCandidateFromUrl(source, "json-ld", baseUrl, {
          thumbnailUrl: thumbnail,
          durationSeconds: parseIsoDurationSeconds(video.duration),
          width: video.width,
          height: video.height,
          caption: video.name || video.description
        });
        if (candidate) candidates.push(candidate);
      }
    } catch {
      // Ignore malformed JSON-LD blocks; other extraction paths still run.
    }
  }
  return candidates;
}

function extractMediaCandidates(html = "", baseUrl = "") {
  const candidates = [];
  const og = extractImageFromHtml(html);
  if (og) candidates.push(imageCandidateFromUrl(og, "og:image", baseUrl));
  for (const name of ["twitter:image", "image", "thumbnailUrl"]) {
    const value = metaContent(html, name);
    if (value) candidates.push(imageCandidateFromUrl(value, `meta:${name}`, baseUrl));
  }
  candidates.push(...extractJsonLdMediaCandidates(html, baseUrl));

  for (const match of html.matchAll(/<figure\b[^>]*>([\s\S]*?)<\/figure>/gi)) {
    const figure = match[1];
    const caption = extractFirstHtml(figure, [/<figcaption[^>]*>([\s\S]*?)<\/figcaption>/i, /<p[^>]*class=["'][^"']*caption[^"']*["'][^>]*>([\s\S]*?)<\/p>/i]);
    for (const img of figure.matchAll(/<img[^>]+(?:src|data-src|data-original|data-srcset)=["']([^"']+)["'][^>]*>/gi)) {
      candidates.push(imageCandidateFromUrl(img[1], "figure", baseUrl, caption));
    }
    for (const video of figure.matchAll(/<video\b([^>]*)>([\s\S]*?)<\/video>/gi)) {
      const attrs = video[1];
      const inner = video[2];
      const src = extractAttribute(attrs, "src") || inner.match(/<source[^>]+src=["']([^"']+)["']/i)?.[1];
      const poster = extractAttribute(attrs, "poster");
      const duration = extractAttribute(attrs, "data-duration");
      candidates.push(videoCandidateFromUrl(src, "figure-video", baseUrl, {
        thumbnailUrl: poster,
        durationSeconds: Number(duration) || undefined,
        caption
      }));
    }
  }

  for (const match of html.matchAll(/<img[^>]+(?:src|data-src|data-original)=["']([^"']+)["'][^>]*>/gi)) {
    candidates.push(imageCandidateFromUrl(match[1], "img", baseUrl));
  }
  for (const match of html.matchAll(/<source[^>]+srcset=["']([^"']+)["'][^>]*>/gi)) {
    const first = match[1].split(",")[0]?.trim().split(/\s+/)[0];
    candidates.push(imageCandidateFromUrl(first, "source-srcset", baseUrl));
  }
  for (const match of html.matchAll(/<meta[^>]+itemprop=["'](?:url|contentUrl)["'][^>]+content=["']([^"']+)["'][^>]*>/gi)) {
    const url = cleanMediaUrl(match[1], baseUrl);
    if (mediaTypeFromUrl(url) === "video") {
      candidates.push(videoCandidateFromUrl(url, "meta:itemprop", baseUrl));
    } else if (isLikelyImageUrl(url)) {
      candidates.push(imageCandidateFromUrl(url, "meta:itemprop", baseUrl));
    }
  }
  for (const match of html.matchAll(/<video\b([^>]*)>([\s\S]*?)<\/video>/gi)) {
    const attrs = match[1];
    const inner = match[2];
    const src = extractAttribute(attrs, "src") || inner.match(/<source[^>]+src=["']([^"']+)["']/i)?.[1];
    const poster = extractAttribute(attrs, "poster");
    const duration = extractAttribute(attrs, "data-duration");
    candidates.push(videoCandidateFromUrl(src, "video-tag", baseUrl, {
      thumbnailUrl: poster,
      durationSeconds: Number(duration) || undefined
    }));
  }
  for (const match of html.matchAll(/\b(?:data-src|data-url|data-video-url|contentUrl|content_url)=["']([^"']+\.(?:m3u8|mp4|m4v|mov|webm)(?:\?[^"']*)?)["']/gi)) {
    candidates.push(videoCandidateFromUrl(match[1], "video-embed", baseUrl));
  }
  for (const match of html.matchAll(/<[^>]+class=["'][^"']*thumb-above-video[^"']*["'][^>]+(?:src|data-src)=["']([^"']+)["'][^>]*>/gi)) {
    candidates.push(imageCandidateFromUrl(match[1], "video-thumbnail", baseUrl));
  }

  return uniqueBy(candidates.filter(Boolean)
    .filter((candidate) => /^https?:\/\//i.test(candidate.sourceUrl))
    .filter((candidate) => candidate.type === "video" || (isLikelyImageUrl(candidate.sourceUrl) && !isRejectedImageUrl(candidate.sourceUrl))), (candidate) => `${candidate.type}:${candidate.sourceUrl}`);
}

function extractImageCandidates(html = "", baseUrl = "") {
  return extractMediaCandidates(html, baseUrl)
    .filter((candidate) => candidate.type === "image")
    .map((candidate) => candidate.sourceUrl);
}

function extractFirstHtml(html = "", patterns) {
  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match?.[1]) return stripHtml(match[1]);
  }
  return "";
}

function extractParagraphs(html = "") {
  const values = [];
  const articleMatch = html.match(/<article[\s\S]*?<\/article>/i);
  const content = articleMatch?.[0] || html;
  for (const match of content.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi)) {
    const text = stripHtml(match[1]);
    if (text.length >= 40 && !/VnExpress|Vietnamnet|Theo doi|Chia se/i.test(text)) {
      values.push(text);
    }
  }
  return unique(values).slice(0, 30);
}

function extractArticleDetails(html = "", link = "") {
  const title = extractFirstHtml(html, [
    /<h1[^>]*class=["'][^"']*title-detail[^"']*["'][^>]*>([\s\S]*?)<\/h1>/i,
    /<h1[^>]*class=["'][^"']*content-detail-title[^"']*["'][^>]*>([\s\S]*?)<\/h1>/i,
    /<h1[^>]*>([\s\S]*?)<\/h1>/i,
    /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:title["']/i
  ]);
  const lead = extractFirstHtml(html, [
    /<p[^>]*class=["'][^"']*description[^"']*["'][^>]*>([\s\S]*?)<\/p>/i,
    /<p[^>]*class=["'][^"']*lead[^"']*["'][^>]*>([\s\S]*?)<\/p>/i,
    /<h2[^>]*class=["'][^"']*sapo[^"']*["'][^>]*>([\s\S]*?)<\/h2>/i,
    /<div[^>]*class=["'][^"']*content-detail-sapo[^"']*["'][^>]*>([\s\S]*?)<\/div>/i,
    /<h2[^>]*class=["'][^"']*content-detail-sapo[^"']*["'][^>]*>([\s\S]*?)<\/h2>/i,
    /<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]+name=["']description["']/i
  ]);
  return {
    title,
    lead,
    imageUrl: extractImageFromHtml(html),
    imageCandidates: extractImageCandidates(html, link),
    mediaCandidates: extractMediaCandidates(html, link),
    paragraphs: extractParagraphs(html)
  };
}

function parseItems(xml, window = null, source = PRIMARY_SOURCE) {
  const blocks = [...xml.matchAll(/<item\b[\s\S]*?<\/item>/gi)].map((match) => match[0]);
  const seen = new Set();
  const allItems = [];

  for (const block of blocks) {
    const link = tag(block, "link");
    if (!link || seen.has(link)) continue;
    seen.add(link);

    const pubDateStr = tag(block, "pubDate");
    const pubMs = pubDateStr ? new Date(pubDateStr).getTime() : NaN;
    const descriptionRaw = tag(block, "description");
    const rssMedia = [];
    for (const match of block.matchAll(/<(media:content|enclosure)\b([^>]*)\/?>/gi)) {
      const tagName = match[1].toLowerCase();
      const attrs = match[2];
      const url = extractAttribute(attrs, "url");
      const mime = extractAttribute(attrs, "type");
      const width = extractAttribute(attrs, "width");
      const height = extractAttribute(attrs, "height");
      const mediaType = mime.startsWith("video/") || mediaTypeFromUrl(url) === "video" ? "video" : "image";
      const candidate = normalizeMediaCandidate({
        type: mediaType,
        sourceUrl: url,
        width,
        height,
        origin: `rss:${tagName}`
      }, link);
      if (candidate) rssMedia.push(candidate);
    }
    const descriptionImage = extractImageFromHtml(descriptionRaw);
    const descriptionCandidate = descriptionImage ? imageCandidateFromUrl(descriptionImage, "rss:description", link) : null;
    const mediaCandidates = uniqueBy([...rssMedia, descriptionCandidate].filter(Boolean), (candidate) => `${candidate.type}:${candidate.sourceUrl}`);
    const image = mediaCandidates.find((candidate) => candidate.type === "image")?.sourceUrl || "";

    allItems.push({
      index: allItems.length + 1,
      id: `${source.key}-${allItems.length + 1}`,
      title: stripHtml(tag(block, "title")),
      link,
      pubDate: pubDateStr,
      pubMs,
      category: stripHtml(tag(block, "category")),
      summary: stripHtml(descriptionRaw),
      imageUrl: image,
      mediaCandidates,
      imageCandidates: mediaCandidates.filter((candidate) => candidate.type === "image").map((candidate) => candidate.sourceUrl),
      sourceKey: source.key,
      sourceName: source.name,
      sourceUrl: source.url
    });
  }

  const filtered = window
    ? allItems.filter((item) => Number.isFinite(item.pubMs) && item.pubMs >= window.from && item.pubMs <= window.to)
    : allItems;

  if (!window || filtered.length >= CANDIDATE_COUNT) {
    return filtered.slice(0, CANDIDATE_COUNT).map((item, index) => ({ ...item, index: index + 1 }));
  }

  const links = new Set(filtered.map((item) => item.link));
  const extras = allItems.filter((item) => !links.has(item.link)).slice(0, CANDIDATE_COUNT - filtered.length);
  console.warn(`[slot ${slotArg ?? "auto"}] Chi co ${filtered.length} tin trong khung gio. Bo sung ${extras.length} tin gan nhat.`);
  return [...filtered, ...extras].slice(0, CANDIDATE_COUNT).map((item, index) => ({ ...item, index: index + 1 }));
}

async function fetchText(url) {
  const response = await fetch(url, {
    headers: {
      "user-agent": "Mozilla/5.0 (compatible; Hot story video automation)",
      "accept": "text/html,application/rss+xml,application/xml;q=0.9,*/*;q=0.8"
    }
  });
  if (!response.ok) throw new Error(`Fetch failed ${response.status} for ${url}`);
  return response.text();
}

async function enrichArticles(items) {
  return Promise.all(items.map(async (item) => {
    try {
      const html = await fetchText(item.link);
      const article = extractArticleDetails(html, item.link);
      const mediaCandidates = uniqueBy([
        ...(item.mediaCandidates || []),
        article.imageUrl ? imageCandidateFromUrl(article.imageUrl, "article:primary", item.link) : null,
        ...article.mediaCandidates
      ].filter(Boolean), (candidate) => `${candidate.type}:${candidate.sourceUrl}`);
      const imageCandidates = mediaCandidates
        .filter((candidate) => candidate.type === "image")
        .map((candidate) => candidate.sourceUrl);
      return {
        ...item,
        title: article.title || item.title,
        hook: article.title || item.title,
        summary: article.lead || item.summary,
        imageUrl: imageCandidates[0] || item.imageUrl,
        imageCandidates,
        mediaCandidates,
        articleText: article.paragraphs.join("\n")
      };
    } catch (error) {
      return {
        ...item,
        hook: item.title,
        summary: item.summary,
        mediaCandidates: item.mediaCandidates || (item.imageUrl ? [imageCandidateFromUrl(item.imageUrl, "rss:fallback", item.link)].filter(Boolean) : []),
        imageCandidates: item.imageCandidates || (item.imageUrl ? [item.imageUrl] : []),
        articleText: "",
        enrichError: error.message
      };
    }
  }));
}

async function loadSourceItems(source, window) {
  const xml = await fetchText(source.url);
  const parsed = parseItems(xml, window, source);
  const enriched = await enrichArticles(parsed);
  return { parsed, enriched };
}

async function loadForcedItem(url, source) {
  const html = await fetchText(url);
  const article = extractArticleDetails(html, url);
  const mediaCandidates = uniqueBy([
    article.imageUrl ? imageCandidateFromUrl(article.imageUrl, "article:primary", url) : null,
    ...article.mediaCandidates
  ].filter(Boolean), (candidate) => `${candidate.type}:${candidate.sourceUrl}`);
  const imageCandidates = mediaCandidates
    .filter((candidate) => candidate.type === "image")
    .map((candidate) => candidate.sourceUrl);
  return {
    index: 1,
    id: "forced-1",
    title: article.title || "Tin nong trong ngay",
    hook: article.title || "Tin nong trong ngay",
    link: url,
    pubDate: "",
    pubMs: Date.now(),
    category: "",
    summary: article.lead || article.paragraphs[0] || article.title || "",
    imageUrl: imageCandidates[0] || "",
    imageCandidates,
    mediaCandidates,
    sourceKey: source.key,
    sourceName: source.name,
    sourceUrl: url,
    articleText: article.paragraphs.join("\n")
  };
}

function recencyScore(pubMs) {
  if (!Number.isFinite(pubMs)) return 0;
  const ageHours = Math.max(0, (Date.now() - pubMs) / 36e5);
  if (ageHours <= 2) return 18;
  if (ageHours <= 6) return 14;
  if (ageHours <= 12) return 9;
  if (ageHours <= 24) return 5;
  return 0;
}

function countMatches(text, patterns) {
  return patterns.reduce((sum, pattern) => sum + (pattern.test(text) ? 1 : 0), 0);
}

function viralScore(item) {
  const text = `${item.title} ${item.summary} ${item.category} ${item.articleText}`.toLowerCase();
  let score = recencyScore(item.pubMs);
  score += countMatches(text, [/\d+[\d.,]*\s*(tỷ|triệu|nghìn|đồng|usd|euro|%)/i, /\d+[\d.,]*\s*(người|ca|năm|tháng|giờ|km|m2)/i]) * 12;
  score += countMatches(text, [/phạt|bắt|khởi tố|điều tra|truy tố|xét xử|tử vong|cháy|tai nạn|sập|lừa đảo/i]) * 10;
  score += countMatches(text, [/điện|xăng|lương|thuế|bảo hiểm|giá vàng|giá nhà|học phí|ngân hàng|lãi suất/i]) * 9;
  score += countMatches(text, [/arsenal|man utd|manchester|real madrid|barca|champions league|v-league|u23|world cup|olympic/i]) * 8;
  score += countMatches(text, [/ceo|tổng thống|thủ tướng|bộ trưởng|nghệ sĩ|ca sĩ|hoa hậu|tỷ phú|elon musk|trump|putin/i]) * 7;
  score += countMatches(text, [/đề xuất|dự thảo|quy định|chính sách|cấm|bắt buộc|tăng|giảm|miễn/i]) * 6;
  score += item.mediaCandidates?.length ? 5 : 0;
  score += item.mediaCandidates?.some((candidate) => candidate.type === "video") ? 4 : 0;
  score += Math.max(0, 6 - Math.floor((item.index - 1) / 2));
  return score;
}

function limitWords(value, maxWords) {
  const words = String(value || "").split(/\s+/).filter(Boolean);
  if (words.length <= maxWords) return words.join(" ");
  return `${words.slice(0, maxWords).join(" ")}...`;
}

function limitTextByWords(value, maxWords) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length <= maxWords) return text;
  const sentences = text.match(/[^.!?。！？]+[.!?。！？]+|[^.!?。！？]+$/g) || [text];
  const kept = [];
  let count = 0;
  for (const sentence of sentences) {
    const sentenceWords = sentence.split(/\s+/).filter(Boolean).length;
    if (kept.length && count + sentenceWords > maxWords) break;
    kept.push(sentence.trim());
    count += sentenceWords;
    if (count >= maxWords) break;
  }
  if (kept.length) return kept.join(" ").trim();
  return words.slice(0, maxWords).join(" ").replace(/[,.!?;:]*$/, ".");
}

function ensureSceneDurations(scenes) {
  if (!Array.isArray(scenes) || scenes.length < 6) throw new Error("Gemini must return at least 6 validated scenes.");
  const base = scenes;
  const contentTarget = Math.max(MIN_DURATION - OUTRO_SECONDS, Math.min(MAX_DURATION - OUTRO_SECONDS, TARGET_DURATION - OUTRO_SECONDS));
  const current = base.reduce((sum, scene) => sum + scene.durationSeconds, 0);
  if (current >= MIN_DURATION - OUTRO_SECONDS && current <= MAX_DURATION - OUTRO_SECONDS) return base;
  const perScene = Math.max(8, Math.min(13, Math.round(contentTarget / base.length)));
  return base.map((scene) => ({ ...scene, durationSeconds: perScene }));
}

function extensionFrom(url, contentType) {
  if (contentType?.includes("gif")) return ".gif";
  if (contentType?.includes("png")) return ".png";
  if (contentType?.includes("webp")) return ".webp";
  if (contentType?.includes("jpeg") || contentType?.includes("jpg")) return ".jpg";
  try {
    const ext = path.extname(new URL(url).pathname.toLowerCase());
    return [".jpg", ".jpeg", ".png", ".webp", ".gif"].includes(ext) ? ext : ".jpg";
  } catch {
    return ".jpg";
  }
}

function videoExtensionFrom(url = "") {
  try {
    const ext = path.extname(new URL(url).pathname.toLowerCase());
    return [".mp4", ".m4v", ".mov", ".webm"].includes(ext) ? ext : ".mp4";
  } catch {
    return ".mp4";
  }
}

async function downloadImageMedia(candidate, assetDir, index, prefix = "story-image") {
  const response = await fetch(candidate.sourceUrl, {
    headers: { "user-agent": "Mozilla/5.0 (compatible; Hot story video automation)" }
  });
  if (!response.ok) throw new Error(`Image fetch failed ${response.status}`);
  const contentType = response.headers.get("content-type") || "";
  if (contentType && (!contentType.startsWith("image/") || contentType.includes("svg"))) {
    throw new Error(`Unexpected image content-type ${contentType}`);
  }
  const ext = extensionFrom(candidate.sourceUrl, contentType);
  const filename = `${prefix}-${String(index).padStart(2, "0")}${ext}`;
  const filePath = path.join(assetDir, filename);
  const buffer = Buffer.from(await response.arrayBuffer());
  await writeFile(filePath, buffer);
  return {
    ...candidate,
    type: "image",
    localMedia: `assets/${filename}`,
    localImage: `assets/${filename}`
  };
}

function ffmpegInputHeaders(referer = "") {
  const headers = [];
  if (referer) headers.push(`Referer: ${referer}`);
  try {
    const origin = new URL(referer).origin;
    headers.push(`Origin: ${origin}`);
  } catch {}
  return headers.length ? `${headers.join("\r\n")}\r\n` : "";
}

function ffmpegDownloadVideo(sourceUrl, filePath, referer = "") {
  if (!commandExists("ffmpeg")) throw new Error("ffmpeg is not available for video media");
  const userAgent = "Mozilla/5.0 (compatible; Hot story video automation)";
  const headers = ffmpegInputHeaders(referer);
  const copyArgs = [
    "-y",
    "-user_agent", userAgent,
    ...(headers ? ["-headers", headers] : []),
    "-i", sourceUrl,
    "-map", "0:v:0",
    "-map", "0:a:0?",
    "-c", "copy",
    "-bsf:a", "aac_adtstoasc",
    "-movflags", "+faststart",
    filePath
  ];
  let result = spawnSync("ffmpeg", copyArgs, { encoding: "utf8" });
  if (result.status === 0) return;

  const transcodeArgs = [
    "-y",
    "-user_agent", userAgent,
    ...(headers ? ["-headers", headers] : []),
    "-i", sourceUrl,
    "-map", "0:v:0",
    "-map", "0:a:0?",
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-crf", "23",
    "-c:a", "aac",
    "-movflags", "+faststart",
    filePath
  ];
  result = spawnSync("ffmpeg", transcodeArgs, { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || "ffmpeg video download failed").trim().slice(0, 600));
  }
}

async function downloadVideoMedia(candidate, assetDir, index, referer = "") {
  const filename = `story-video-${String(index).padStart(2, "0")}${videoExtensionFrom(candidate.sourceUrl)}`;
  const filePath = path.join(assetDir, filename);
  ffmpegDownloadVideo(candidate.sourceUrl, filePath, referer);
  const downloaded = {
    ...candidate,
    type: "video",
    localMedia: `assets/${filename}`,
    localVideo: `assets/${filename}`
  };
  if (candidate.thumbnailUrl) {
    try {
      const thumbnail = await downloadImageMedia({
        type: "image",
        sourceUrl: candidate.thumbnailUrl,
        origin: `${candidate.origin}:thumbnail`
      }, assetDir, index, "story-video-thumb");
      downloaded.localThumbnail = thumbnail.localMedia;
    } catch (error) {
      downloaded.thumbnailDownloadError = error.message;
    }
  }
  return downloaded;
}

function storyMediaCandidates(story) {
  const fromMedia = Array.isArray(story.mediaCandidates) ? story.mediaCandidates : [];
  const fromImages = (story.imageCandidates || [story.imageUrl])
    .filter(Boolean)
    .map((url) => imageCandidateFromUrl(url, "legacy:imageCandidates", story.link))
    .filter(Boolean);
  return uniqueBy([...fromMedia, ...fromImages], (candidate) => `${candidate.type}:${candidate.sourceUrl}`);
}

async function downloadStoryMedia(story, assetDir) {
  await mkdir(assetDir, { recursive: true });
  const candidates = storyMediaCandidates(story);
  const media = [];
  const errors = [];
  let imageIndex = 1;
  let videoIndex = 1;

  for (const candidate of candidates) {
    try {
      if (candidate.type === "video") {
        media.push(await downloadVideoMedia(candidate, assetDir, videoIndex, story.link));
        videoIndex += 1;
      } else {
        media.push(await downloadImageMedia(candidate, assetDir, imageIndex));
        imageIndex += 1;
      }
    } catch (error) {
      const record = {
        type: candidate.type,
        sourceUrl: candidate.sourceUrl,
        thumbnailUrl: candidate.thumbnailUrl,
        origin: candidate.origin,
        error: error.message
      };
      errors.push(record);
      console.warn(`[media] Bo qua ${candidate.type} ${candidate.sourceUrl}: ${error.message}`);
      if (candidate.type === "video" && candidate.thumbnailUrl) {
        try {
          media.push(await downloadImageMedia({
            type: "image",
            sourceUrl: candidate.thumbnailUrl,
            caption: candidate.caption,
            origin: `${candidate.origin}:thumbnail-fallback`
          }, assetDir, imageIndex));
          imageIndex += 1;
        } catch (thumbnailError) {
          errors.push({
            type: "image",
            sourceUrl: candidate.thumbnailUrl,
            origin: `${candidate.origin}:thumbnail-fallback`,
            error: thumbnailError.message
          });
        }
      }
    }
  }

  return { media, errors };
}

function prioritizeVideoMedia(media = []) {
  return [
    ...media.filter((item) => item.type === "video"),
    ...media.filter((item) => item.type !== "video")
  ];
}

function audioDurationSeconds(filePath) {
  if (!commandExists("ffprobe")) return null;
  const result = spawnSync("ffprobe", [
    "-v", "error",
    "-show_entries", "format=duration",
    "-of", "default=noprint_wrappers=1:nokey=1",
    filePath
  ], { encoding: "utf8" });
  if (result.status !== 0) return null;
  const duration = Number(result.stdout.trim());
  return Number.isFinite(duration) ? duration : null;
}

function atempoFilter(speed) {
  const factors = [];
  let remaining = speed;
  while (remaining > 2) {
    factors.push(2);
    remaining /= 2;
  }
  factors.push(Math.max(0.5, Math.min(2, remaining)));
  return factors.map((factor) => `atempo=${factor.toFixed(4).replace(/0+$/, "").replace(/\.$/, "")}`).join(",");
}

async function fitAudioDuration(filePath, maxSeconds) {
  const duration = audioDurationSeconds(filePath);
  if (!duration || duration <= maxSeconds) return duration;
  if (!commandExists("ffmpeg")) return duration;
  const tempPath = `${filePath}.tmp.wav`;
  const speed = duration / maxSeconds;
  const result = spawnSync("ffmpeg", [
    "-y",
    "-i", filePath,
    "-filter:a", atempoFilter(speed),
    "-ar", "24000",
    "-ac", "1",
    tempPath
  ], { encoding: "utf8" });
  if (result.status !== 0) return duration;
  await rename(tempPath, filePath);
  return audioDurationSeconds(filePath) || maxSeconds;
}

function pythonCommand() {
  const configured = process.env.HOOK_TTS_PYTHON;
  if (configured) return configured;
  if (commandExists("python3")) return "python3";
  return "python";
}

function storyNarrationText(story, selection, scenes) {
  if (!selection?.voiceoverScript) {
    throw new Error("Validated Gemini voiceoverScript is required; raw article fallback is disabled.");
  }
  return selection.voiceoverScript;
}

async function synthesizeStoryTts(story, selection, scenes, assetDir, maxSeconds) {
  if (!HOOK_TTS_ENABLED) return { scenes, narrationAudio: null };
  if (HOOK_TTS_PROVIDER !== "vieneu") {
    console.warn(`[tts] HOOK_TTS_PROVIDER=${HOOK_TTS_PROVIDER} chua duoc ho tro. Bo qua TTS.`);
    return { scenes, narrationAudio: null };
  }
  await mkdir(assetDir, { recursive: true });
  const py = pythonCommand();
  if (!commandExists(py) || !existsSync(VIENEU_TTS_SCRIPT)) {
    console.warn(`[tts] Khong tim thay Python hoac ${VIENEU_TTS_SCRIPT}. Bo qua TTS.`);
    return { scenes, narrationAudio: null };
  }

  const filename = "story-narration.wav";
  const output = path.join(assetDir, filename);
  const manifestPath = path.join(assetDir, "story-tts-input.json");
  await writeFile(manifestPath, JSON.stringify(
    [{ text: storyNarrationText(story, selection, scenes), output }],
    null,
    2
  ), "utf8");

  const ttsArgs = [
    VIENEU_TTS_SCRIPT,
    "--input-json", manifestPath,
    "--mode", VIENEU_MODE,
    "--emotion", process.env.VIENEU_EMOTION || "natural"
  ];
  if (process.env.VIENEU_VOICE_ID) ttsArgs.push("--voice-id", process.env.VIENEU_VOICE_ID);
  if (process.env.VIENEU_API_BASE) ttsArgs.push("--api-base", process.env.VIENEU_API_BASE);
  if (VIENEU_MODEL_NAME) ttsArgs.push("--model-name", VIENEU_MODEL_NAME);

  const result = spawnSync(py, ttsArgs, { encoding: "utf8", shell: false });
  if (result.status !== 0) {
    console.warn(`[tts] Khong tao duoc batch voice: ${(result.stderr || result.stdout || "").trim()}`);
    return { scenes, narrationAudio: null };
  }

  if (!existsSync(output)) return { scenes, narrationAudio: null };
  const duration = await fitAudioDuration(output, Math.max(1, maxSeconds - 0.6));
  return {
    scenes,
    narrationAudio: {
      src: `assets/${filename}`,
      durationSeconds: duration ? Number(duration.toFixed(3)) : null
    }
  };
}

function escapeHtml(value = "") {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function titleFontSize(title = "") {
  const length = [...title].length;
  if (length <= 38) return 86;
  if (length <= 58) return 74;
  if (length <= 82) return 62;
  return 54;
}

function bodyFontSize(body = "") {
  const length = [...body].length;
  if (length <= 120) return 43;
  if (length <= 180) return 37;
  return 32;
}

function wordSpans(value = "") {
  return String(value)
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => `<span>${escapeHtml(word)}</span>`)
    .join(" ");
}

function formatPubDate(pubDate) {
  if (!pubDate) return "Tin mới";
  const date = new Date(pubDate);
  if (Number.isNaN(date.getTime())) return "Tin mới";
  return new Intl.DateTimeFormat("vi-VN", {
    timeZone: "Asia/Bangkok",
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(date);
}

function assignSceneTimings(scenes) {
  let start = 0;
  return scenes.map((scene, index) => {
    const timed = { ...scene, index: index + 1, startSeconds: start };
    start += scene.durationSeconds;
    return timed;
  });
}

function renderImageElement(media) {
  if (!media?.localMedia || media.type === "video") return "";
  return `<img class="bg-photo" src="${escapeHtml(media.localMedia)}" alt="" />`;
}

function renderStageVideoElement(media, scene) {
  if (!media?.localMedia || media.type !== "video") return "";
  const poster = media.localThumbnail ? ` poster="${escapeHtml(media.localThumbnail)}"` : "";
  return `<video id="scene-video-${String(scene.index).padStart(2, "0")}" class="scene-video" src="${escapeHtml(media.localMedia)}"${poster} muted playsinline preload="auto" loop data-start="${scene.startSeconds}" data-duration="${scene.durationSeconds}"></video>`;
}

function subtitleCueTexts(text, maxWords = 13) {
  const clean = String(text || "").replace(/\s+/g, " ").trim();
  if (!clean) return [];
  const sentences = clean.match(/[^.!?。！？]+[.!?。！？]+|[^.!?。！？]+$/g) || [clean];
  const cues = [];
  for (const sentence of sentences) {
    const words = sentence.trim().split(/\s+/).filter(Boolean);
    for (let index = 0; index < words.length; index += maxWords) {
      cues.push(words.slice(index, index + maxWords).join(" "));
    }
  }
  return cues.filter(Boolean);
}

function renderSubtitleCues(story, selection, scenes, narrationAudio, totalSeconds) {
  const contentSeconds = scenes.reduce((sum, scene) => sum + scene.durationSeconds, 0);
  const voiceDuration = Math.max(1, Math.min(narrationAudio?.durationSeconds || contentSeconds, contentSeconds, totalSeconds - OUTRO_SECONDS));
  const cues = subtitleCueTexts(storyNarrationText(story, selection, scenes));
  if (!cues.length) return "";
  const wordCounts = cues.map((cue) => cue.split(/\s+/).filter(Boolean).length);
  const totalWords = Math.max(1, wordCounts.reduce((sum, count) => sum + count, 0));
  let cursor = 0.25;
  return cues.map((cue, index) => {
    const share = wordCounts[index] / totalWords;
    const remaining = Math.max(0.15, 0.25 + voiceDuration - cursor);
    const duration = index === cues.length - 1 ? remaining : Math.max(1.35, share * voiceDuration);
    const html = `<div class="subtitle-cue" data-start="${cursor.toFixed(3)}" data-duration="${duration.toFixed(3)}">${escapeHtml(cue)}</div>`;
    cursor += duration;
    return html;
  }).join("\n      ");
}

function renderComposition({ story, selection, scenes, media, totalSeconds, narrationAudio }) {
  const sceneMedia = scenes.map((scene, index) => ({
    scene,
    index,
    selectedMedia: media.length ? media[Math.abs(scene.mediaIndex ?? scene.imageIndex ?? index) % media.length] : null
  }));
  const videoHtml = sceneMedia
    .map(({ scene, selectedMedia }) => renderStageVideoElement(selectedMedia, scene))
    .filter(Boolean)
    .join("\n    ");
  const sceneHtml = sceneMedia.map(({ scene, index, selectedMedia }) => {
    const hasMedia = Boolean(selectedMedia?.localMedia);
    return `
      <section id="scene-${String(scene.index).padStart(2, "0")}" class="clip scene ${hasMedia ? "has-media" : "no-media"} ${selectedMedia?.type === "video" ? "has-video" : ""}" data-start="${scene.startSeconds}" data-duration="${scene.durationSeconds}" style="--i:${index};">
        ${renderImageElement(selectedMedia)}
        <div class="fallback-bg"></div>
      </section>`;
  }).join("\n");
  const hasVoice = Boolean(narrationAudio?.src);
  const backgroundVolume = hasVoice ? BACKGROUND_VOLUME_WITH_TTS : BACKGROUND_VOLUME;
  const audioHtml = narrationAudio?.src
    ? `<audio id="story-narration" data-start="0.25" data-duration="${Math.max(0.1, Math.min(narrationAudio.durationSeconds || totalSeconds, totalSeconds - 0.35))}" data-track-index="20" data-volume="${HOOK_TTS_VOLUME}" src="${escapeHtml(narrationAudio.src)}"></audio>`
    : "";
  const outroStart = totalSeconds - OUTRO_SECONDS;
  const storyTitle = limitWords(story.title || selection.videoTitle, 18);

  return `<!doctype html>
<html lang="vi">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(selection.videoTitle)}</title>
  <link rel="icon" href="data:," />
  <script src="https://cdn.jsdelivr.net/npm/gsap@3.12.5/dist/gsap.min.js"></script>
  <style>
    :root { color-scheme: dark; }
    * { box-sizing: border-box; }
    body { margin: 0; width: ${WIDTH}px; height: ${HEIGHT}px; overflow: hidden; background: #050607; font-family: Arial, "Helvetica Neue", sans-serif; }
    #stage { position: relative; width: ${WIDTH}px; height: ${HEIGHT}px; overflow: hidden; background: #050607; }
    .channel-panel { position: absolute; left: 0; width: 100%; height: 640px; z-index: 5; display: flex; flex-direction: column; justify-content: center; align-items: center; text-align: center; padding: 54px 72px; overflow: hidden; }
    .channel-panel.top { top: 0; background: linear-gradient(180deg, #101217 0%, #0b0d10 100%); border-bottom: 14px solid #e30613; }
    .channel-panel.bottom { bottom: 0; background: linear-gradient(180deg, #0b0d10 0%, #101217 100%); border-top: 14px solid #e30613; gap: 26px; }
    .brand-kicker { margin: 0 0 22px; color: #fff46b; font-size: 34px; line-height: 1; font-weight: 950; text-transform: uppercase; }
    .brand-title { margin: 0; color: #fff; font-size: 86px; line-height: .98; font-weight: 950; letter-spacing: 0; text-wrap: balance; text-shadow: 0 10px 34px rgba(0,0,0,.7); }
    .follow-pill { display: inline-flex; align-items: center; justify-content: center; min-height: 104px; margin-top: 38px; padding: 0 52px; background: #e30613; color: #fff; font-size: 48px; font-weight: 950; box-shadow: 14px 14px 0 rgba(255,255,255,.9); }
    .channel-name { margin: 0; color: #fff; font-size: 64px; line-height: 1; font-weight: 950; }
    .channel-meta { margin: 0; color: #f3f6f9; font-size: 34px; line-height: 1.24; font-weight: 850; max-width: 920px; text-wrap: balance; }
    .source-line { margin: 0; color: #fff46b; font-size: 30px; line-height: 1.18; font-weight: 950; text-transform: uppercase; }
    .media-window { position: absolute; left: 0; top: 640px; width: 100%; height: 640px; overflow: hidden; background: #000; z-index: 1; }
    .scene-video { position: absolute; left: 0; top: 640px; width: 100%; height: 640px; object-fit: cover; object-position: center center; filter: saturate(1.08) contrast(1.05) brightness(.92); opacity: 0; z-index: 2; }
    .scene { position: absolute; left: 0; top: 640px; width: 100%; height: 640px; opacity: 0; overflow: hidden; background: #050607; z-index: 3; }
    .scene.has-video { background: transparent; pointer-events: none; }
    .bg-photo { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; object-position: center center; filter: saturate(1.08) contrast(1.05) brightness(.92); }
    .fallback-bg { position: absolute; inset: 0; background: linear-gradient(145deg, #111318, #050607 52%, #181a1f); }
    .has-media .fallback-bg { opacity: 0; }
    .subtitle-layer { position: absolute; left: 0; top: 640px; width: 100%; height: 640px; z-index: 8; pointer-events: none; overflow: hidden; }
    .subtitle-cue { position: absolute; left: 72px; right: 72px; bottom: 46px; opacity: 0; transform: translateY(12px); color: #fff; font-size: 44px; line-height: 1.1; font-weight: 950; text-align: center; text-wrap: balance; text-shadow: 0 5px 0 #000, 0 -2px 0 #000, 2px 0 0 #000, -2px 0 0 #000, 0 8px 26px rgba(0,0,0,.95); }
    .outro { position: absolute; inset: 0; opacity: 0; overflow: hidden; background: linear-gradient(135deg, #050505 0%, #151515 48%, #e30613 49%, #e30613 58%, #050505 59%); }
    .outro::before { content: ""; position: absolute; inset: 0; background: linear-gradient(180deg, rgba(0,0,0,.2), rgba(0,0,0,.72)); }
    .outro-inner { position: absolute; inset: 0; padding: 170px 74px 190px; display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center; gap: 38px; }
    .outro h2 { margin: 0; color: #fff; font-size: 76px; line-height: 1.02; font-weight: 950; text-wrap: balance; text-shadow: 0 8px 34px rgba(0,0,0,.7); }
    .outro p { margin: 0; color: #fff46b; font-size: 40px; line-height: 1.18; font-weight: 900; max-width: 880px; text-shadow: 0 6px 26px rgba(0,0,0,.72); }
    .pill { display: inline-flex; align-items: center; justify-content: center; min-width: 620px; min-height: 96px; padding: 0 44px; background: #fff; color: #101217; font-size: 42px; font-weight: 950; box-shadow: 14px 14px 0 #e30613; }
    .watermark { position: absolute; right: 50px; bottom: 42px; z-index: 100; color: rgba(255,255,255,.88); font-size: 28px; font-weight: 900; text-shadow: 0 4px 22px rgba(0,0,0,.8); }
    .progress { position: absolute; left: 0; right: 0; bottom: 0; height: 16px; background: rgba(255,255,255,.18); z-index: 101; }
    .progress-inner { height: 100%; width: 0%; background: #e30613; }
  </style>
</head>
<body>
  <div id="stage" data-composition-id="root" data-start="0" data-duration="${totalSeconds}" data-width="${WIDTH}" data-height="${HEIGHT}">
    <section class="channel-panel top">
      <p class="brand-kicker">Tin mới mỗi ngày</p>
      <h1 class="brand-title">Theo dõi kênh để cập nhật nhanh tin tức nóng</h1>
      <div class="follow-pill">${escapeHtml(WATERMARK)}</div>
    </section>
    <div class="media-window"></div>
    ${videoHtml}
    ${sceneHtml}
    <div class="subtitle-layer">
      ${renderSubtitleCues(story, selection, scenes, narrationAudio, totalSeconds)}
    </div>
    <section class="channel-panel bottom">
      <p class="channel-name">${escapeHtml(WATERMARK)}</p>
      <p class="source-line">${escapeHtml(story.sourceName)} • ${escapeHtml(formatPubDate(story.pubDate))} • ${escapeHtml(storyTitle)}</p>
    </section>
    <section id="outro-subscribe" class="clip outro" data-start="${outroStart}" data-duration="${OUTRO_SECONDS}">
      <div class="outro-inner">
        <h2>Theo dõi diễn biến tiếp theo</h2>
        <p>${escapeHtml(limitWords(story.title, 16))}</p>
        <div class="pill">${escapeHtml(WATERMARK)}</div>
      </div>
    </section>
    <div class="watermark">${escapeHtml(WATERMARK)}</div>
    <div class="progress"><div class="progress-inner"></div></div>
    <audio id="background-music" data-start="0" data-duration="${totalSeconds}" data-track-index="10" data-volume="${backgroundVolume}" src="assets/background01.mp3"></audio>
    ${audioHtml}
  </div>
  <script>
    window.__hfDuration = ${totalSeconds};
    window.__hfFps = ${FPS};
    const timings = ${JSON.stringify(scenes.map((scene) => ({ start: scene.startSeconds, duration: scene.durationSeconds })))};
    const scenes = [...document.querySelectorAll(".scene")];
    const subtitleCues = [...document.querySelectorAll(".subtitle-cue")].map((element) => ({
      element,
      start: Number(element.dataset.start || 0),
      duration: Number(element.dataset.duration || 0)
    }));
    const outro = document.querySelector(".outro");
    const progress = document.querySelector(".progress-inner");
    let seek;

    const syncVideos = (time) => {
      scenes.forEach((scene, index) => {
        const video = document.getElementById("scene-video-" + String(index + 1).padStart(2, "0"));
        if (!video) return;
        const local = time - timings[index].start;
        const visible = local >= 0 && local <= timings[index].duration;
        const fade = ${TRANSITION_SECONDS};
        const opacity = visible ? Math.max(0, Math.min(1, local / fade, (timings[index].duration - local) / fade)) : 0;
        video.style.opacity = String(opacity);
        if (!visible) return;
        const duration = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : timings[index].duration;
        const target = duration > 0 ? local % duration : local;
        if (Math.abs((video.currentTime || 0) - target) > .08) {
          try { video.currentTime = target; } catch {}
        }
      });
    };

    const syncSubtitles = (time) => {
      subtitleCues.forEach(({ element, start, duration }) => {
        const local = time - start;
        const visible = local >= 0 && local <= duration;
        const fade = .14;
        const opacity = visible ? Math.max(0, Math.min(1, local / fade, (duration - local) / fade)) : 0;
        element.style.opacity = String(opacity);
        element.style.transform = "translateY(" + (12 * (1 - opacity)).toFixed(2) + "px)";
      });
    };

    if (window.gsap) {
      const master = gsap.timeline({ paused: true, defaults: { ease: "power3.out" } });
      window.__timelines = window.__timelines || {};
      window.__timelines.root = master;
      scenes.forEach((scene, index) => {
        const start = timings[index].start;
        const duration = timings[index].duration;
        const video = document.getElementById("scene-video-" + String(index + 1).padStart(2, "0"));
        const photo = scene.querySelector(".bg-photo") || video;
        master.fromTo(scene, { opacity: 0 }, { opacity: 1, duration: ${TRANSITION_SECONDS}, ease: "power2.out" }, start);
        if (photo) master.to(photo, { scale: 1.04, duration, ease: "none" }, start);
        master.to(scene, { opacity: 0, duration: ${TRANSITION_SECONDS}, ease: "power2.in" }, start + duration - ${TRANSITION_SECONDS});
      });
      master.to(outro, { opacity: 1, duration: .28 }, ${outroStart});
      master.fromTo(outro.querySelector(".outro-inner").children, { y: 50, opacity: 0, scale: .94 }, { y: 0, opacity: 1, scale: 1, stagger: .11, duration: .52, ease: "back.out(1.45)" }, ${outroStart} + .14);
      master.to(outro, { opacity: 0, duration: .22, ease: "power2.in" }, ${totalSeconds} - .22);
      master.to(progress, { width: "100%", duration: ${totalSeconds}, ease: "none" }, 0);
      seek = (t) => {
        const time = Math.max(0, Math.min(${totalSeconds}, t));
        master.time(time);
        syncVideos(time);
        syncSubtitles(time);
      };
    } else {
      const clamp = (n, min = 0, max = 1) => Math.max(min, Math.min(max, n));
      const easeOut = (t) => 1 - Math.pow(1 - clamp(t), 3);
      const easeIn = (t) => Math.pow(clamp(t), 3);
      seek = (time) => {
        const t = clamp(time, 0, ${totalSeconds});
        syncVideos(t);
        syncSubtitles(t);
        progress.style.width = (t / ${totalSeconds} * 100) + "%";
        scenes.forEach((scene, index) => {
          const local = t - timings[index].start;
          const duration = timings[index].duration;
          const visible = local >= 0 && local <= duration;
          let opacity = visible ? 1 : 0;
          if (visible) {
            opacity = Math.min(1, easeOut(local / ${TRANSITION_SECONDS}), 1 - easeIn((local - (duration - ${TRANSITION_SECONDS})) / ${TRANSITION_SECONDS}));
          }
          scene.style.opacity = String(opacity);
          scene.style.transform = "scale(" + (1 + .025 * easeIn((local - (duration - .32)) / .32)) + ")";
          const p = clamp(local / duration);
          const video = document.getElementById("scene-video-" + String(index + 1).padStart(2, "0"));
          const photo = scene.querySelector(".bg-photo") || video;
          if (photo) photo.style.transform = "scale(" + (1 + .04 * p) + ")";
          if (video) video.style.opacity = String(opacity);
        });
        const outroLocal = t - ${outroStart};
        outro.style.opacity = String(outroLocal >= 0 && outroLocal <= ${OUTRO_SECONDS} ? 1 : 0);
      };
    }

    window.__hyperframes = { duration: ${totalSeconds}, fps: ${FPS}, seek };
    window.__timelines = window.__timelines || {};
    window.__timelines.root = window.__timelines.root || { duration: ${totalSeconds}, seek };
    window.addEventListener("hf-seek", (event) => seek(event.detail?.time ?? 0));
    seek(0);
  </script>
</body>
</html>`;
}

function commandExists(command) {
  if (command.includes("/") || command.includes("\\")) return existsSync(command);
  const checker = process.platform === "win32" ? "where" : "which";
  const result = spawnSync(checker, [command], { encoding: "utf8" });
  return result.status === 0 && result.stdout.trim().length > 0;
}

function renderWithHyperframes(outDir) {
  if (!commandExists("npx")) {
    throw new Error("Cannot render: npx is not available. Install Node.js/npm or run `npm install -g hyperframes`.");
  }
  if (!commandExists("ffmpeg") || !commandExists("ffprobe")) {
    throw new Error("Cannot render: ffmpeg and ffprobe must be on PATH for HyperFrames rendering.");
  }
  const output = path.join(outDir, "final.mp4");
  const quality = process.env.HYPERFRAMES_QUALITY || "high";
  console.log(`[render] quality=${quality}, output=${output}`);
  const result = spawnSync("npx", ["hyperframes", "render", "--output", output, "--fps", String(FPS), "--quality", quality], {
    cwd: outDir,
    stdio: "inherit",
    shell: true
  });
  if (result.status !== 0) throw new Error(`HyperFrames render failed with exit code ${result.status}`);
  verifyOutput(output);
  return output;
}

function verifyOutput(output) {
  const result = spawnSync("ffprobe", [
    "-v", "error",
    "-select_streams", "v:0",
    "-show_entries", "stream=width,height,duration",
    "-of", "json",
    output
  ], { encoding: "utf8", shell: true });
  if (result.status !== 0) throw new Error("ffprobe verification failed.");
  const stream = JSON.parse(result.stdout).streams?.[0];
  if (!stream || Number(stream.width) !== WIDTH || Number(stream.height) !== HEIGHT) {
    throw new Error(`Unexpected output size: ${stream?.width}x${stream?.height}`);
  }
}

async function main() {
  const now = bangkokParts();
  const slot = currentSlot();
  const window = slotTimeWindow(slot);
  const outDir = path.resolve("outputs", "hot-story", now.date, slot);
  const assetDir = path.join(outDir, "assets");
  await mkdir(outDir, { recursive: true });
  await mkdir(assetDir, { recursive: true });
  const aiConfig = resolveAiConfig(process.env);
  const manualArticle = parseManualArticleUrl(HOT_STORY_FORCE_URL);

  if (window && !manualArticle) {
    const fromStr = new Date(window.from).toLocaleString("vi-VN", { timeZone: "Asia/Bangkok" });
    const toStr = new Date(window.to).toLocaleString("vi-VN", { timeZone: "Asia/Bangkok" });
    console.log(`[slot ${slot}] Loc tin tu ${fromStr} -> ${toStr}`);
  }

  const dedupeState = manualArticle ? null : await readDedupeState(DEDUPE_STATE, now.date);
  const candidates = [];
  const sourceStats = {};

  if (manualArticle) {
    const { url, source } = manualArticle;
    const forced = await loadForcedItem(url, source);
    candidates.push(forced);
    sourceStats.forced = {
      sourceName: source.name,
      sourceUrl: url,
      role: "forced",
      parsed: 1,
      afterDedupe: 1,
      selected: 1,
      skippedDuplicateCount: 0
    };
    console.log(`[source] Forced URL (${source.name}): ${url}`);
  } else {
    for (const source of [PRIMARY_SOURCE, ...FALLBACK_SOURCES]) {
      if (candidates.length >= CANDIDATE_COUNT) break;
      const result = await loadSourceItems(source, window);
      const fresh = dedupeItems(result.enriched, dedupeState, now.date, candidates);
      const selected = fresh.slice(0, CANDIDATE_COUNT - candidates.length);
      sourceStats[source.key] = {
        sourceName: source.name,
        sourceUrl: source.url,
        role: source.role,
        parsed: result.parsed.length,
        afterDedupe: fresh.length,
        selected: selected.length,
        skippedDuplicateCount: result.enriched.length - fresh.length
      };
      candidates.push(...selected);
      console.log(`[source] ${source.name}: parsed=${result.parsed.length}, fresh=${fresh.length}, selected=${selected.length}`);
    }
  }

  if (candidates.length === 0) {
    await writeFile(path.join(outDir, "skip.json"), JSON.stringify({
      generatedAt: new Date().toISOString(),
      slot,
      reason: "no_candidates",
      sourceStats
    }, null, 2), "utf8");
    return;
  }

  const normalizedCandidates = candidates.slice(0, CANDIDATE_COUNT).map((item, index) => ({
    ...item,
    index: index + 1,
    originalId: item.id,
    id: `candidate-${index + 1}`,
    hotScore: viralScore(item)
  }));

  const selection = await selectWithAi(normalizedCandidates, NEWS_SOURCES, { config: aiConfig });
  const story = normalizedCandidates.find((item) => item.id === selection.selectedId);
  if (!story) {
    throw new Error(`Validated Gemini selection references an unknown story: ${selection.selectedId}`);
  }

  let scenes = ensureSceneDurations(selection.scenes);
  scenes = assignSceneTimings(scenes);
  const contentSeconds = scenes.reduce((sum, scene) => sum + scene.durationSeconds, 0);
  const totalSeconds = contentSeconds + OUTRO_SECONDS;
  const ttsResult = await synthesizeStoryTts(story, selection, scenes, assetDir, contentSeconds);
  scenes = ttsResult.scenes;
  const narrationAudio = ttsResult.narrationAudio;

  const metadata = {
    source: PRIMARY_SOURCE.url,
    sources: NEWS_SOURCES.map((source) => ({ name: source.name, url: source.url, role: source.role })),
    generatedAt: new Date().toISOString(),
    timezone: "Asia/Bangkok",
    slot,
    width: WIDTH,
    height: HEIGHT,
    fps: FPS,
    durationSeconds: totalSeconds,
    backgroundAudio: BACKGROUND_AUDIO,
    watermark: WATERMARK,
    sourceStats,
    selection: {
      provider: selection.provider,
      model: selection.model,
      selectedId: selection.selectedId,
      hotScore: selection.hotScore,
      reason: selection.reason,
      angle: selection.angle,
      videoTitle: selection.videoTitle,
      voiceoverScript: selection.voiceoverScript,
      caption: selection.caption,
      hashtags: selection.hashtags
    },
    selectedStory: story,
    media: [],
    images: [],
    mediaDownloadErrors: [],
    visualSource: "hyperframes-code-native",
    scenes,
    narrationAudio,
    candidates: normalizedCandidates.map((item) => ({
      id: item.id,
      title: item.title,
      link: item.link,
      sourceName: item.sourceName,
      pubDate: item.pubDate,
      category: item.category,
      summary: item.summary,
      hotScore: item.hotScore,
      mediaCount: item.mediaCandidates?.length || 0,
      imageCount: item.mediaCandidates?.filter((candidate) => candidate.type === "image").length || 0,
      videoCount: item.mediaCandidates?.filter((candidate) => candidate.type === "video").length || 0
    })),
    hookTts: {
      enabled: HOOK_TTS_ENABLED,
      provider: HOOK_TTS_PROVIDER,
      mode: VIENEU_MODE,
      volume: HOOK_TTS_VOLUME,
      backgroundVolume: narrationAudio ? BACKGROUND_VOLUME_WITH_TTS : BACKGROUND_VOLUME,
      style: "single-track"
    }
  };

  const html = renderHotStoryComposition({
    selection,
    scenes,
    totalSeconds,
    narrationAudio,
    publicDate: formatPubDate(story.pubDate),
    width: WIDTH,
    height: HEIGHT,
    fps: FPS,
    outroSeconds: OUTRO_SECONDS,
    transitionSeconds: TRANSITION_SECONDS,
    watermark: WATERMARK,
    backgroundVolume: narrationAudio ? BACKGROUND_VOLUME_WITH_TTS : BACKGROUND_VOLUME,
    narrationVolume: HOOK_TTS_VOLUME
  });
  await writeFile(path.join(outDir, "index.html"), html, "utf8");
  await writeFile(path.join(outDir, "news.json"), JSON.stringify(metadata, null, 2), "utf8");
  await writeFile(path.join(outDir, "hot-story-selection.json"), JSON.stringify(metadata.selection, null, 2), "utf8");

  if (existsSync(BACKGROUND_AUDIO)) {
    await copyFile(BACKGROUND_AUDIO, path.join(assetDir, "background01.mp3"));
  } else if (!skipRender) {
    throw new Error(`Background audio does not exist: ${BACKGROUND_AUDIO}`);
  } else {
    console.warn(`[audio] Khong tim thay background audio: ${BACKGROUND_AUDIO}. Bo qua vi dang --skip-render.`);
  }

  const caption = selection.caption;
  await writeCaption(outDir, caption);

  let output = path.join(outDir, "final.mp4");
  if (!skipRender) output = renderWithHyperframes(outDir);

  if (uploadRequested || dryRunUpload) {
    if (!dryRunUpload && skipRender && !existsSync(output)) {
      throw new Error(`Cannot upload because final.mp4 does not exist: ${output}`);
    }
    await uploadToPlatforms({
      outDir,
      videoPath: output,
      dryRun: dryRunUpload,
      caption,
      title: selection.videoTitle,
      tags: unique([...(selection.hashtags || []), "tin tức", "shorts"].map((tag) => tag.replace(/^#/, "")))
    });
  }

  if (dryRunUpload) {
    console.log("[dedupe] Dry-run upload: khong luu state chong trung tin.");
  } else if (!uploadRequested) {
    console.log("[dedupe] Khong upload: khong luu state chong trung tin.");
  } else {
    await writeDedupeState(DEDUPE_STATE, now.date, slot, [story]);
    await writeDedupeUpdatedMarker(DEDUPE_UPDATED_MARKER, now.date, slot, [story]);
  }

  console.log(`Generated hot story package: ${outDir}`);
  if (skipRender) console.log("Render skipped. Run without --skip-render after HyperFrames, npx, ffmpeg, and ffprobe are available.");
}

main().catch(async (error) => {
  const now = bangkokParts();
  const slot = currentSlot();
  const outDir = path.resolve("outputs", "hot-story", now.date, slot);
  await mkdir(outDir, { recursive: true });
  await writeFile(path.join(outDir, "error.log"), `${new Date().toISOString()}\n${error.stack || error.message}\n`, "utf8");
  console.error(error.message);
  process.exit(1);
});
