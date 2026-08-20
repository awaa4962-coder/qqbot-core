import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { EventEmitter } from "node:events";
import { setTimeout } from "node:timers";
import { describe, it } from "node:test";

import { createOneBotLinkManager } from "../bridge/onebot-link.mjs";

describe("OneBot link manager", () => {
  it("replaces old generations and ignores their late messages", async () => {
    const processed = [];
    const manager = createOneBotLinkManager({
      processor: async event => processed.push(event.message_id),
      setIntervalFn: () => ({ unref() {} }),
      clearIntervalFn() {},
    });
    const first = new FakeSocket();
    const second = new FakeSocket();
    manager.attach(first);
    manager.attach(second);
    first.emit("message", jsonEvent(1, 100));
    second.emit("message", jsonEvent(2, 100));
    await waitFor(() => manager.status().queueDepth === 0);

    assert.equal(first.closed, true);
    assert.deepEqual(processed, [2]);
    assert.equal(manager.status().staleMessages, 1);
    await manager.stop({ drainMs: 0 });
  });

  it("preserves order inside a group while allowing another group to progress", async () => {
    const started = [];
    const releases = new Map();
    const manager = createOneBotLinkManager({
      processor: event => new Promise(resolve => {
        started.push(event.message_id);
        releases.set(event.message_id, resolve);
      }),
      setIntervalFn: () => ({ unref() {} }),
      clearIntervalFn() {},
    });
    const socket = new FakeSocket();
    manager.attach(socket);
    socket.emit("message", jsonEvent(1, 100));
    socket.emit("message", jsonEvent(2, 100));
    socket.emit("message", jsonEvent(3, 200));
    await waitFor(() => started.length === 2);

    assert.deepEqual(started, [1, 3]);
    releases.get(1)();
    await waitFor(() => started.includes(2));
    assert.deepEqual(started, [1, 3, 2]);
    releases.get(2)();
    releases.get(3)();
    await waitFor(() => manager.status().queueDepth === 0);
    await manager.stop({ drainMs: 0 });
  });

  it("marks a half-open socket unavailable after a missed pong", async () => {
    let now = 0;
    let heartbeat;
    const manager = createOneBotLinkManager({
      processor: async () => {},
      now: () => now,
      pingIntervalMs: 1000,
      pongTimeoutMs: 1000,
      setIntervalFn: callback => {
        heartbeat = callback;
        return { unref() {} };
      },
      clearIntervalFn() {},
    });
    const socket = new FakeSocket();
    manager.attach(socket);
    now = 1000;
    heartbeat();
    assert.equal(socket.pings, 1);
    assert.equal(manager.status().ready, true);
    now = 2000;
    heartbeat();
    assert.equal(socket.terminated, true);
    assert.equal(manager.status().ready, false);
    assert.equal(manager.status().heartbeatTimeouts, 1);
    await manager.stop({ drainMs: 0 });
  });

  it("bounds pending work instead of growing without limit", async () => {
    let release;
    const manager = createOneBotLinkManager({
      processor: () => new Promise(resolve => { release = resolve; }),
      maxQueue: 1,
      setIntervalFn: () => ({ unref() {} }),
      clearIntervalFn() {},
    });
    assert.equal(manager.enqueue({ message_type: "group", group_id: 1 }).valueOf(), true);
    assert.equal(manager.enqueue({ message_type: "group", group_id: 2 }).valueOf(), false);
    await waitFor(() => typeof release === "function");
    release();
    await waitFor(() => manager.status().queueDepth === 0);
    assert.equal(manager.status().queueDropped, 1);
    await manager.stop({ drainMs: 0 });
  });
});

class FakeSocket extends EventEmitter {
  readyState = 1;
  closed = false;
  terminated = false;
  pings = 0;

  close() {
    this.closed = true;
    this.readyState = 3;
  }

  terminate() {
    this.terminated = true;
    this.readyState = 3;
  }

  ping() {
    this.pings++;
  }
}

function jsonEvent(messageId, groupId) {
  return Buffer.from(JSON.stringify({
    post_type: "message",
    message_type: "group",
    message_id: messageId,
    group_id: groupId,
    user_id: 10,
    message: [],
  }));
}

async function waitFor(predicate) {
  for (let i = 0; i < 50; i++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  throw new Error("condition not reached");
}
