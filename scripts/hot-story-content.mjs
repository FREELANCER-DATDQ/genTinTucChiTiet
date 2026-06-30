const VISUAL_TYPES = new Set([
  "kinetic-headline",
  "stat-card",
  "bar-chart",
  "timeline",
  "comparison",
  "process",
  "key-points"
]);

const BYLINE_MARKERS = [
  /\b(?:tác giả|phóng viên|biên tập(?: viên)?|người viết|theo nguồn|nguồn tin)\b/iu,
  /(?:^|\n)\s*(?:ảnh|video|đồ họa|thực hiện|biên dịch|nguồn)\s*:/imu,
  /\b(?:all rights reserved|bản quyền thuộc)\b/iu
];

function escapeRegExp(value = "") {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function hostnameFrom(value = "") {
  try {
    return new URL(value).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

export function sourceIdentifiers(items = [], configuredSources = []) {
  const values = [];
  for (const source of configuredSources) {
    values.push(source?.name, source?.domain, hostnameFrom(source?.url));
  }
  for (const item of items) {
    values.push(item?.sourceName, hostnameFrom(item?.sourceUrl), hostnameFrom(item?.link));
  }
  return unique(values.map((value) => String(value || "").trim()).filter((value) => value.length >= 3));
}

export function sanitizeArticleText(value = "", identifiers = []) {
  const sourcePatterns = identifiers
    .filter(Boolean)
    .map((identifier) => new RegExp(escapeRegExp(identifier), "giu"));
  const rejectedLine = /^(?:tác giả|phóng viên|biên tập(?: viên)?|người viết|ảnh|video|đồ họa|thực hiện|biên dịch|nguồn|theo)\s*:/iu;
  return String(value || "")
    .replace(/https?:\/\/\S+|www\.\S+/giu, " ")
    .split(/\r?\n+/)
    .map((line) => line.trim())
    .filter((line) => line && !rejectedLine.test(line) && !/all rights reserved|bản quyền thuộc/iu.test(line))
    .map((line) => sourcePatterns.reduce((clean, pattern) => clean.replace(pattern, " "), line))
    .map((line) => line.replace(/\s+/g, " ").replace(/\s+([,.;:!?])/g, "$1").trim())
    .filter(Boolean)
    .join("\n");
}

function limitWords(value, maxWords) {
  const words = String(value || "").replace(/\s+/g, " ").trim().split(/\s+/).filter(Boolean);
  return words.length <= maxWords ? words.join(" ") : `${words.slice(0, maxWords).join(" ")}...`;
}

export function limitTextByWords(value, maxWords) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length <= maxWords) return text;
  const sentences = text.match(/[^.!?。！？]+[.!?。！？]+|[^.!?。！？]+$/g) || [text];
  const kept = [];
  let count = 0;
  for (const sentence of sentences) {
    const clean = sentence.trim();
    const sentenceWords = clean.split(/\s+/).filter(Boolean).length;
    if (count + sentenceWords > maxWords) break;
    kept.push(clean);
    count += sentenceWords;
  }
  if (kept.length) return kept.join(" ");
  return words.slice(0, maxWords).join(" ").replace(/[,:;]*$/, ".");
}

export function countWords(value = "") {
  return String(value).trim().split(/\s+/).filter(Boolean).length;
}

export function geminiSchema() {
  return {
    type: "object",
    properties: {
      selectedId: { type: "string" },
      hotScore: { type: "integer" },
      reason: { type: "string" },
      angle: { type: "string" },
      videoTitle: { type: "string" },
      voiceoverScript: { type: "string" },
      caption: { type: "string" },
      hashtags: { type: "array", items: { type: "string" } },
      scenes: {
        type: "array",
        items: {
          type: "object",
          properties: {
            label: { type: "string" },
            headline: { type: "string" },
            body: { type: "string" },
            narration: { type: "string" },
            visualType: {
              type: "string",
              enum: [...VISUAL_TYPES]
            },
            visualTitle: { type: "string" },
            visualPrimary: { type: "string" },
            visualSecondary: { type: "string" },
            visualItems: {
              type: "array",
              items: { type: "string" }
            },
            chartData: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  label: { type: "string" },
                  value: { type: "number" },
                  displayValue: { type: "string" }
                },
                required: ["label", "value", "displayValue"]
              }
            },
            durationSeconds: { type: "integer" }
          },
          required: [
            "label", "headline", "body", "narration", "visualType", "visualTitle",
            "visualPrimary", "visualSecondary", "visualItems", "chartData", "durationSeconds"
          ]
        }
      }
    },
    required: ["selectedId", "hotScore", "reason", "angle", "videoTitle", "voiceoverScript", "caption", "hashtags", "scenes"]
  };
}

export function geminiPrompt(items, identifiers = []) {
  const candidates = items.map((item) => ({
    id: item.id,
    title: sanitizeArticleText(item.title, identifiers),
    summary: sanitizeArticleText(item.summary, identifiers),
    category: sanitizeArticleText(item.category, identifiers),
    pubDate: item.pubDate,
    articleText: limitWords(sanitizeArticleText(item.articleText, identifiers), 1400)
  }));
  return `Bạn là biên tập viên video tin tức tiếng Việt. Chọn đúng một tin đáng chú ý nhất để làm video dọc 60-90 giây.

YÊU CẦU BẮT BUỘC:
- Viết lại thành một bản tin độc lập bằng cách tổng hợp dữ kiện, thay đổi cấu trúc và câu chữ; không sao chép tiêu đề hoặc câu văn dài.
- Không nhắc tên báo, trang tin, tên miền, URL, phóng viên, tác giả, biên tập viên, người chụp ảnh hoặc nguồn bài viết.
- Được giữ tên cơ quan, doanh nghiệp và nhân vật khi họ là chủ thể cần thiết của sự kiện.
- Không thêm dữ kiện ngoài nội dung đã cung cấp. Không suy đoán. Không biến nhận định thành sự thật.
- voiceoverScript phải là một bản đọc liền mạch 170-220 từ, không chia cảnh và không có câu dẫn nguồn bài báo.
- caption phải tự đứng độc lập, không có mục "Nguồn", URL hay hashtag tên báo.
- Tạo 6-7 cảnh. Mỗi cảnh dùng một visualType trong schema để HyperFrames tự vẽ bằng HTML/CSS/SVG.
- Chỉ dùng stat-card hoặc bar-chart khi dữ kiện có số liệu chính xác. chartData.value phải là số thực sự xuất hiện trong dữ kiện; displayValue giữ đơn vị gốc. Nếu không có số liệu phù hợp, dùng timeline, process, comparison, key-points hoặc kinetic-headline.
- visualItems tối đa 5 ý ngắn. Không chèn HTML, markdown hoặc URL vào bất kỳ trường nào.

Tiêu chí chọn tin: mới, tác động rộng, có diễn biến hoặc dữ kiện rõ, phù hợp Shorts/Reels/TikTok. Không chọn chỉ vì giật gân.

Danh sách ứng viên đã được làm sạch:
${JSON.stringify(candidates, null, 2)}`;
}

function normalizeChartData(chartData) {
  if (!Array.isArray(chartData)) return [];
  return chartData.slice(0, 5).map((item) => ({
    label: limitWords(item?.label, 6),
    value: Number(item?.value),
    displayValue: limitWords(item?.displayValue, 5)
  })).filter((item) => item.label && Number.isFinite(item.value) && item.value >= 0);
}

export function normalizeSelection(selection = {}) {
  const scenes = Array.isArray(selection.scenes) ? selection.scenes.slice(0, 7) : [];
  const normalizedScenes = scenes.map((scene, index) => {
    let visualType = VISUAL_TYPES.has(scene?.visualType) ? scene.visualType : "key-points";
    const chartData = normalizeChartData(scene?.chartData);
    const visualItems = Array.isArray(scene?.visualItems)
      ? scene.visualItems.map((item) => limitWords(item, 12)).filter(Boolean).slice(0, 5)
      : [];
    if (visualType === "bar-chart" && chartData.length < 2) visualType = "key-points";
    if (["timeline", "comparison", "process", "key-points"].includes(visualType) && visualItems.length < 2) {
      visualItems.push(...[scene?.headline, scene?.body].map((item) => limitWords(item, 12)).filter(Boolean));
    }
    return {
      label: limitWords(scene?.label || `Cảnh ${index + 1}`, 4).toUpperCase(),
      headline: limitWords(scene?.headline, 16),
      body: limitWords(scene?.body || scene?.narration, 38),
      narration: limitWords(scene?.narration || scene?.body || scene?.headline, 55),
      visualType,
      visualTitle: limitWords(scene?.visualTitle || scene?.headline, 10),
      visualPrimary: limitWords(scene?.visualPrimary, 8),
      visualSecondary: limitWords(scene?.visualSecondary, 12),
      visualItems: unique(visualItems).slice(0, 5),
      chartData,
      durationSeconds: Math.max(8, Math.min(13, Number(scene?.durationSeconds) || 10))
    };
  });
  return {
    ...selection,
    hotScore: Math.max(0, Math.min(100, Number(selection.hotScore) || 0)),
    videoTitle: limitWords(selection.videoTitle, 16),
    voiceoverScript: limitTextByWords(selection.voiceoverScript, 220),
    caption: String(selection.caption || "").trim(),
    hashtags: Array.isArray(selection.hashtags) ? selection.hashtags.slice(0, 8).map(String) : [],
    scenes: normalizedScenes
  };
}

function publicFields(selection = {}) {
  return [
    selection.videoTitle,
    selection.voiceoverScript,
    selection.caption,
    ...(selection.hashtags || []),
    ...(selection.scenes || []).flatMap((scene) => [
      scene.label,
      scene.headline,
      scene.body,
      scene.narration,
      scene.visualTitle,
      scene.visualPrimary,
      scene.visualSecondary,
      ...(scene.visualItems || []),
      ...(scene.chartData || []).flatMap((item) => [item.label, item.displayValue])
    ])
  ].filter(Boolean).join("\n");
}

export function validatePublicSelection(selection, items = [], identifiers = []) {
  const violations = [];
  const text = publicFields(selection);
  if (!items.some((item) => item.id === selection.selectedId)) violations.push("selectedId không thuộc danh sách ứng viên");
  if (!Array.isArray(selection.scenes) || selection.scenes.length < 6 || selection.scenes.length > 7) violations.push("phải có 6-7 cảnh");
  const voiceWords = countWords(selection.voiceoverScript);
  if (voiceWords < 170 || voiceWords > 220) violations.push(`voiceoverScript có ${voiceWords} từ, yêu cầu 170-220 từ`);
  if (!String(selection.videoTitle || "").trim()) violations.push("thiếu videoTitle công khai");
  if (!String(selection.caption || "").trim()) violations.push("thiếu caption công khai");
  if (!Array.isArray(selection.hashtags) || selection.hashtags.length < 3) violations.push("phải có ít nhất 3 hashtag");
  if (/https?:\/\/|www\.|\b[a-z0-9-]+\.(?:vn|com|net|org)(?:\b|\/)/iu.test(text)) violations.push("có URL hoặc tên miền trong đầu ra công khai");
  for (const marker of BYLINE_MARKERS) {
    if (marker.test(text)) {
      violations.push("có dấu hiệu byline/tác giả/nguồn trong đầu ra công khai");
      break;
    }
  }
  for (const identifier of identifiers) {
    if (new RegExp(`(?:^|[^\\p{L}\\p{N}])${escapeRegExp(identifier)}(?:$|[^\\p{L}\\p{N}])`, "iu").test(text)) {
      violations.push(`có định danh nguồn công khai: ${identifier}`);
    }
  }
  if ((selection.hashtags || []).some((tag) => /vnexpress|vietnamnet/i.test(tag))) violations.push("có hashtag tên báo");
  for (const [index, scene] of (selection.scenes || []).entries()) {
    if (!VISUAL_TYPES.has(scene.visualType)) violations.push(`cảnh ${index + 1} có visualType không hợp lệ`);
    if (scene.visualType === "bar-chart" && (!scene.chartData || scene.chartData.length < 2)) violations.push(`cảnh ${index + 1} thiếu dữ liệu biểu đồ`);
  }
  return unique(violations);
}

export function correctionPrompt(previousSelection, violations) {
  return `Kết quả trước chưa đạt các điều kiện sau:\n- ${violations.join("\n- ")}\n\nHãy trả lại toàn bộ JSON đã sửa theo đúng schema. Không giải thích, không thêm markdown. Giữ nguyên dữ kiện, nhưng loại mọi dấu vết nguồn và bảo đảm voiceover 170-220 từ.\n\nJSON trước:\n${JSON.stringify(previousSelection, null, 2)}`;
}

export { VISUAL_TYPES };
