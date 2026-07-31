// bridge/services/link-preview/index.mjs - unified link preview entrypoint.
import { CFG } from "../../config.mjs";
import { isBilibiliUrl, fetchBilibiliInfo } from "./bilibili.mjs";
import { fetchPageMeta } from "./generic-page.mjs";
import { getLinkPreviewStatus, recordLinkPreview } from "./status.mjs";

export { isBilibiliUrl } from "./bilibili.mjs";
export { safeFetch } from "./safe-fetch.mjs";
export { getLinkPreviewStatus, resetLinkPreviewStatus } from "./status.mjs";

export async function extractLinkPreview(url) {
  if (!CFG.linkPreviewEnabled) return null;

  const kind = isBilibiliUrl(url) ? "bilibili" : "generic";
  try {
    const result = kind === "bilibili" ? await fetchBilibiliInfo(url) : await fetchPageMeta(url);
    recordLinkPreview(kind, result);
    return result;
  } catch (error) {
    recordLinkPreview(kind, null, error.message);
    return null;
  }
}

export function linkPreviewStatus() {
  return getLinkPreviewStatus({ enabled: CFG.linkPreviewEnabled });
}
