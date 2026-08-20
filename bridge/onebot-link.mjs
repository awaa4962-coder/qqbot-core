import {
  clearInterval as nodeClearInterval,
  clearTimeout as nodeClearTimeout,
  setInterval as nodeSetInterval,
  setTimeout as nodeSetTimeout,
} from "node:timers";
import { monotonicNow } from "./runtime-clock.mjs";
import { markEventDropped, updateOneBotLink } from "./pipeline-state.mjs";

const OPEN = 1;
const DEFAULT_MAX_QUEUE = 1000;
const DEFAULT_PING_INTERVAL_MS = 30_000;
const DEFAULT_PONG_TIMEOUT_MS = 20_000;

export function createOneBotLinkManager(options = {}) {
  return new OneBotLinkManager(options);
}

class OneBotLinkManager {
  constructor(options) {
    if (typeof options.processor !== "function") throw new TypeError("processor is required");
    this.processor = options.processor;
    this.log = options.log || (() => {});
    this.logError = options.logError || (() => {});
    this.now = options.now || monotonicNow;
    this.setInterval = options.setIntervalFn || nodeSetInterval;
    this.clearInterval = options.clearIntervalFn || nodeClearInterval;
    this.maxQueue = Math.max(1, Number(options.maxQueue || DEFAULT_MAX_QUEUE));
    this.pingIntervalMs = Math.max(1000, Number(options.pingIntervalMs || DEFAULT_PING_INTERVAL_MS));
    this.pongTimeoutMs = Math.max(1000, Number(options.pongTimeoutMs || DEFAULT_PONG_TIMEOUT_MS));
    this.chains = new Map();
    this.active = null;
    this.generation = 0;
    this.queueDepth = 0;
    this.lastAliveMono = 0;
    this.lastPingMono = 0;
    this.awaitingPong = false;
    this.heartbeatTimer = null;
    this.stopped = false;
    this.counters = {
      connections: 0,
      replacements: 0,
      messages: 0,
      parseErrors: 0,
      staleMessages: 0,
      queueDropped: 0,
      heartbeatTimeouts: 0,
    };
  }

  attach(ws) {
    if (this.stopped) {
      safeClose(ws, 1012, "bridge stopping");
      return 0;
    }
    const previous = this.active;
    this.generation++;
    const currentGeneration = this.generation;
    this.active = ws;
    this.counters.connections++;
    this.lastAliveMono = Number(this.now());
    this.lastPingMono = this.lastAliveMono;
    this.awaitingPong = false;
    this._publish({ connected: true, generation: this.generation, lastDisconnectReason: "" });
    this._replacePrevious(previous, ws);
    this.log("WebSocket client connected, generation", this.generation);
    this._bindSocket(ws, currentGeneration);
    this._ensureHeartbeat();
    return currentGeneration;
  }

  enqueue(event) {
    if (this.queueDepth >= this.maxQueue) {
      this.counters.queueDropped++;
      markEventDropped("websocket_queue_full");
      this._publish();
      return false;
    }
    const scope = eventScope(event);
    const previous = this.chains.get(scope)?.promise || Promise.resolve();
    const token = {};
    this.queueDepth++;
    const promise = previous
      .catch(() => {})
      .then(() => this.processor(event))
      .catch(error => this.logError("WS processEvent error:", error.message))
      .finally(() => this._finishQueued(scope, token));
    this.chains.set(scope, { promise, token });
    this._publish();
    return true;
  }

  heartbeatTick() {
    if (!this.active || !isOpen(this.active)) return;
    const current = Number(this.now());
    if (this.awaitingPong && current - this.lastPingMono >= this.pongTimeoutMs) {
      this._terminateStaleSocket();
      return;
    }
    if (!this.awaitingPong && current - this.lastPingMono >= this.pingIntervalMs) {
      this._sendPing(current);
    }
  }

  status() {
    const current = Number(this.now());
    const connected = Boolean(this.active && isOpen(this.active));
    return {
      connected,
      ready: connected && this.queueDepth < this.maxQueue &&
        (!this.awaitingPong || current - this.lastPingMono < this.pongTimeoutMs),
      generation: this.generation,
      queueDepth: this.queueDepth,
      activeScopes: this.chains.size,
      maxQueue: this.maxQueue,
      awaitingPong: this.awaitingPong,
      heartbeatAgeMs: connected ? Math.max(0, Math.round(current - this.lastAliveMono)) : null,
      ...this.counters,
    };
  }

  async stop(options = {}) {
    this.stopped = true;
    if (this.heartbeatTimer) this.clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
    const socket = this.active;
    this.active = null;
    if (socket) closeEventually(socket, 1001, "bridge shutting down");
    this._publish({ connected: false, lastDisconnectReason: "bridge_shutdown" });
    const drainMs = Math.max(0, Number(options.drainMs ?? 10_000));
    if (!this.chains.size || !drainMs) return;
    await Promise.race([
      Promise.allSettled([...this.chains.values()].map(entry => entry.promise)),
      new Promise(resolve => nodeSetTimeout(resolve, drainMs)),
    ]);
  }

  _replacePrevious(previous, ws) {
    if (!previous || previous === ws || !isOpen(previous)) return;
    this.counters.replacements++;
    safeClose(previous, 1000, "replaced by new connection");
    this.log("WebSocket new client connected, closing previous client");
  }

  _bindSocket(ws, wsGeneration) {
    ws.on("message", data => this._handleMessage(ws, wsGeneration, data));
    ws.on("pong", () => this._markAlive(ws, wsGeneration, true));
    ws.on("ping", () => this._markAlive(ws, wsGeneration, false));
    ws.on("close", (code, reason) => this._handleClose(ws, wsGeneration, code, reason));
    ws.on("error", error => this._handleError(ws, wsGeneration, error));
  }

  _handleMessage(ws, wsGeneration, data) {
    if (!this._isCurrent(ws, wsGeneration)) {
      this.counters.staleMessages++;
      markEventDropped("stale_websocket_generation");
      return;
    }
    this._markAlive(ws, wsGeneration, false);
    this.counters.messages++;
    try {
      this.enqueue(JSON.parse(data.toString()));
    } catch (error) {
      this.counters.parseErrors++;
      markEventDropped("websocket_parse_error");
      this.logError("WS parse error:", error.message);
    }
  }

  _markAlive(ws, wsGeneration, pong) {
    if (!this._isCurrent(ws, wsGeneration)) return;
    this.lastAliveMono = Number(this.now());
    this.awaitingPong = false;
    this._publish(pong ? { pong: true } : { message: true });
  }

  _finishQueued(scope, token) {
    this.queueDepth--;
    if (this.chains.get(scope)?.token === token) this.chains.delete(scope);
    this._publish();
  }

  _sendPing(current) {
    try {
      this.active.ping();
      this.lastPingMono = current;
      this.awaitingPong = true;
    } catch (error) {
      this.logError("WS ping error:", error.message);
    }
  }

  _terminateStaleSocket() {
    this.counters.heartbeatTimeouts++;
    markEventDropped("websocket_heartbeat_timeout");
    const stale = this.active;
    this.active = null;
    this.awaitingPong = false;
    this._publish({ connected: false, lastDisconnectReason: "heartbeat_timeout" });
    try { stale.terminate(); } catch {}
  }

  _handleClose(ws, wsGeneration, code, reason) {
    if (!this._isCurrent(ws, wsGeneration)) return;
    this.active = null;
    this.awaitingPong = false;
    const detail = "close_" + String(code || 0) + (reason?.length ? ":" + reason.toString().slice(0, 80) : "");
    this._publish({ connected: false, lastDisconnectReason: detail });
    this.log("WebSocket client disconnected", detail);
  }

  _handleError(ws, wsGeneration, error) {
    if (!this._isCurrent(ws, wsGeneration)) return;
    this._publish({ lastDisconnectReason: "socket_error" });
    this.logError("WebSocket error:", error.message);
  }

  _ensureHeartbeat() {
    if (this.heartbeatTimer) return;
    this.heartbeatTimer = this.setInterval(
      () => this.heartbeatTick(),
      Math.min(this.pingIntervalMs, this.pongTimeoutMs),
    );
    this.heartbeatTimer?.unref?.();
  }

  _publish(patch = {}) {
    updateOneBotLink({
      connected: Boolean(this.active && isOpen(this.active)),
      generation: this.generation,
      queueDepth: this.queueDepth,
      activeScopes: this.chains.size,
      ...patch,
    });
  }

  _isCurrent(ws, wsGeneration) {
    return this.active === ws && this.generation === wsGeneration;
  }
}

function eventScope(event) {
  if (event?.message_type === "group") return "group:" + String(event.group_id || "unknown");
  if (event?.message_type === "private") return "private:" + String(event.user_id || "unknown");
  return "control";
}

function isOpen(ws) {
  return ws?.readyState === OPEN;
}

function safeClose(ws, code, reason) {
  try { ws.close(code, reason); } catch {}
}

function closeEventually(ws, code, reason) {
  safeClose(ws, code, reason);
  const timer = nodeSetTimeout(() => {
    if (ws?.readyState === 3) return;
    try { ws.terminate(); } catch {}
  }, 2000);
  timer.unref?.();
  ws?.once?.("close", () => nodeClearTimeout(timer));
}
