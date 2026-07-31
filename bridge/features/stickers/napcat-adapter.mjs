// NapCat custom-face API adapter. All callers receive normalized results.

import { CFG } from "../../config.mjs";

const DEFAULT_TIMEOUT_MS = 15000;

export async function detectStickerCapabilities(options = {}) {
  const fetchImpl = options.fetchImpl || fetch;
  const version = await postNapCat("get_version_info", {}, { ...options, fetchImpl });
  const details = await postNapCat("fetch_custom_face_detail", { count: 1 }, { ...options, fetchImpl });
  const legacy = details.ok
    ? { ok: true }
    : await postNapCat("fetch_custom_face", { count: 1 }, { ...options, fetchImpl });
  return {
    ok: version.ok || legacy.ok,
    version: normalizeVersion(version.data),
    fetch: legacy.ok,
    detail: details.ok,
    add: details.ok,
    delete: details.ok,
    description: details.ok,
    mode: details.ok ? "cloud" : legacy.ok ? "legacy-url" : "unsupported",
    error: details.ok || legacy.ok ? "" : details.error || legacy.error,
  };
}

export async function fetchFavoriteStickers(options = {}) {
  const count = boundedCount(options.count);
  const response = await postNapCat("fetch_custom_face", { count }, options);
  return {
    ok: response.ok,
    items: response.ok ? normalizeFavoritePayload(response.data) : [],
    error: response.error,
  };
}

export async function fetchFavoriteStickerDetails(options = {}) {
  const count = boundedCount(options.count);
  const response = await postNapCat("fetch_custom_face_detail", { count }, options);
  return {
    ok: response.ok,
    items: response.ok ? normalizeFavoritePayload(response.data) : [],
    error: response.error,
  };
}

export async function addCustomFace(file, options = {}) {
  const response = await postNapCat("add_custom_face", {
    file: String(file || ""),
    file_name: options.fileName || undefined,
    file_size: options.fileSize || undefined,
    md5: options.md5 || undefined,
    is_origin: options.isOrigin !== false,
  }, options);
  return {
    ok: response.ok,
    data: response.data,
    error: response.error,
  };
}

export async function deleteCustomFace(ids, options = {}) {
  const values = (Array.isArray(ids) ? ids : [ids]).map(String).filter(Boolean);
  if (!values.length) return { ok: false, error: "缺少 QQ 收藏资源 ID" };
  const response = await postNapCat("delete_custom_face", { ids: values }, options);
  return { ok: response.ok, data: response.data, error: response.error };
}

export async function setCustomFaceDescription(item = {}, description = "", options = {}) {
  const response = await postNapCat("set_custom_face_desc", {
    emoji_id: item.emojiId,
    res_id: item.resId,
    md5: item.md5,
    desc: String(description || "").slice(0, 120),
  }, options);
  return { ok: response.ok, data: response.data, error: response.error };
}

export async function postNapCat(action, params = {}, options = {}) {
  const fetchImpl = options.fetchImpl || fetch;
  try {
    const response = await fetchImpl(CFG.napcatApi.replace(/\/+$/, "") + "/" + action, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify(compactObject(params)),
      signal: AbortSignal.timeout(Number(options.timeoutMs || DEFAULT_TIMEOUT_MS)),
    });
    return normalizeNapCatResponse(action, response, await response.json());
  } catch (error) {
    return { ok: false, data: null, error: error.message, status: 0, retcode: -1 };
  }
}

function normalizeNapCatResponse(action, response, payload) {
  const apiFailed = Boolean(payload?.status && payload.status !== "ok");
  const retcode = Number(payload?.retcode || 0);
  const ok = response.ok && !apiFailed && retcode === 0;
  return {
    ok,
    data: payload?.data,
    error: ok ? "" : firstText(payload?.message, payload?.wording, "NapCat " + action + " 接口失败"),
    status: response.status,
    retcode,
  };
}

export function normalizeFavoritePayload(value) {
  const list = Array.isArray(value)
    ? value
    : Array.isArray(value?.emojiInfoList)
      ? value.emojiInfoList
      : [];
  return list
    .map(normalizeFavoriteItem)
    .filter(item => item?.url);
}

function normalizeFavoriteItem(item) {
  if (typeof item === "string") return { url: item };
  if (!item || typeof item !== "object") return null;
  return {
    url: firstText(
      item.url,
      item.originalUrl,
      item.originUrl,
      item.thumbUrl,
      item.thumbnailUrl,
      item.downloadUrl,
      item.file
    ),
    emojiId: firstText(item.emojiId, item.emoji_id, item.id),
    packageId: firstText(item.packageId, item.emoji_package_id, item.package_id),
    key: firstText(item.key, item.faceKey, item.resourceKey),
    resId: firstText(item.resId, item.res_id, item.resourceId),
    md5: firstText(item.md5, item.fileMd5, item.file_md5).toLowerCase(),
    summary: firstText(item.desc, item.summary, item.description),
  };
}

function normalizeVersion(value) {
  const source = value && typeof value === "object" ? value : {};
  return {
    appName: firstText(source.app_name, source.appName),
    appVersion: firstText(source.app_version, source.appVersion, source.version),
    protocolVersion: firstText(source.protocol_version, source.protocolVersion),
  };
}

function boundedCount(value) {
  return Math.max(1, Math.min(500, Number(value || CFG.stickerFetchCount || 100)));
}

function compactObject(value) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}

function firstText(...values) {
  for (const value of values) {
    const text = String(value ?? "").trim();
    if (text) return text;
  }
  return "";
}
