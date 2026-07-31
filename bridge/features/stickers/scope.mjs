import { CFG } from "../../config.mjs";

export function resolveStickerAllowedGroups(settings = {}) {
  const configured = Array.isArray(settings.allowedGroups)
    ? settings.allowedGroups.map(Number).filter(Number.isSafeInteger)
    : [];
  return configured.length ? configured : CFG.stickerGroupWhitelist;
}
