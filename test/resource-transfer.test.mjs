import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

import {
  handleResourceTransferCommand,
  parseResourceTransferCommand,
  transferResourceToGroup,
} from "../bridge/resource-transfer.mjs";

async function withMockFetch(mockFetch, fn) {
  const oldFetch = globalThis.fetch;
  globalThis.fetch = mockFetch;
  try {
    return await fn();
  } finally {
    globalThis.fetch = oldFetch;
  }
}

describe("resource transfer", () => {
  it("parses mentioned download commands", () => {
    const parsed = parseResourceTransferCommand("@QQFriend 下载 https://example.com/a.zip", {
      requireMention: true,
      botNames: ["QQFriend"],
    });
    assert.equal(parsed.ok, true);
    assert.equal(parsed.url, "https://example.com/a.zip");
  });

  it("rejects groups outside the resource whitelist before downloading", async () => {
    let fetchCalled = false;
    let uploadCalled = false;
    const sent = [];

    await withMockFetch(async () => {
      fetchCalled = true;
      return new globalThis.Response("nope");
    }, async () => {
      const handled = await handleResourceTransferCommand({
        isAtMe: true,
        text: "下载 https://example.com/a.zip",
        rawText: "@QQFriend 下载 https://example.com/a.zip",
        group_id: 111,
      }, {
        groupWhitelist: [222],
        sender: async (groupId, text) => sent.push({ groupId, text }),
        uploader: async () => { uploadCalled = true; },
      });
      assert.equal(handled, true);
    });

    assert.equal(fetchCalled, false);
    assert.equal(uploadCalled, false);
    assert.match(sent[0].text, /白名单/);
  });

  it("rejects resources over the 500MB limit from content-length", async () => {
    let uploadCalled = false;
    const result = await withMockFetch(async () => new globalThis.Response("x", {
      headers: { "content-length": String(501 * 1024 * 1024) },
    }), () => transferResourceToGroup({
      groupId: 123,
      url: "https://example.com/too-large.zip",
      maxBytes: 500 * 1024 * 1024,
      sender: async () => {},
      uploader: async () => { uploadCalled = true; },
    }));

    assert.equal(result.ok, false);
    assert.equal(result.reason, "size_limit");
    assert.equal(uploadCalled, false);
  });

  it("deletes the temp file after group upload", async () => {
    let uploadedPath = "";
    let uploadedName = "";
    let existedDuringUpload = false;

    const result = await withMockFetch(async () => new globalThis.Response("hello", {
      headers: {
        "content-length": "5",
        "content-disposition": "attachment; filename=\"hello.txt\"",
      },
    }), () => transferResourceToGroup({
      groupId: 123,
      url: "https://example.com/hello.txt",
      maxBytes: 500 * 1024 * 1024,
      sender: async () => {},
      uploader: async (groupId, filePath, name) => {
        assert.equal(groupId, 123);
        uploadedPath = filePath;
        uploadedName = name;
        existedDuringUpload = fs.existsSync(filePath);
        return { status: "ok" };
      },
    }));

    assert.equal(result.ok, true);
    assert.equal(uploadedName, "hello.txt");
    assert.equal(existedDuringUpload, true);
    assert.equal(fs.existsSync(uploadedPath), false);
    assert.equal(fs.existsSync(path.dirname(uploadedPath)), false);
  });
});
