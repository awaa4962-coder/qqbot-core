export const STICKER_MODULE_MANIFEST = Object.freeze({
  id: "stickers",
  name: "QQ 收藏表情",
  entrypoint: "bridge/features/stickers/index.mjs",
  source: "NapCat v4.18.13 custom-face APIs and allowlisted group images",
  storage: ".qqfriend/stickers/catalog.json",
  storesImages: false,
  capabilities: [
    "favorite sync",
    "group candidate capture",
    "QQ cloud-favorite promotion",
    "perceptual deduplication",
    "salted sender deduplication",
    "temporary upload cleanup",
    "incremental vision labels",
    "context selection",
    "group and private sending",
  ],
});
