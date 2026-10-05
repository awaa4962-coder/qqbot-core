import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { after, beforeEach, test } from "node:test";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "qqfriend-sticker-send-resilience-"));
Object.assign(process.env, { NODE_ENV: "test", QQBOT_CONFIG_ROOT: root,
  QQBOT_DATA_DIR: path.join(root, "data"), QQBOT_LOG_DIR: path.join(root, "logs"),
  QQBOT_MEMORY_PROFILE_FILE: path.join(root, "profiles.json"), QQBOT_TEMP_DIR: path.join(root, "temp") });
const { normalizeStickerSettings, isStickerEntrySendable, publicStickerEntry, getStickerSendMaterials } =
  await import("../bridge/features/stickers/schema.mjs");
const { buildStickerSegment, sendStickerDecision } = await import("../bridge/features/stickers/sender.mjs");
const { invalidateMemoryPrivacyGeneration, invalidateUserMemoryGeneration } = await import("../bridge/memory-profile/generation.mjs");
const { withChatRun, noteChatOutcome } = await import("../bridge/cognition/chat-run.mjs");
const { createChatDeliveryLedger } = await import("../bridge/cognition/delivery-ledger.mjs");
const { CFG } = await import("../bridge/config.mjs");

const imageUrl = "https://example.com/synthetic.gif?rkey=synthetic";
const sticker = (overrides = {}) => ({ id: "synthetic-sticker", source: "qq-favorite", enabled: true,
  indexed: true, description: "Synthetic reaction", url: imageUrl,
  emojiId: "synthetic-emoji", packageId: "synthetic-package", key: "synthetic-face-key", ...overrides });
const decision = entry => ({ action: "send", sticker: entry });
const sent = () => ({ status: "ok", retcode: 0 });
const failed = () => ({ status: "failed", retcode: 100, message: "synthetic rejection" });
const unknown = () => ({ status: "unknown", delivery: "unconfirmed" });
const contexts = [{ name: "group", value: { private: false, userId: 601, groupId: 602 } },
  { name: "private", value: { private: true, userId: 601 } }];
let sequence = 0;

beforeEach(t => {
  const denied = t.mock.method(globalThis, "fetch", () => assert.fail("real network and QQ sends are forbidden"));
  t.after(() => assert.equal(denied.mock.callCount(), 0));
});
after(() => {
  assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
  fs.rmSync(root, { recursive: true, force: true });
});

function transport(context, handler) {
  return context.private ? { sendPrivate: (target, message, options) => handler(target, message, options) }
    : { sendGroup: (target, message, replyTo, options) => {
      assert.equal(replyTo, undefined);
      return handler(target, message, options);
    } };
}
function assertOutcome(output, status, reasonCode) {
  assert.equal(output.status, status);
  assert.equal(output.reasonCode, reasonCode);
  assert.equal(output.ok, status === "sent");
  assert.equal(output.error, status === "sent" ? "" : reasonCode);
}

test("only the two default probabilities change to one half and explicit settings remain authoritative", () => {
  assert.deepEqual(normalizeStickerSettings(), { mode: "steady", groupEnabled: true, privateEnabled: true,
    chance: 0.5, strongChance: 0.5, cooldownMs: 300000, allowedGroups: [], captureMode: "observe",
    captureDailyLimit: 20, captureCatalogLimit: 300, captureMinConfidence: 0.82, captureMinDistinctSenders: 2 });
  assert.equal(normalizeStickerSettings({ chance: 0.2, strongChance: 0.8 }).chance, 0.2);
  assert.equal(normalizeStickerSettings({ chance: 0.2, strongChance: 0.8 }).strongChance, 0.8);
  assert.equal(normalizeStickerSettings({}, { chance: 0.2, strongChance: 0.3 }).chance, 0.2);
  assert.equal(normalizeStickerSettings({}, { chance: 0.2, strongChance: 0.3 }).strongChance, 0.3);
});

for (const [name, overrides] of [
  ["disabled", { enabled: false }], ["unindexed", { indexed: false }], ["missing index", { indexed: undefined }],
  ["blank description", { description: " \n " }], ["inactive capture", { source: "group-capture", captureState: "candidate" }],
  ["retired capture", { source: "group-capture", captureState: "retired" }],
  ["retired favorite", { captureState: "retired" }],
  ["missing all materials", { emojiId: "", packageId: "", key: "", url: "" }],
  ["masked key", { key: "configured", url: "" }], ["blank key", { key: " \n ", url: "" }],
  ["object key", { key: {}, url: "" }], ["missing emoji", { emojiId: undefined, url: "" }],
  ["missing package", { packageId: undefined, url: "" }],
]) {
  test("sendability and segment construction both reject " + name, async () => {
    const entry = sticker(overrides);
    assert.equal(isStickerEntrySendable(entry), false);
    assert.equal(buildStickerSegment(entry), null);
    assert.equal(publicStickerEntry(entry).sendable, false);
    const output = await sendStickerDecision(decision(entry), contexts[0].value,
      transport(contexts[0].value, () => assert.fail("invalid entries must never reach transport")));
    assertOutcome(output, "skipped", "invalid_sticker");
    assert.equal(output.skipped, true);
  });
}

test("public snapshots decide from raw materials before masking and never use configured as a real key", () => {
  const raw = sticker({ url: "" });
  const publicEntry = publicStickerEntry(raw);
  assert.equal(publicEntry.sendable, true);
  assert.equal(publicEntry.key, "configured");
  assert.equal(isStickerEntrySendable(publicEntry), false);
  assert.equal(buildStickerSegment(publicEntry), null);
  assert.equal(raw.key, "synthetic-face-key");
  assert.equal(JSON.stringify(publicEntry).includes(raw.key), false);
  assert.equal(isStickerEntrySendable(sticker({ source: "group-capture", captureState: "active" })), true);
});

test("pure safe URL validation preserves valid media URLs but rejects unsafe or non-HTTP materials", () => {
  for (const url of [imageUrl, "http://example.com/synthetic.png"]) {
    const entry = sticker({ key: "", url });
    assert.equal(isStickerEntrySendable(entry), true);
    assert.equal(buildStickerSegment(entry).data.file, url);
    assert.equal(getStickerSendMaterials(entry).url, url);
  }
  for (const url of ["", "http://", "file:///synthetic.gif", "data:image/png;base64,c3ludGhldGlj",
    "C:\\synthetic.gif", "/tmp/synthetic.gif", "https://user:password@example.com/synthetic.gif",
    "http://127.0.0.1/synthetic.gif", "http://[::1]/synthetic.gif", "ftp://example.com/synthetic.gif"]) {
    assert.equal(isStickerEntrySendable(sticker({ key: "", url })), false);
    assert.equal(buildStickerSegment(sticker({ key: "", url })), null);
  }
});

for (const { name, value: context } of contexts) {
  test(name + " prefers one mface request and accepts legacy successful receipts without a message id", async () => {
    let calls = 0;
    let guards = 0;
    const output = await sendStickerDecision(decision(sticker()), context, {
      ensureAllowed: () => { guards++; },
      ...transport(context, async (target, message, options) => {
        calls++;
        assert.equal(target, context.private ? context.userId : context.groupId);
        assert.equal(message.length, 1);
        assert.equal(message[0].type, "mface");
        assert.equal(message[0].data.key, "synthetic-face-key");
        assert.equal(options.maxAttempts, 1);
        const before = guards;
        assert.equal(options.stopReason(), "");
        assert.ok(guards > before);
        return sent();
      }),
    });
    assert.equal(calls, 1);
    assertOutcome(output, "sent", "sent");
  });

  test(name + " image-only requests preserve ordinary image semantics and never use flash images", async () => {
    let calls = 0;
    const output = await sendStickerDecision(decision(sticker({ emojiId: "", packageId: "", key: "" })), context,
      transport(context, async (_target, message, options) => {
        calls++;
        assert.equal(message[0].type, "image");
        assert.equal(message[0].data.file, imageUrl);
        assert.equal(Object.hasOwn(message[0].data, "type"), false);
        assert.equal(options.maxAttempts, 1);
        return sent();
      }));
    assert.equal(calls, 1);
    assertOutcome(output, "sent", "sent");
  });

  test(name + " retries exactly once as IMAGE only after a definite mface rejection", async () => {
    const types = [];
    const output = await sendStickerDecision(decision(sticker()), context, transport(context, async (_target, message, options) => {
      types.push(message[0].type);
      assert.equal(options.maxAttempts, 1);
      return types.length === 1 ? failed() : sent();
    }));
    assert.deepEqual(types, ["mface", "image"]);
    assertOutcome(output, "sent", "sent");
  });
}

test("failure of the IMAGE fallback cannot cause a third attempt", async () => {
  const types = [];
  const output = await sendStickerDecision(decision(sticker()), contexts[0].value,
    transport(contexts[0].value, async (_target, message) => { types.push(message[0].type); return failed(); }));
  assert.deepEqual(types, ["mface", "image"]);
  assertOutcome(output, "failed", "send_failed");
});

for (const [name, receipt, status, reason] of [
  ["unconfirmed", unknown(), "unknown", "send_unknown"],
  ["missing", null, "unknown", "send_unknown"], ["missing fields", {}, "unknown", "send_unknown"],
  ["unrecognised ok flag", { ok: false }, "unknown", "send_unknown"],
  ["async", { status: "async", retcode: 1 }, "unknown", "send_unknown"],
  ["contradictory rejection", { status: "failed", retcode: 0 }, "unknown", "send_unknown"],
  ["rejection with accepted id", { status: "failed", retcode: 100, data: { message_id: 1 } }, "unknown", "send_unknown"],
  ["empty receipt array", [], "unknown", "send_unknown"],
  ["partial receipt array", [sent(), failed()], "partial", "send_partial"],
  ["cancelled receipt", { status: "cancelled", reason: "privacy_changed" }, "cancelled", "send_cancelled"],
]) {
  test(name + " never replays mface as IMAGE", async () => {
    let calls = 0;
    const output = await sendStickerDecision(decision(sticker()), contexts[0].value,
      transport(contexts[0].value, async () => { calls++; return receipt; }));
    assert.equal(calls, 1);
    assert.equal(output.result, receipt);
    assertOutcome(output, status, reason);
  });
}

test("thrown timeout and transport errors are unknown rather than safe-to-retry failures", async () => {
  for (const name of ["TimeoutError", "AbortError", "Error"]) {
    let calls = 0;
    const output = await sendStickerDecision(decision(sticker()), contexts[0].value,
      transport(contexts[0].value, async () => { calls++; throw Object.assign(new Error("synthetic transport failure"), { name }); }));
    assert.equal(calls, 1);
    assertOutcome(output, "unknown", "send_unknown");
  }
});

test("definite mface rejection without a safe IMAGE URL cannot fall back", async () => {
  for (const url of ["", "http://", "file:///synthetic.gif", "data:image/png;base64,c3ludGhldGlj", "http://127.0.0.1/synthetic.gif"]) {
    let calls = 0;
    const output = await sendStickerDecision(decision(sticker({ url })), contexts[0].value,
      transport(contexts[0].value, async () => { calls++; return failed(); }));
    assert.equal(calls, 1);
    assertOutcome(output, "failed", "send_failed");
  }
});

test("pre-cancellation and denied live eligibility prevent the first transport request", async () => {
  const controller = new globalThis.AbortController();
  controller.abort();
  const sendOptions = transport(contexts[0].value, () => assert.fail("pre-cancelled send reached transport"));
  await assert.rejects(sendStickerDecision(decision(sticker()), contexts[0].value, { ...sendOptions, signal: controller.signal }), { name: "AbortError" });
  await assert.rejects(sendStickerDecision(decision(sticker()), contexts[0].value, { ...sendOptions, ensureAllowed: () => false }), { code: "CHAT_CANCELLED" });
});

for (const stop of ["signal", "privacy", "preferences", "live"]) {
  test(stop + " changes after a receipt preserve physical sent, rejected and unknown results without fallback", async () => {
    for (const [receipt, status, reason] of [[sent(), "sent", "sent"], [failed(), "failed", "send_failed"], [unknown(), "unknown", "send_unknown"]]) {
      const controller = new globalThis.AbortController();
      let allowed = true;
      let calls = 0;
      const output = await sendStickerDecision(decision(sticker()), contexts[0].value, {
        signal: controller.signal, ensureAllowed: () => { if (!allowed) throw new Error("synthetic live eligibility changed"); },
        ...transport(contexts[0].value, async () => {
          calls++;
          if (stop === "signal") controller.abort();
          else if (stop === "privacy") invalidateMemoryPrivacyGeneration();
          else if (stop === "preferences") invalidateUserMemoryGeneration(contexts[0].value.userId, { privacy: false });
          else allowed = false;
          return receipt;
        }),
      });
      assert.equal(calls, 1);
      assert.equal(output.result, receipt);
      assertOutcome(output, status, reason);
      assert.equal(output.guardStopped, true);
    }
  });
}

test("the immediate fallback preflight rechecks live eligibility and preserves the original rejection on stop", async () => {
  let guards = 0;
  let calls = 0;
  const receipt = failed();
  const output = await sendStickerDecision(decision(sticker()), contexts[0].value, {
    ensureAllowed: () => { if (++guards === 5) throw new Error("synthetic live eligibility changed"); },
    ...transport(contexts[0].value, async () => { calls++; return receipt; }),
  });
  assert.equal(guards, 5);
  assert.equal(calls, 1);
  assert.equal(output.result, receipt);
  assertOutcome(output, "failed", "send_failed");
  assert.equal(output.guardStopped, true);
});

test("NapCat stopReason rechecks live eligibility without exposing the callback's arbitrary reason", async () => {
  let allowed = true;
  let calls = 0;
  const output = await sendStickerDecision(decision(sticker()), contexts[1].value, {
    ensureAllowed: () => { if (!allowed) throw new Error("synthetic private internal reason"); },
    ...transport(contexts[1].value, async (_target, _message, options) => {
      calls++;
      allowed = false;
      assert.equal(options.stopReason(), "task_cancelled");
      return { status: "cancelled", reason: options.stopReason() };
    }),
  });
  assert.equal(calls, 1);
  assertOutcome(output, "cancelled", "send_cancelled");
  assert.equal(JSON.stringify(output).includes("synthetic private internal reason"), false);
});

for (const [name, fault, expected] of [
  ["policy reason code", { code: "STICKER_REPLY_BLOCKED", reasonCode: "policy_changed" }, "policy_changed"],
  ["entry reason code", { code: "STICKER_REPLY_BLOCKED", reasonCode: "sticker_changed" }, "sticker_changed"],
  ["permission message", { code: "CHAT_CANCELLED", message: "permission_changed" }, "permission_changed"],
  ["preferences code", { code: "preferences_changed" }, "preferences_changed"],
  ["privacy marker", { code: "STICKER_PRIVACY_CHANGED", reasonCode: "policy_changed" }, "privacy_changed"],
  ["unknown reason code", { code: "synthetic-opaque-code", reasonCode: "synthetic-opaque-reason" }, "task_cancelled"],
  ["non-string reason", { code: "CHAT_CANCELLED", reasonCode: { private: "synthetic-opaque-value" } }, "task_cancelled"],
]) {
  test("NapCat stopReason safely preserves " + name + " without exposing arbitrary error details", async () => {
    let allowed = true;
    let calls = 0;
    const output = await sendStickerDecision(decision(sticker()), contexts[0].value, {
      ensureAllowed: () => { if (!allowed) throw Object.assign(new Error("synthetic private error detail"), fault,
        { body: "synthetic private body" }); },
      ...transport(contexts[0].value, async (_target, _message, options) => {
        calls++;
        allowed = false;
        const reason = options.stopReason();
        assert.equal(reason, expected);
        return { status: "cancelled", reason };
      }),
    });
    assert.equal(calls, 1);
    assertOutcome(output, "cancelled", "send_cancelled");
    assert.equal(output.result.reason, expected);
    assert.equal(output.guardStopped, true);
    assert.doesNotMatch(JSON.stringify(output), /synthetic private|synthetic-opaque/);
  });
}

test("NapCat stopReason still identifies an actual privacy generation change", async () => {
  const output = await sendStickerDecision(decision(sticker()), contexts[1].value,
    transport(contexts[1].value, async (_target, _message, options) => {
      invalidateMemoryPrivacyGeneration();
      assert.equal(options.stopReason(), "privacy_changed");
      return { status: "cancelled", reason: options.stopReason() };
    }));
  assertOutcome(output, "cancelled", "send_cancelled");
  assert.equal(output.result.reason, "privacy_changed");
});

for (const { name, value: context } of contexts) {
  test(name + " default NapCat transport keeps actual ledger receipts and unknown-delivery replay fences", async t => {
    for (const kind of ["sent", "fallback", "unknown"]) {
      const scope = { surface: name, userId: context.userId, groupId: context.groupId, messageId: ++sequence };
      const cfg = { ...CFG, groupWhitelist: [602], friendWhitelist: [601], botBlacklist: [] };
      const ledger = createChatDeliveryLedger({ filename: path.join(root, "ledger-" + sequence + ".json") });
      const types = [];
      t.mock.method(globalThis, "fetch", async (url, options) => {
        assert.equal(url.endsWith(name === "group" ? "/send_group_msg" : "/send_private_msg"), true);
        const message = JSON.parse(options.body).message;
        types.push(message[0].type);
        const receipt = kind === "unknown" ? unknown() : kind === "fallback" && types.length === 1 ? failed() : sent();
        return { ok: true, json: async () => receipt };
      });
      const output = await withChatRun(scope, async () => {
        const result = await sendStickerDecision(decision(sticker()), context);
        noteChatOutcome({ kind: "reply" });
        return result;
      }, { cfg, ledger });
      assertOutcome(output, kind === "unknown" ? "unknown" : "sent", kind === "unknown" ? "send_unknown" : "sent");
      assert.deepEqual(types, kind === "fallback" ? ["mface", "image"] : ["mface"]);
      const record = ledger.find(scope);
      assert.equal(record.attempts, types.length);
      assert.equal(record.confirmed, kind === "unknown" ? 0 : 1);
      assert.equal(record.status, kind === "unknown" ? "unknown" : kind === "fallback" ? "partial" : "sent");
      const duplicate = await withChatRun(scope, () => assert.fail("a terminal or unknown event was replayed"), { cfg, ledger });
      assert.equal(duplicate.reason, "reply_duplicate");
      assert.equal(types.length, kind === "fallback" ? 2 : 1);
    }
  });
}

test("chat-run destination checks block a mismatched recipient even with an injected sender", async () => {
  const scope = { surface: "group", groupId: 602, userId: 601 };
  const cfg = { ...CFG, groupWhitelist: [602], friendWhitelist: [601], botBlacklist: [] };
  const output = await withChatRun(scope, () => sendStickerDecision(decision(sticker()), { ...contexts[0].value, groupId: 603 },
    transport(contexts[0].value, () => assert.fail("mismatched recipient reached transport"))), { cfg });
  assert.equal(output.kind, "cancelled");
  assert.equal(output.reason, "recipient_mismatch");
});

test("late chat-run privacy cancellation does not erase the sender's physical success receipt", async () => {
  const scope = { surface: "group", groupId: 602, userId: 601 };
  const cfg = { ...CFG, groupWhitelist: [602], friendWhitelist: [601], botBlacklist: [] };
  let physical;
  const output = await withChatRun(scope, async () => {
    physical = await sendStickerDecision(decision(sticker()), contexts[0].value,
      transport(contexts[0].value, async () => { invalidateMemoryPrivacyGeneration(); return sent(); }));
    return physical;
  }, { cfg });
  assertOutcome(physical, "sent", "sent");
  assert.equal(physical.guardStopped, true);
  assert.equal(output.kind, "cancelled");
  assert.equal(output.reason, "privacy_changed");
});
