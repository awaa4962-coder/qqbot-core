// bridge/services/link-preview/index.mjs - unified link preview entrypoint.
import { CFG } from "../../config.mjs";
import { isBilibiliUrl, fetchBilibiliInfo } from "./bilibili.mjs";
import { isGitHubRepositoryUrl, fetchGitHubRepositoryInfo } from "./github.mjs";
import { fetchPageMeta } from "./generic-page.mjs";
import { getLinkPreviewStatus, recordLinkPreview } from "./status.mjs";

export { isBilibiliUrl } from "./bilibili.mjs";
export {
  fetchGitHubRepositoryInfo,
  isGitHubRepositoryUrl,
  normalizeGitHubRepository,
  parseGitHubRepositoryUrl,
  resetGitHubPreviewCache,
} from "./github.mjs";
export { safeFetch, safeFetchPage } from "./safe-fetch.mjs";
export {
  inspectAutoPreview,
  extractPreviewUrls,
  markAutoPreviewSent,
  previewAddsValue,
  resetAutoPreviewPolicy,
} from "./policy.mjs";
export { resolvePreviewImage, resetPreviewImageCache } from "./image-proxy.mjs";
export { getLinkPreviewStatus, recordLinkPreviewSkip, resetLinkPreviewStatus } from "./status.mjs";

export async function extractLinkPreview(url) {
  if (!CFG.linkPreviewEnabled) return null;

  const kind = detectPreviewKind(url);
  try {
    const resolved = await fetchPreviewByKind(kind, url);
    recordLinkPreview(resolved.kind, resolved.result);
    const result = resolved.result;
    return result;
  } catch (error) {
    recordLinkPreview(kind, null, error.message);
    return null;
  }
}

function detectPreviewKind(url) {
  if (isBilibiliUrl(url)) return "bilibili";
  if (isGitHubRepositoryUrl(url)) return "github";
  return "generic";
}

async function fetchPreviewByKind(kind, url) {
  if (kind === "bilibili") return { kind, result: await fetchBilibiliInfo(url) };
  if (kind !== "github") return { kind, result: await fetchPageMeta(url) };
  const result = await fetchGitHubRepositoryInfo(url);
  if (result) return { kind, result };
  return { kind: "generic", result: await fetchPageMeta(url) };
}

export function linkPreviewStatus() {
  return getLinkPreviewStatus({ enabled: CFG.linkPreviewEnabled });
}
