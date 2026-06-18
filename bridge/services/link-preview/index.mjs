// bridge/services/link-preview/index.mjs — 链接预览统一入口
import { isBilibiliUrl, fetchBilibiliInfo } from "./bilibili.mjs";
import { fetchPageMeta } from "./generic-page.mjs";

export { isBilibiliUrl } from "./bilibili.mjs";
export { safeFetch } from "./safe-fetch.mjs";

/**
 * 统一链接预览提取（B站 + 通用网页）
 * @param {string} url
 * @returns {Promise<{text:string, image:string|null}|null>}
 */
export async function extractLinkPreview(url) {
  if (isBilibiliUrl(url)) {
    return fetchBilibiliInfo(url);
  }
  return fetchPageMeta(url);
}
