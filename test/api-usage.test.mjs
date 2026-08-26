import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";

import { callTaskApi } from "../bridge/api-providers/gateway.mjs";
import {
  buildUserCacheStatsText,
  clearUserCacheUsage,
  getUserCacheUsage,
  normalizeProviderUsage,
  recordApiUsage,
} from "../bridge/api-providers/usage-metrics.mjs";
import {
  buildGroupCommandReply,
  buildPrivateCommandReply,
} from "../bridge/admin-commands.mjs";

const originalFetch = globalThis.fetch;
const tempDirs = [];
const TEST_SALT = "test-only-cache-usage-salt-1234567890";

afterEach(() => {
  globalThis.fetch = originalFetch;
  while (tempDirs.length) fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
});

describe("API cache usage metrics", () => {
  it("normalizes DeepSeek, MiMo and Responses cache fields", () => {
    assert.deepEqual(normalizeProviderUsage({
      prompt_tokens: 100,
      completion_tokens: 20,
      total_tokens: 120,
      prompt_cache_hit_tokens: 75,
      prompt_cache_miss_tokens: 25,
    }), {
      promptTokens: 100,
      cachedTokens: 75,
      missTokens: 25,
      completionTokens: 20,
      reasoningTokens: 0,
      totalTokens: 120,
      cacheReported: true,
      usageReported: true,
    });

    const mimo = normalizeProviderUsage({
      prompt_tokens: 80,
      completion_tokens: 15,
      prompt_tokens_details: { cached_tokens: 60 },
      completion_tokens_details: { reasoning_tokens: 5 },
    });
    assert.equal(mimo.cachedTokens, 60);
    assert.equal(mimo.missTokens, 20);
    assert.equal(mimo.reasoningTokens, 5);

    const responses = normalizeProviderUsage({
      input_tokens: 50,
      output_tokens: 10,
      input_tokens_details: { cached_tokens: 40 },
    });
    assert.equal(responses.cachedTokens, 40);
    assert.equal(responses.missTokens, 10);

    const unsupported = normalizeProviderUsage({
      prompt_tokens: 25,
      completion_tokens: 5,
      cache_reported: false,
      prompt_cache_hit_tokens: 0,
      prompt_cache_miss_tokens: 25,
    });
    assert.equal(unsupported.cacheReported, false);
  });

  it("stores pseudonymous per-user counters and isolates user queries", () => {
    const dir = tempUsageDir();
    const now = Date.parse("2026-08-27T10:00:00+08:00");
    recordForUser(dir, "111111111", now, "mimo", 100, 60);
    recordForUser(dir, "222222222", now + 1, "deepseek", 50, 50);

    const first = getUserCacheUsage("111111111", { dir, salt: TEST_SALT, now: now + 1000 });
    assert.equal(first.calls, 1);
    assert.equal(first.promptTokens, 100);
    assert.equal(first.cachedTokens, 60);
    assert.equal(first.hitRate, 0.6);
    assert.equal(first.providers.mimo.calls, 1);
    assert.equal(first.providers.deepseek, undefined);

    const stored = fs.readFileSync(path.join(dir, "usage-2026-08-27.jsonl"), "utf8");
    assert.doesNotMatch(stored, /111111111|222222222|聊天内容|提示词/);
    const text = buildUserCacheStatsText("111111111", { dir, salt: TEST_SALT, now: now + 1000 });
    assert.match(text, /我的缓存命中/);
    assert.match(text, /60\.0%/);
    assert.match(text, /MiMo/);
    assert.doesNotMatch(text, /DeepSeek/);
  });

  it("resets visible personal metrics without exposing another user", () => {
    const dir = tempUsageDir();
    const now = Date.parse("2026-08-27T10:00:00+08:00");
    recordForUser(dir, "111111111", now, "mimo", 100, 60);
    recordForUser(dir, "222222222", now + 1, "deepseek", 50, 50);
    assert.equal(clearUserCacheUsage("111111111", { dir, salt: TEST_SALT, now: now + 1000 }), true);
    assert.equal(getUserCacheUsage("111111111", {
      dir,
      salt: TEST_SALT,
      now: now + 2000,
    }).calls, 0);
    assert.equal(getUserCacheUsage("222222222", {
      dir,
      salt: TEST_SALT,
      now: now + 2000,
    }).calls, 1);

    recordForUser(dir, "111111111", now + 3000, "mimo", 40, 20);
    const refreshed = getUserCacheUsage("111111111", {
      dir,
      salt: TEST_SALT,
      now: now + 4000,
    });
    assert.equal(refreshed.calls, 1);
    assert.equal(refreshed.cachedTokens, 20);
  });

  it("attributes gateway usage to the triggering user", async () => {
    const root = tempUsageDir();
    const dir = path.join(root, "metrics");
    fs.writeFileSync(path.join(root, ".env_mimo"), "test-only-mimo-key", "utf8");
    globalThis.fetch = async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        choices: [{ message: { content: "ok" } }],
        usage: {
          prompt_tokens: 120,
          completion_tokens: 8,
          prompt_tokens_details: { cached_tokens: 90 },
        },
      }),
    });

    const result = await callTaskApi("group_chat", "primary", {
      messages: [{ role: "user", content: "hello" }],
      maxTokens: 16,
      usageContext: { userId: "333333333" },
    }, {
      root,
      usageMetricsDir: dir,
      usageMetricsSalt: TEST_SALT,
    });
    assert.equal(result.ok, true);
    const usage = getUserCacheUsage("333333333", {
      dir,
      salt: TEST_SALT,
      now: Date.now() + 1000,
    });
    assert.equal(usage.calls, 1);
    assert.equal(usage.cachedTokens, 90);
    assert.equal(usage.tasks.group_chat.calls, 1);
  });
});

describe("personal cache command", () => {
  it("is mention-gated in groups and can only read the sender", () => {
    const builder = userId => "cache-for:" + userId;
    const reply = buildGroupCommandReply({
      isAtMe: true,
      text: "缓存命中",
      rawText: "[CQ:at,qq=1000000001] 缓存命中",
      user_id: 42,
      group_id: 1,
    }, { selfUin: 1000000001, cacheStatsBuilder: builder });
    assert.equal(reply, "cache-for:42");
    assert.equal(buildGroupCommandReply({
      isAtMe: false,
      text: "缓存命中",
      rawText: "缓存命中",
      user_id: 7,
      group_id: 1,
    }, { cacheStatsBuilder: builder }), null);
  });

  it("works directly in private chat", () => {
    const reply = buildPrivateCommandReply({ text: "cache stats", user_id: 88 }, {
      cacheStatsBuilder: userId => "cache-for:" + userId,
    });
    assert.equal(reply, "cache-for:88");
  });
});

function recordForUser(dir, userId, timestamp, provider, promptTokens, cachedTokens) {
  assert.equal(recordApiUsage({
    provider,
    task: "group_chat",
    position: "primary",
    userId,
    timestamp,
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: 10,
      prompt_tokens_details: { cached_tokens: cachedTokens },
    },
  }, { dir, salt: TEST_SALT }), true);
}

function tempUsageDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qqfriend-api-usage-"));
  tempDirs.push(dir);
  return dir;
}
