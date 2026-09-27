import { getMemoryPrivacyGeneration, getUserMemoryGeneration } from "../../memory-profile/generation.mjs";

export function createStickerPrivacyGuard(userId) {
  const privacy = getMemoryPrivacyGeneration();
  const user = getUserMemoryGeneration(userId);
  return () => {
    if (privacy !== getMemoryPrivacyGeneration() || user !== getUserMemoryGeneration(userId)) {
      throw Object.assign(new Error("privacy_changed"), { code: "STICKER_PRIVACY_CHANGED" });
    }
  };
}
