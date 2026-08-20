import { createClockJumpMonitor, monotonicNow } from "./runtime-clock.mjs";

const clockMonitor = createClockJumpMonitor();
const counters = {
  received: 0,
  accepted: 0,
  processed: 0,
  failed: 0,
  outboundAttempts: 0,
  outboundSuccesses: 0,
};
const droppedByReason = Object.create(null);
const stamps = Object.create(null);
const link = {
  connected: false,
  generation: 0,
  queueDepth: 0,
  activeScopes: 0,
  lastDisconnectReason: "not_connected",
};

export function markInboundEvent() {
  clockMonitor.sample();
  counters.received++;
  stamp("lastEvent");
}

export function markEventAccepted() {
  counters.accepted++;
  stamp("lastAccepted");
}

export function markEventDropped(reason) {
  const key = String(reason || "unknown");
  droppedByReason[key] = Number(droppedByReason[key] || 0) + 1;
}

export function markEventProcessed() {
  counters.processed++;
  stamp("lastProcessed");
}

export function markEventFailed() {
  counters.failed++;
  stamp("lastFailure");
}

export function markOutboundAttempt() {
  counters.outboundAttempts++;
  stamp("lastSendAttempt");
}

export function markOutboundSuccess() {
  counters.outboundSuccesses++;
  stamp("lastSend");
}

export function updateOneBotLink(patch = {}) {
  const wasConnected = link.connected;
  Object.assign(link, patch);
  if (!wasConnected && link.connected) stamp("lastConnected");
  if (wasConnected && !link.connected) stamp("lastDisconnected");
  if (patch.message === true) stamp("lastWsMessage");
  if (patch.pong === true) stamp("lastPong");
  delete link.message;
  delete link.pong;
}

export function getPipelineStatus() {
  const nowMono = monotonicNow();
  return {
    counters: { ...counters },
    droppedByReason: { ...droppedByReason },
    timestamps: Object.fromEntries(
      Object.entries(stamps).map(([key, value]) => [key, {
        at: value.wallIso,
        ageMs: Math.max(0, Math.round(nowMono - value.monoMs)),
      }])
    ),
    clock: clockMonitor.status(),
    link: { ...link },
  };
}

export function resetPipelineStatusForTest() {
  for (const key of Object.keys(counters)) counters[key] = 0;
  for (const key of Object.keys(droppedByReason)) delete droppedByReason[key];
  for (const key of Object.keys(stamps)) delete stamps[key];
  Object.assign(link, {
    connected: false,
    generation: 0,
    queueDepth: 0,
    activeScopes: 0,
    lastDisconnectReason: "not_connected",
  });
}

function stamp(name) {
  stamps[name] = {
    wallIso: new Date().toISOString(),
    monoMs: monotonicNow(),
  };
}
