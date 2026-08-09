import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { beforeEach, describe, it } from "node:test";

import { handleLinkPreview } from "../bridge/reply-handlers.mjs";
import {
  extractPreviewUrls,
  inspectAutoPreview,
  linkPreviewStatus,
  markAutoPreviewSent,
  previewAddsValue,
  resetAutoPreviewPolicy,
  resetLinkPreviewStatus,
  resetPreviewImageCache,
  resolvePreviewImage,
  safeFetchPage,
} from "../bridge/services/link-preview/index.mjs";

beforeEach(() => {
  resetAutoPreviewPolicy();
  resetLinkPreviewStatus();
  resetPreviewImageCache();
});

describe("smart link preview policy", () => {
  it("extracts one public URL and removes tracking fields from its dedupe key", () => {
    const result = extractPreviewUrls("看看 https://example.com/a?utm_source=qq&x=1。 ");
    assert.equal(result.rawCount, 1);
    assert.equal(result.urls.length, 1);
    assert.equal(result.urls[0].url, "https://example.com/a?utm_source=qq&x=1");
    assert.equal(result.urls[0].key, "https://example.com/a?x=1");
  });

  it("skips mentions, multiple links, direct assets and private addresses", () => {
    assert.equal(inspectAutoPreview("https://example.com", { isAtMe: true }).reason, "mentioned");
    assert.equal(inspectAutoPreview("https://a.example/x https://b.example/y").reason, "multiple_links");
    assert.equal(inspectAutoPreview("https://example.com/file.zip").reason, "direct_asset");
    assert.equal(inspectAutoPreview("http://127.0.0.1/private").reason, "unsafe_link");
  });

  it("skips QQ media hosts instead of previewing chat images", () => {
    const result = inspectAutoPreview("https://gchat.qpic.cn/gchatpic_new/example/path");
    assert.equal(result.ok, false);
    assert.equal(result.reason, "media_host");
  });

  it("deduplicates equivalent links per group for thirty minutes", () => {
    const first = inspectAutoPreview("https://example.com/a?utm_source=one", {
      groupId: "group-a",
      now: 1000,
    });
    assert.equal(first.ok, true);
    markAutoPreviewSent("group-a", first.candidate, { now: 1000 });

    assert.equal(inspectAutoPreview("https://example.com/a?utm_source=two", {
      groupId: "group-a",
      now: 2000,
    }).reason, "duplicate");
    assert.equal(inspectAutoPreview("https://example.com/a", {
      groupId: "group-b",
      now: 2000,
    }).ok, true);
    assert.equal(inspectAutoPreview("https://example.com/a", {
      groupId: "group-a",
      now: 31 * 60 * 1000,
    }).ok, true);
  });

  it("requires useful metadata instead of echoing a message title", () => {
    assert.equal(previewAddsValue({ title: "Access Denied" }, "https://example.com"), false);
    assert.equal(previewAddsValue({ title: "项目发布说明" }, "项目发布说明 https://example.com"), false);
    assert.equal(previewAddsValue({
      title: "项目发布说明",
      description: "这里补充了版本兼容范围和升级步骤。",
    }, "项目发布说明 https://example.com"), true);
  });
});

describe("automatic link preview handling", () => {
  it("sends one useful preview and suppresses a tracked duplicate", async () => {
    const sent = [];
    let previewCalls = 0;
    const options = {
      now: 1000,
      previewer: async () => {
        previewCalls++;
        return {
          title: "发布说明",
          description: "包含升级步骤和兼容范围。",
          text: "链接：发布说明\n来源：example.com",
          image: "https://example.com/cover.png",
        };
      },
      imageResolver: async () => "base64://aW1hZ2U=",
      imageSender: async (groupId, text, image) => {
        sent.push({ groupId, text, image });
        return { status: "ok" };
      },
    };

    const first = await handleLinkPreview("group-a", "https://example.com/a?utm_source=one", false, options);
    const second = await handleLinkPreview("group-a", "https://example.com/a?utm_source=two", false, {
      ...options,
      now: 2000,
    });

    assert.equal(first.sent, true);
    assert.equal(first.hadLink, true);
    assert.equal(second.sent, false);
    assert.equal(second.reason, "duplicate");
    assert.equal(previewCalls, 1);
    assert.equal(sent[0].image, "base64://aW1hZ2U=");
    assert.equal(linkPreviewStatus().duplicateSkips, 1);
  });

  it("does not auto-preview a URL when the bot is mentioned", async () => {
    let previewCalls = 0;
    const result = await handleLinkPreview("group-a", "@夜星 看看 https://example.com/a", false, {
      isAtMe: true,
      previewer: async () => {
        previewCalls++;
        return null;
      },
    });
    assert.equal(result.sent, false);
    assert.equal(result.hadLink, true);
    assert.equal(result.reason, "mentioned");
    assert.equal(previewCalls, 0);
  });

  it("falls back to text if the preview image cannot be fetched safely", async () => {
    const sent = [];
    const result = await handleLinkPreview("group-a", "https://example.com/a", false, {
      previewer: async () => ({
        title: "发布说明",
        text: "链接：发布说明",
        image: "https://example.com/cover.png",
      }),
      imageResolver: async () => null,
      sender: async (groupId, text) => {
        sent.push({ groupId, text });
        return { retcode: 0 };
      },
    });
    assert.equal(result.sent, true);
    assert.equal(sent.length, 1);
  });
});

describe("safe link preview assets", () => {
  it("keeps preview images in memory as base64", async () => {
    const result = await resolvePreviewImage("https://example.com/image.png", {
      loader: async () => ({ buffer: Buffer.from("image"), mimeType: "image/png" }),
    });
    assert.equal(result, "base64://aW1hZ2U=");
  });

  it("rejects non-image preview assets", async () => {
    const result = await resolvePreviewImage("https://example.com/not-image", {
      loader: async () => ({ buffer: Buffer.from("html"), mimeType: "text/html" }),
    });
    assert.equal(result, null);
  });

  it("returns the final redirect URL and accepts only page content", async () => {
    const originalFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = async () => {
      calls++;
      if (calls === 1) {
        return {
          ok: false,
          status: 302,
          headers: { get: name => name.toLowerCase() === "location" ? "/final" : null },
        };
      }
      return {
        ok: true,
        status: 200,
        headers: { get: name => name.toLowerCase() === "content-type" ? "text/html; charset=utf-8" : null },
        text: async () => "<title>Final</title>",
      };
    };
    try {
      const page = await safeFetchPage("https://example.com/start");
      assert.equal(page.url, "https://example.com/final");
      assert.match(page.html, /Final/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("rejects non-page MIME types before reading the body", async () => {
    const originalFetch = globalThis.fetch;
    let bodyRead = false;
    globalThis.fetch = async () => ({
      ok: true,
      status: 200,
      headers: { get: name => name.toLowerCase() === "content-type" ? "application/pdf" : null },
      text: async () => {
        bodyRead = true;
        return "pdf";
      },
    });
    try {
      assert.equal(await safeFetchPage("https://example.com/file"), null);
      assert.equal(bodyRead, false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
