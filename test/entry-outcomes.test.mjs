import test from "node:test";
import assert from "node:assert/strict";
import { classifyOutboundDelivery } from "../bridge/cognition/outcome.mjs";
import { executeExplicitLinkPreviewCommand, handleLinkPreview, handleMiniAppResult } from "../bridge/reply-handlers.mjs";
import { executeWordcloudCommand } from "../bridge/features/wordcloud/index.mjs";
import { generateGroupSummaryResult } from "../bridge/group-summary/providers.mjs";
import { describeVisionImages } from "../bridge/vision.mjs";

const sent = { status: "ok", retcode: 0 };
const failed = { status: "failed", retcode: 100 };
const unknown = { status: "unknown", delivery: "unconfirmed" };

test("outbound contract distinguishes confirmed, failed, unknown and partial chunks", () => {
  assert.equal(classifyOutboundDelivery(sent), "sent");
  assert.equal(classifyOutboundDelivery(failed), "failed");
  assert.equal(classifyOutboundDelivery(unknown), "unknown");
  assert.equal(classifyOutboundDelivery([sent, unknown]), "partial");
  assert.equal(classifyOutboundDelivery([]), "unknown");
});

test("explicit preview keeps Boolean adapter but exposes failed delivery", async () => {
  const result = await executeExplicitLinkPreviewCommand({ isAtMe: true, group_id: 1 }, {
    parsedCommand: { url: "https://example.com" },
    previewer: async () => ({ text: "Example" }),
    sender: async () => failed,
  });
  assert.deepEqual(result, { handled: true, previewSent: false, delivery: "failed", reason: "send_failed" });
});

test("explicit preview returns unavailable even when previewer throws", async () => {
  const result = await executeExplicitLinkPreviewCommand({ isAtMe: true, group_id: 1 }, {
    parsedCommand: { url: "https://example.com" },
    previewer: async () => { throw Error("offline"); },
    sender: async () => sent,
  });
  assert.deepEqual(result, { handled: true, previewSent: false, delivery: "sent", reason: "preview_unavailable" });
});

test("miniapp unconfirmed delivery is not reported as sent or retried", async () => {
  const detail = { app: "com.tencent.miniapp_01", meta: { detail_1: { title: "Example", qqdocurl: "https://example.com" } } };
  const message = [1, 2].map(() => ({ type: "json", data: { data: JSON.stringify(detail) } }));
  let calls = 0;
  const result = await handleMiniAppResult(message, 1, false, {
    sender: async () => { calls++; return unknown; },
  });
  assert.deepEqual(result, { found: true, delivery: "unknown", reason: "send_unknown" });
  assert.equal(calls, 1);
});

test("automatic link preview does not claim an unconfirmed send", async () => {
  const result = await handleLinkPreview(100, "https://example.com/result-contracts", false, {
    previewer: async () => ({ title: "Result contracts", description: "Delivery states and command outcomes", text: "Preview text" }),
    sender: async () => unknown,
  });
  assert.deepEqual(result, { sent: false, isBili: false, hadLink: true, reason: "send_unknown" });
});

test("wordcloud result reports text fallback and unconfirmed delivery", async () => {
  const now = new Date("2026-07-05T12:00:00+08:00");
  const result = await executeWordcloudCommand({ isAtMe: true, group_id: 1 }, {
    parsedCommand: { range: "today", days: 1 },
    featureGroupWhitelist: [1], now,
    chats: [{ role: "member", text: "wordcloud wordcloud", ts: now.getTime() }],
    renderer: async () => null,
    sender: async () => unknown,
  });
  assert.deepEqual(result, { handled: true, delivery: "unknown", reason: "send_unknown", imageGenerated: false });
});

test("wordcloud generated text is not counted as delivered on a rejected send", async () => {
  const now = new Date("2026-07-05T12:00:00+08:00");
  const result = await executeWordcloudCommand({ isAtMe: true, group_id: 1 }, {
    parsedCommand: { range: "today", days: 1 },
    featureGroupWhitelist: [1], now,
    chats: [{ role: "member", text: "wordcloud wordcloud", ts: now.getTime() }],
    renderer: async () => null,
    sender: async () => failed,
  });
  assert.deepEqual(result, { handled: true, delivery: "failed", reason: "send_failed", imageGenerated: false });
});

test("summary and vision expose empty input without changing legacy text fields", async () => {
  const summary = await generateGroupSummaryResult([]);
  assert.deepEqual(summary, { kind: "empty", text: null, provider: "none", reason: "no_messages", digest: null });
  const vision = await describeVisionImages({ images: [] }, { assertCurrent: () => {} });
  assert.deepEqual(vision, { ok: false, text: "", cached: false, reason: "no_images" });
});
