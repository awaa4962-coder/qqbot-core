import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  buildInterjectionDecision,
  buildInterjectionFallback,
  classifyInterjectionTrigger,
  shouldInterject,
} from "../bridge/interjection-policy.mjs";

function state() {
  return {
    lastGroupAt: new Map(),
    lastUserAt: new Map(),
    groupMessagesSinceInterjection: new Map(),
  };
}

describe("interjection policy", () => {
  it("allows ordinary messages only at low probability", () => {
    assert.equal(classifyInterjectionTrigger("ordinary apple message"), "ordinary");
    assert.equal(shouldInterject("ordinary apple message", { random: () => 0.99 }, state()), false);
    assert.equal(shouldInterject("ordinary apple message", { random: () => 0.01 }, state()), true);
  });

  it("allows direct-but-not-at messages with higher probability", () => {
    assert.equal(classifyInterjectionTrigger("QQFriend are you there?"), "direct_but_not_at");
    assert.equal(shouldInterject("QQFriend are you there?", { random: () => 0.20 }, state()), true);
    assert.equal(shouldInterject("QQFriend are you there?", { random: () => 0.99 }, state()), false);
  });

  it("applies group tolerance probability factor", () => {
    const lowered = buildInterjectionDecision("QQFriend are you there?", {
      groupId: 1,
      userId: 2,
      now: 1000000,
      probabilityFactor: 0.5,
      random: () => 0.40,
    }, state());
    assert.equal(lowered.ok, false);
    assert.equal(lowered.probability, 0.3);

    const raised = buildInterjectionDecision("QQFriend are you there?", {
      groupId: 1,
      userId: 2,
      now: 1000000,
      probabilityFactor: 1.3,
      random: () => 0.70,
    }, state());
    assert.equal(raised.ok, true);
    assert.equal(raised.probability, 0.78);
  });

  it("allows image-only messages at low frequency", () => {
    assert.equal(classifyInterjectionTrigger("", { hasImages: true }), "image");
    assert.equal(shouldInterject("", { hasImages: true, random: () => 0.01 }, state()), true);
  });

  it("never triggers on empty or too-short text without images", () => {
    assert.equal(shouldInterject("", { random: () => 0 }, state()), false);
    assert.equal(shouldInterject("hi", { random: () => 0 }, state()), false);
    assert.deepEqual(buildInterjectionDecision("", { random: () => 0 }, state()), {
      ok: false,
      kind: "empty",
      reason: "empty",
      probability: 0,
    });
    assert.deepEqual(buildInterjectionDecision("hi", { random: () => 0 }, state()), {
      ok: false,
      kind: "short",
      reason: "short",
      probability: 0,
    });
  });

  it("blocks during cooldown", () => {
    const s = state();
    const ctx = { groupId: 1, userId: 2, now: 1000000, random: () => 0.01 };
    assert.equal(shouldInterject("QQFriend are you there?", ctx, s), true);
    assert.equal(shouldInterject("QQFriend are you there?", { ...ctx, now: 1001000 }, s), false);
  });

  it("exposes skip reasons for debugging", () => {
    const decision = buildInterjectionDecision("QQFriend are you there?", {
      isAtMe: true,
      random: () => 0,
    }, state());
    assert.deepEqual(decision, {
      ok: false,
      kind: "blocked",
      reason: "mentioned",
      probability: 0,
    });
  });

  it("does not fallback for ordinary messages", () => {
    assert.equal(buildInterjectionFallback("ordinary apple message", "model_failed"), null);
  });

  it("emotion fallback is short and safe", () => {
    const reply = buildInterjectionFallback("555555", "model_failed");
    assert.ok(reply);
    assert.ok(reply.length <= 20);
  });
});

describe("interjection cooldown isolation", () => {
  it("keeps group cooldown isolated", () => {
    const s = state();
    assert.equal(shouldInterject("QQFriend are you there?", { groupId: 1, userId: 1, now: 1000000, random: () => 0.01 }, s), true);
    assert.equal(shouldInterject("QQFriend are you there?", { groupId: 2, userId: 2, now: 1001000, random: () => 0.01 }, s), true);
  });

  it("keeps user cooldown isolated", () => {
    const s = state();
    assert.equal(shouldInterject("QQFriend are you there?", { groupId: 1, userId: 1, now: 1000000, random: () => 0.01 }, s), true);
    assert.equal(shouldInterject("QQFriend are you there?", { groupId: 2, userId: 2, now: 1001000, random: () => 0.01 }, s), true);
  });

  it("blocks same user across groups during user cooldown", () => {
    const s = state();
    assert.equal(shouldInterject("QQFriend are you there?", { groupId: 1, userId: 1, now: 1000000, random: () => 0.01 }, s), true);
    assert.equal(shouldInterject("QQFriend are you there?", { groupId: 2, userId: 1, now: 1001000, random: () => 0.01 }, s), false);
  });
});
