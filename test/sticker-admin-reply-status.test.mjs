import assert from "node:assert/strict";
import test from "node:test";
import { applyStickerManagerAction, buildStickerManagerSnapshot } from "../bridge/admin-api/sticker-manager.mjs";

test("sticker simulations mask transport keys and sender hashes without changing the internal selection", async () => {
  const sticker = { id: "synthetic-favorite", source: "qq-favorite", indexed: true, enabled: true,
    description: "synthetic reaction", tags: ["其他"], url: "https://example.com/sticker.png",
    emojiId: "synthetic-emoji", packageId: "synthetic-package", key: "synthetic-private-send-key",
    senderHashes: ["synthetic-private-sender-hash"] };
  const result = await applyStickerManagerAction({ action: "simulate", groupId: 50100 }, {
    simulate: async () => ({ action: "send", stickerId: sticker.id, sticker, candidates: [], reasonCode: "selection_selected" }),
  });
  assert.equal(result.result.action, "send");
  assert.equal(result.result.sticker.key, "configured");
  assert.equal(result.result.sticker.sendable, true);
  assert.equal("senderHashes" in result.result.sticker, false);
  assert.equal(sticker.key, "synthetic-private-send-key");
  assert.doesNotMatch(JSON.stringify(result), /synthetic-private-send-key|synthetic-private-sender-hash/);
});

test("the existing sticker manager snapshot exposes process reply diagnostics separately from the catalog", () => {
  const snapshot = buildStickerManagerSnapshot();
  assert.ok(snapshot.replyStatus && typeof snapshot.replyStatus === "object");
  assert.ok(snapshot.settings && snapshot.counts);
  assert.equal(snapshot.privacy.exposesSendKeys, false);
});
