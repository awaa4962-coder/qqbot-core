import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import fs from "node:fs";
import test from "node:test";
import sharp from "sharp";
import { perceptualImageHash } from "../bridge/knowledge/memes/image-context.mjs";
import { classifyStickerCandidate } from "../bridge/features/stickers/image-classifier.mjs";
import { renderWordcloudPng } from "../bridge/features/wordcloud/index.mjs";

function sourceImage(pages = 1) {
  const pixels = Buffer.alloc(64 * 64 * pages * 3);
  for (let index = 0; index < pixels.length; index += 3) {
    const shade = Math.floor(index / 3) % 64 * 4;
    pixels.fill(shade, index, index + 3);
  }
  return sharp(pixels, { raw: { width: 64, height: 64 * pages, channels: 3, pageHeight: 64 } });
}

for (const format of ["png", "jpeg", "webp", "gif", "avif"]) {
  test(`patched decoder preserves ${format} dimensions and repeatable image fingerprints`, async () => {
    const buffer = await sourceImage().toFormat(format).toBuffer();
    const metadata = await sharp(buffer).metadata();
    assert.equal(metadata.width, 64);
    assert.equal(metadata.height, 64);
    const first = await perceptualImageHash(buffer);
    assert.match(first, /^[0-9a-f]{16}$/);
    assert.equal(await perceptualImageHash(buffer), first);
  });
}

test("animated GIF metadata and sticker classification survive the decoder update", async () => {
  // Two distinct frames prevent the encoder from coalescing the animation.
  const pixels = Buffer.concat([Buffer.alloc(64 * 64 * 3, 30), Buffer.alloc(64 * 64 * 3, 210)]);
  const buffer = await sharp(pixels, { raw: { width: 64, height: 128, channels: 3, pageHeight: 64 } })
    .gif({ delay: [100, 200], loop: 0 }).toBuffer();
  let calls = 0;
  const result = await classifyStickerCandidate({ buffer, mimeType: "image/gif" }, {
    classify: async ({ metadata }) => {
      calls++;
      assert.equal(metadata.pages, 2);
      return { kind: "sticker", confidence: 0.95, description: "Animated test sticker", tags: [] };
    },
  });
  assert.equal(calls, 1);
  assert.equal(result.classification, "sticker");
  assert.equal(result.metadata.pages, 2);
  assert.match(result.fingerprint, /^[0-9a-f]{16}$/);
});

test("invalid image bytes reject without calling a vision provider", async () => {
  const buffer = Buffer.from("This is not an image.");
  let calls = 0;
  await assert.rejects(() => perceptualImageHash(buffer));
  await assert.rejects(() => classifyStickerCandidate({ buffer, mimeType: "image/png" }, {
    classify: async () => { calls++; return {}; },
  }));
  assert.equal(calls, 0);
});

test("wordcloud still produces a nonblank PNG through the real renderer", async () => {
  const file = await renderWordcloudPng([{ word: "hello", count: 8 }, { word: "world", count: 4 }]);
  assert.ok(file);
  try {
    const metadata = await sharp(file).metadata();
    assert.equal(metadata.format, "png");
    assert.ok(metadata.width > 0 && metadata.height > 0);
    const { channels } = await sharp(file).stats();
    assert.ok(channels.slice(0, 3).some(channel => channel.stdev > 1));
  } finally { fs.unlinkSync(file); }
});
