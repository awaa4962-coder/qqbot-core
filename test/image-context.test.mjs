import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import {
  findCachedImageDescription,
  flushImageContextCacheSync,
  rememberImageDescription,
  resetImageContextCacheForTest,
  setImageContextCachePath,
} from "../bridge/knowledge/memes/image-context.mjs";
import { buildImageContextMessage } from "../bridge/system-prompts/image-context.mjs";

let cacheFile;

describe("image context knowledge", () => {
  beforeEach(() => {
    cacheFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "qqfriend-image-context-")), "cache.json");
    setImageContextCachePath(cacheFile);
    resetImageContextCacheForTest();
  });

  afterEach(() => {
    setImageContextCachePath("");
  });

  it("stores only a fingerprint and objective description", () => {
    const fingerprint = "0000000000000000";
    assert.equal(rememberImageDescription(fingerprint, "主体是猫，表情严肃，没有可见文字。"), true);
    assert.match(findCachedImageDescription(fingerprint), /主体是猫/);
    flushImageContextCacheSync();
    const raw = fs.readFileSync(cacheFile, "utf8");
    assert.match(raw, /0000000000000000/);
    assert.doesNotMatch(raw, /image_url|base64|群聊原文/);
  });

  it("reuses visually close fingerprints", () => {
    rememberImageDescription("0000000000000000", "一只震惊表情的猫。", { now: 100 });
    assert.equal(
      findCachedImageDescription("0000000000000001", { now: 200, maxDistance: 2 }),
      "一只震惊表情的猫。"
    );
  });

  it("does not persist sensitive OCR-like descriptions", () => {
    assert.equal(
      rememberImageDescription("0000000000000000", "图片写着 password=secret-value"),
      false
    );
  });

  it("marks failed vision as unavailable instead of inventing content", () => {
    const message = buildImageContextMessage(null, { imageCount: 1 });
    assert.match(message.content, /视觉识别失败/);
    assert.match(message.content, /不能声称看到了/);
  });
});
