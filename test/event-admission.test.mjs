import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createEventAdmissionController } from "../bridge/event-admission.mjs";
import {
  createClockJumpMonitor,
  createFixedWindowLimiter,
  wallAgeMs,
} from "../bridge/runtime-clock.mjs";

const cfg = {
  selfUin: 999,
  groupWhitelist: [100, 200],
  botBlacklist: [666],
  adminUins: [42],
};

describe("event admission", () => {
  it("resets fixed windows after a backward clock sample", () => {
    let now = 1000;
    const limiter = createFixedWindowLimiter({ limit: 2, windowMs: 1000, now: () => now });
    assert.equal(limiter.take("group").ok, true);
    assert.equal(limiter.take("group").ok, true);
    assert.equal(limiter.take("group").ok, false);

    now = 100;
    assert.equal(limiter.take("group").ok, true);
  });

  it("keeps rejected groups out of permitted group quotas", () => {
    let now = 100;
    const events = telemetry();
    const controller = createEventAdmissionController({
      cfg,
      now: () => now,
      ingressLimit: 50,
      scopeLimit: 2,
      telemetry: events.api,
    });
    for (let i = 0; i < 10; i++) {
      assert.equal(controller.admit(groupContext(300)).reason, "group_not_whitelisted");
    }
    assert.equal(controller.admit(groupContext(100)).ok, true);
    assert.equal(controller.admit(groupContext(100)).ok, true);
    assert.equal(controller.admit(groupContext(100)).reason, "scope_rate_limited");
    assert.equal(events.accepted, 2);
    assert.equal(events.dropped.group_not_whitelisted, 10);
    assert.equal(now, 100);
  });

  it("uses independent per-group and priority lanes", () => {
    const events = telemetry();
    const controller = createEventAdmissionController({
      cfg,
      now: () => 100,
      ingressLimit: 50,
      scopeLimit: 1,
      priorityLimit: 1,
      telemetry: events.api,
    });
    assert.equal(controller.admit(groupContext(100)).ok, true);
    assert.equal(controller.admit(groupContext(100)).reason, "scope_rate_limited");
    assert.equal(controller.admit(groupContext(200)).ok, true);
    assert.equal(controller.admit(groupContext(100, { isAtMe: true })).ok, true);
    assert.equal(controller.admit(groupContext(100, { isAtMe: true })).reason, "priority_rate_limited");
  });

  it("rejects self and blacklisted messages before routed quotas", () => {
    const events = telemetry();
    const controller = createEventAdmissionController({ cfg, telemetry: events.api });
    assert.equal(controller.admit(groupContext(100, { user_id: 999 })).reason, "self_message");
    assert.equal(controller.admit(groupContext(100, { user_id: 666 })).reason, "blacklisted_user");
  });

  it("deduplicates the same message id across delivery channels", () => {
    let now = 100;
    const events = telemetry();
    const controller = createEventAdmissionController({
      cfg,
      now: () => now,
      dedupeTtlMs: 1000,
      telemetry: events.api,
    });
    const message = groupContext(100, { message_id: 777 });
    assert.equal(controller.admit(message).ok, true);
    assert.equal(controller.admit(message).reason, "duplicate_event");
    assert.equal(controller.admit(groupContext(200, { message_id: 777 })).ok, true);
    now += 1001;
    assert.equal(controller.admit(message).ok, true);
  });
});

describe("clock jump monitor", () => {
  it("reports backward and forward wall-clock steps against monotonic time", () => {
    let wall = 10_000;
    let mono = 100;
    const monitor = createClockJumpMonitor({
      wallNow: () => wall,
      monoNow: () => mono,
      thresholdMs: 500,
    });

    wall += 1000;
    mono += 1000;
    assert.equal(monitor.sample(), null);
    wall -= 8000;
    mono += 1000;
    assert.equal(monitor.sample().direction, "backward");
    wall += 12_000;
    mono += 1000;
    assert.equal(monitor.sample().direction, "forward");
    assert.equal(monitor.status().jumps, 2);
  });
});

it("wall age rejects far-future persisted timestamps", () => {
  assert.equal(wallAgeMs(9000, 10_000), 1000);
  assert.equal(wallAgeMs(10_002, 10_000), 0);
  assert.equal(wallAgeMs(20_000, 10_000), Number.POSITIVE_INFINITY);
});

function groupContext(groupId, patch = {}) {
  return {
    message_type: "group",
    group_id: groupId,
    user_id: 1,
    isAtMe: false,
    ...patch,
  };
}

function telemetry() {
  const state = { received: 0, accepted: 0, dropped: Object.create(null) };
  state.api = {
    received() { state.received++; },
    accepted() { state.accepted++; },
    dropped(reason) { state.dropped[reason] = Number(state.dropped[reason] || 0) + 1; },
  };
  return state;
}
