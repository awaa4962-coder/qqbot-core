import { safeFetch } from "./safe-fetch.mjs";
import { validateSafeUrl } from "../../safe-url.mjs";

const MAX_TITLE_LENGTH = 180;
const MAX_DESC_LENGTH = 160;

function decodeHtmlEntities(value) {
  return String(value || "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_match, code) => {
      const n = Number(code);
      return Number.isFinite(n) ? String.fromCodePoint(n) : "";
    })
    .replace(/&#x([0-9a-f]+);/gi, (_match, code) => {
      const n = parseInt(code, 16);
      return Number.isFinite(n) ? String.fromCodePoint(n) : "";
    })
    .replace(/\s+/g, " ")
    .trim();
}

function isBilibiliLink(url) {
  return url.includes("bilibili.com") || url.includes("b23.tv");
}

export function extractTitle(html) {
  return firstMeta(html, [
    ["property", "og:title"],
    ["name", "twitter:title"],
    ["itemprop", "name"],
  ]) || html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.trim() || "";
}

export function extractDescription(html) {
  return firstMeta(html, [
    ["property", "og:description"],
    ["name", "description"],
    ["name", "twitter:description"],
  ]);
}

function extractImage(html) {
  return firstMeta(html, [
    ["property", "og:image"],
    ["property", "og:image:url"],
    ["name", "twitter:image"],
  ]);
}

function extractSiteName(html, baseUrl) {
  const siteName = firstMeta(html, [
    ["property", "og:site_name"],
    ["name", "application-name"],
  ]);
  if (siteName) return siteName;
  try {
    return new URL(baseUrl || "").hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

function extractCanonicalUrl(html, baseUrl) {
  const canonical = firstLink(html, ["canonical", "alternate"]);
  return normalizeSafeLink(canonical, baseUrl) || normalizeSafeLink(baseUrl, "");
}

function extractFavicon(html, baseUrl) {
  return normalizeSafeLink(firstLink(html, ["icon", "shortcut icon", "apple-touch-icon"]), baseUrl);
}

function firstMeta(html, selectors) {
  for (const [attr, value] of selectors) {
    const content = metaContentByAttr(html, attr, value);
    if (content) return content;
  }
  return "";
}

function metaContentByAttr(html, attr, value) {
  const tags = String(html || "").match(/<meta\b[^>]*>/gi) || [];
  for (const tag of tags) {
    if (attrValue(tag, attr).toLowerCase() !== value.toLowerCase()) continue;
    const content = attrValue(tag, "content");
    if (content) return content;
  }
  return "";
}

function firstLink(html, rels) {
  const tags = String(html || "").match(/<link\b[^>]*>/gi) || [];
  for (const rel of rels) {
    for (const tag of tags) {
      const relsInTag = attrValue(tag, "rel").toLowerCase().split(/\s+/);
      if (!relsInTag.includes(rel.toLowerCase())) continue;
      const href = attrValue(tag, "href");
      if (href) return href;
    }
  }
  return "";
}

function attrValue(tag, attr) {
  const pattern = new RegExp("\\b" + attr + "\\s*=\\s*(?:\"([^\"]*)\"|'([^']*)'|([^\\s>]+))", "i");
  const match = String(tag || "").match(pattern);
  return match ? decodeHtmlEntities(match[1] || match[2] || match[3] || "") : "";
}

function normalizeSafeImageUrl(imageUrl, baseUrl) {
  return normalizeSafeLink(imageUrl, baseUrl);
}

function normalizeSafeLink(link, baseUrl) {
  if (!link) return null;
  try {
    const resolved = baseUrl ? new URL(link, baseUrl) : new URL(link);
    const safe = validateSafeUrl(resolved);
    return safe.ok ? safe.url.href : null;
  } catch {
    return null;
  }
}

function clipText(text, maxLength) {
  const clean = decodeHtmlEntities(text);
  return clean.length > maxLength ? clean.slice(0, maxLength - 1).trimEnd() + "..." : clean;
}

function buildPreviewText(meta) {
  const parts = ["Link: " + meta.title];
  if (meta.siteName) parts.push("Site: " + meta.siteName);
  if (meta.description) parts.push(meta.description);
  if (meta.url) parts.push(meta.url);
  return parts.join("\n");
}

export function normalizePageMeta(html, options = {}) {
  const title = clipText(extractTitle(html), MAX_TITLE_LENGTH);
  if (!title) return null;

  const description = clipText(extractDescription(html), MAX_DESC_LENGTH);
  const siteName = clipText(extractSiteName(html, options.baseUrl), 80);
  const url = extractCanonicalUrl(html, options.baseUrl);

  return {
    text: buildPreviewText({ title, siteName, description, url }),
    image: normalizeSafeImageUrl(extractImage(html), options.baseUrl),
    favicon: extractFavicon(html, options.baseUrl),
    title,
    description,
    siteName,
    url,
  };
}

export async function fetchPageMeta(url) {
  if (isBilibiliLink(url)) return null;

  const html = await safeFetch(url);
  if (!html) return null;

  return normalizePageMeta(html, { baseUrl: url });
}
