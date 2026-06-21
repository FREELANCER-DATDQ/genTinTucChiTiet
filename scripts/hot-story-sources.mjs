export const NEWS_SOURCES = [
  {
    role: "primary",
    key: "vnexpress",
    name: "VnExpress",
    domain: "vnexpress.net",
    url: "https://vnexpress.net/rss/tin-noi-bat.rss"
  },
  {
    role: "fallback",
    key: "vietnamnet",
    name: "Vietnamnet",
    domain: "vietnamnet.vn",
    url: "https://vietnamnet.vn/tin-tuc-24h.rss"
  }
];

function hostnameMatches(hostname, domain) {
  return hostname === domain || hostname.endsWith(`.${domain}`);
}

export function parseManualArticleUrl(value) {
  const rawUrl = String(value || "").trim();
  if (!rawUrl) return null;

  let articleUrl;
  try {
    articleUrl = new URL(rawUrl);
  } catch {
    throw new Error("Link bài báo không hợp lệ. Vui lòng nhập URL HTTPS đầy đủ.");
  }

  if (articleUrl.protocol !== "https:") {
    throw new Error("Link bài báo phải sử dụng HTTPS.");
  }

  if (articleUrl.username || articleUrl.password) {
    throw new Error("Link bài báo không được chứa thông tin đăng nhập.");
  }

  const hostname = articleUrl.hostname.toLowerCase().replace(/\.$/, "");
  const knownSource = NEWS_SOURCES.find((candidate) => hostnameMatches(hostname, candidate.domain));
  const displayHostname = hostname.replace(/^www\./, "");
  const source = knownSource || {
    role: "manual",
    key: displayHostname.replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""),
    name: displayHostname,
    domain: displayHostname,
    url: articleUrl.origin
  };

  articleUrl.hash = "";
  return { url: articleUrl.href, source };
}
