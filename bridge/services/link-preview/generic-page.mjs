// bridge/services/link-preview/generic-page.mjs — 通用网页 OG 元数据提取
import { safeFetch } from "./safe-fetch.mjs";

function decodeHtmlEntities(s) {
  return s
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"").replace(/&#x27;/g, "'").replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ").trim();
}

/**
 * 提取通用网页的 OG 元数据
 * @returns {{text:string, image:string|null}|null}
 */
export async function fetchPageMeta(url) {
  if (url.includes("bilibili.com") || url.includes("b23.tv")) return null; // 交给 bilibili 模块

  const html = await safeFetch(url);
  if (!html) return null;

  const ogTitle = html.match(/<meta[^>]+property="og:title"[^>]+content="([^"]*)"/i)?.[1] || "";
  const twTitle = html.match(/<meta[^>]+name="twitter:title"[^>]+content="([^"]*)"/i)?.[1] || "";
  const pageTitle = html.match(/<title>([^<]*)<\/title>/i)?.[1]?.trim() || "";
  const ogDesc = html.match(/<meta[^>]+property="og:description"[^>]+content="([^"]*)"/i)?.[1] || "";
  const metaDesc = html.match(/<meta[^>]+name="description"[^>]+content="([^"]*)"/i)?.[1] || "";
  const ogImg = html.match(/<meta[^>]+property="og:image"[^>]+content="([^"]*)"/i)?.[1] || "";

  const title = ogTitle || twTitle || pageTitle;
  const desc = ogDesc || metaDesc;

  if (!title) return null;

  const parts = ["🔗 " + decodeHtmlEntities(title)];
  if (desc) parts.push(decodeHtmlEntities(desc).slice(0, 120));

  return { text: parts.join("\n"), image: ogImg || null };
}
