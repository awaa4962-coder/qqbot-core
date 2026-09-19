import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { afterEach, describe, it } from "node:test";

// This file owns an isolated config so real entrypoints can exercise distinct task slots.
const root = fs.mkdtempSync(path.join(os.tmpdir(), "qqfriend-private-model-"));
process.env.QQBOT_CONFIG_ROOT = root;
process.env.QQBOT_DATA_DIR = path.join(root, "data");
process.env.QQBOT_LOG_DIR = path.join(root, "logs");
const { CFG } = await import("../bridge/config.mjs");
const { handlePrivateMessage } = await import("../bridge/reply-private.mjs");
const { saveApiProvider, saveApiRoutes } = await import("../bridge/api-providers/store.mjs");
const { executePrivateChatTask } = await import("../bridge/model-router.mjs");
const { buildRuntimeStatus } = await import("../bridge/admin-api/runtime-status.mjs");
const originalFetch = globalThis.fetch;
const originalFriends = CFG.friendWhitelist.slice();

for (const id of ["private-primary", "private-backup", "file-primary"]) {
  saveApiProvider({ id, presetId: "custom-openai-chat", name: id, model: id, auth: "none",
    endpoint: "https://example.com/" + id, capabilities: ["text"],
  }, { root });
}
saveApiRoutes({ private_chat: { primary: "private-primary", fallback: "private-backup" },
  file_chat: { primary: "file-primary", fallback: "private-backup" },
}, { root });

afterEach(() => {
  globalThis.fetch = originalFetch;
  CFG.friendWhitelist.splice(0, CFG.friendWhitelist.length, ...originalFriends);
});

describe("private entrypoint model routing", () => {
  it("selects file_chat.primary from the private file entrypoint", async () => {
    CFG.friendWhitelist.splice(0, CFG.friendWhitelist.length, 42);
    const models = [];
    globalThis.fetch = async (url, options) => {
      if (String(url).startsWith("https://example.com/")) {
        const body = JSON.parse(options.body);
        models.push(body.model);
        return response({ choices: [{ message: { content: "synthetic file answer" } }] });
      }
      if (String(url).endsWith("/send_private_msg")) return response({ status: "ok", retcode: 0, data: { message_id: 1 } });
      assert.fail("unexpected network: " + url);
    };
    await handlePrivateMessage({ user_id: 42, nickname: "synthetic-user", text: "read attachment", images: [],
      files: [{ name: "synthetic.txt" }], message_id: 1,
    });
    assert.deepEqual(models, ["file-primary"]);
  });

  it("routes private primary failure to the configured backup with one vision description", async () => {
    const bodies = [];
    globalThis.fetch = async (url, options) => {
      assert.ok(String(url).startsWith("https://example.com/"));
      const body = JSON.parse(options.body);
      bodies.push(body);
      return body.model === "private-primary"
        ? response({ choices: [{ message: { reasoning_content: "private only" } }] })
        : response({ choices: [{ message: { content: "synthetic answer" } }] });
    };
    let visionCalls = 0;
    const result = await executePrivateChatTask({ userMsg: "image question", imageUrls: ["synthetic-image"], options: { currentUserId: 42 } }, {
      resolveVision: async () => { visionCalls++; return "synthetic image description"; },
    });
    assert.deepEqual(bodies.map(item => item.model), ["private-primary", "private-backup"]);
    for (const body of bodies) assert.match(JSON.stringify(body.messages), /synthetic image description/);
    assert.equal(visionCalls, 1);
    assert.deepEqual(result, { text: "synthetic answer", position: "fallback" });
  });

  it("does not send a private message when both configured slots produce no final content", async () => {
    CFG.friendWhitelist.splice(0, CFG.friendWhitelist.length, 42);
    const models = [];
    globalThis.fetch = async (url, options) => {
      assert.ok(String(url).startsWith("https://example.com/"), "no QQ send is allowed");
      models.push(JSON.parse(options.body).model);
      return response({ choices: [{ message: { reasoning_content: "private only" } }] });
    };
    await handlePrivateMessage({ user_id: 42, nickname: "synthetic-user", text: "ordinary greeting", images: [], files: [], message_id: 2 });
    assert.deepEqual(models, ["private-primary", "private-backup"]);
  });

  it("passes private image failures into both model prompts rather than only an image count", async () => {
    CFG.friendWhitelist.splice(0, CFG.friendWhitelist.length, 42);
    const bodies = [];
    globalThis.fetch = async (url, options) => {
      assert.ok(String(url).startsWith("https://example.com/"), "invalid image must not be fetched or sent");
      bodies.push(JSON.parse(options.body));
      return response({ choices: [{ message: { reasoning_content: "private only" } }] });
    };
    await handlePrivateMessage({ user_id: 42, nickname: "synthetic-user", text: "describe image", images: ["not-a-valid-url"], files: [], message_id: 3 });
    assert.deepEqual(bodies.map(body => body.model), ["private-primary", "private-backup"]);
    for (const body of bodies) assert.match(JSON.stringify(body.messages), /视觉识别失败/);
  });

  it("keeps runtime status available with an explicit degraded API config error", () => {
    const file = path.join(root, ".qqfriend", "api-providers.json");
    const previous = fs.readFileSync(file, "utf8");
    fs.writeFileSync(file, "{");
    try {
      const status = buildRuntimeStatus();
      assert.equal(status.status, "ok");
      assert.equal(status.modules.apiProviders.health, "degraded");
      assert.deepEqual(status.modules.apiProviders.issues, ["configuration_invalid"]);
      assert.match(status.modules.apiProviders.configurationError, /已停止模型调用/);
      assert.deepEqual(status.modules.apiProviders.routes, {});
      assert.ok(status.moduleHealth.degraded.includes("apiProviders"));
      assert.equal(fs.readFileSync(file, "utf8"), "{");
    } finally {
      fs.writeFileSync(file, previous);
    }
  });
});

function response(value) {
  return { ok: true, status: 200, text: async () => JSON.stringify(value), json: async () => value };
}
