import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { after, afterEach, beforeEach, test } from "node:test";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "qqfriend-vision-flight-"));
Object.assign(process.env, { NODE_ENV: "test", QQBOT_CONFIG_ROOT: root,
  QQBOT_DATA_DIR: path.join(root, "data"), QQBOT_LOG_DIR: path.join(root, "logs") });
const { describeVisionImages } = await import("../bridge/vision.mjs");
const { clearVisionDescriptionCache, getVisionDescriptionCacheStatus } = await import("../bridge/vision/description-cache.mjs");
const { invalidateMemoryPrivacyGeneration } = await import("../bridge/memory-profile/generation.mjs");
const { withChatRun, assertChatRunCurrent } = await import("../bridge/cognition/chat-run.mjs");
const { CFG } = await import("../bridge/config.mjs");

const scope = { surface: "group", userId: "601", groupId: "701" };
const provider = id => ({ id, model: "synthetic-vision", protocol: "openai-chat", auth: "none",
  endpoint: "https://example.com/vision", enabled: true, capabilities: ["vision", "text"] });
const config = () => ({ providers: { primary: provider("primary"), fallback: provider("fallback") },
  routes: { vision: { primary: "primary", fallback: "fallback", reasoning: "economy" } } });
const image = () => ({ requested: 1, failed: 0, omitted: 0, images: [{ index: 1, width: 8, height: 8,
  animated: false, digest: "ab".repeat(32), content: { type: "image_url", image_url: { url: "data:image/jpeg;base64,c3ludGhldGlj" } } }] });
const raw = text => ({ ok: true, provider: "primary", raw: { choices: [{ message: { content: text } }] } });
const tick = () => Promise.resolve();
const settings = extra => ({ scope, config: config(), assertCurrent: () => {}, ...extra });
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }

beforeEach(t => {
  clearVisionDescriptionCache();
  t.mock.method(globalThis, "fetch", () => assert.fail("no real API or QQ requests"));
});
afterEach(() => clearVisionDescriptionCache());
after(() => fs.rmSync(root, { recursive: true, force: true }));

test("actual objective primary calls share once and a later cache hit is not another model call", async () => {
  const hold = deferred(); let calls = 0;
  const callSlot = async (_task, _position, request) => { calls++; assert.equal(request.beforeAttempt(), ""); await hold.promise; return raw("A red square."); };
  const first = describeVisionImages(image(), settings({ callSlot }));
  const second = describeVisionImages(image(), settings({ callSlot }));
  await tick(); assert.equal(calls, 1); hold.resolve();
  assert.equal((await first).text, "A red square.");
  assert.equal((await second).shared, true);
  const cached = await describeVisionImages(image(), settings({ callSlot }));
  assert.equal(cached.cached, true); assert.equal(cached.shared, undefined); assert.equal(calls, 1);
  const status = getVisionDescriptionCacheStatus();
  assert.equal(status.entries, 1); assert.equal(status.hits, 1); assert.equal(status.misses, 1);
});

for (const difference of ["user", "group", "digest", "model", "layout", "reasoning"]) {
  test("objective flights stay separate across " + difference + " boundaries", async () => {
    const hold = deferred(); let calls = 0;
    const callSlot = async () => { calls++; await hold.promise; return raw("A blue square."); };
    const secondImage = image(); const second = settings({ callSlot });
    if (difference === "user") second.scope = { ...scope, userId: "602" };
    if (difference === "group") second.scope = { ...scope, groupId: "702" };
    if (difference === "digest") secondImage.images[0].digest = "cd".repeat(32);
    if (difference === "model") second.config.providers.primary.model = "different-model";
    if (difference === "layout") secondImage.images[0].index = 2;
    if (difference === "reasoning") second.config.routes.vision.reasoning = "deep";
    const a = describeVisionImages(image(), settings({ callSlot })); const b = describeVisionImages(secondImage, second);
    await tick(); assert.equal(calls, 2); hold.resolve();
    assert.equal((await a).shared, undefined); assert.equal((await b).shared, undefined);
  });
}

test("one caller cancellation does not abort the shared provider or another caller", async () => {
  const hold = deferred(); const controller = new globalThis.AbortController(); let signal; let calls = 0;
  const callSlot = async (_task, _position, request) => { calls++; signal = request.signal; await hold.promise; return raw("A green square."); };
  const a = describeVisionImages(image(), settings({ callSlot, signal: controller.signal }));
  const b = describeVisionImages(image(), settings({ callSlot }));
  await tick(); controller.abort(); assert.equal((await a).text, ""); assert.equal(signal.aborted, false);
  hold.resolve(); assert.equal((await b).text, "A green square."); assert.equal(calls, 1);
  assert.equal(getVisionDescriptionCacheStatus().entries, 1);
});

test("all callers cancelling reject a late provider result without cache or fallback", async () => {
  const hold = deferred(); const a = new globalThis.AbortController(); const b = new globalThis.AbortController();
  let signal; const positions = [];
  const callSlot = async (_task, position, request) => { positions.push(position); signal = request.signal; await hold.promise; return raw("Do not retain this."); };
  const first = describeVisionImages(image(), settings({ callSlot, signal: a.signal }));
  const second = describeVisionImages(image(), settings({ callSlot, signal: b.signal }));
  await tick(); a.abort(); b.abort(); assert.equal((await first).text, ""); assert.equal((await second).text, "");
  assert.equal(signal.aborted, true); hold.resolve(); await tick(); await tick(); await tick();
  assert.equal(getVisionDescriptionCacheStatus().entries, 0); assert.deepEqual(positions, ["primary"]);
});

test("privacy invalidation cancels every waiter and prevents stale cache writes", async () => {
  const hold = deferred(); let calls = 0;
  const callSlot = async () => { calls++; await hold.promise; return raw("Late private data."); };
  const a = describeVisionImages(image(), settings({ callSlot })); const b = describeVisionImages(image(), settings({ callSlot }));
  await tick(); invalidateMemoryPrivacyGeneration();
  assert.equal((await a).text, ""); assert.equal((await b).text, "");
  hold.resolve(); await tick(); await tick(); await tick(); assert.equal(calls, 1);
  assert.equal(getVisionDescriptionCacheStatus().entries, 0);
});

test("expired first source cannot stop a valid second source or authorize its own result", async () => {
  const hold = deferred(); let current = true;
  const callSlot = async () => { await hold.promise; return raw("A visible letter."); };
  const a = describeVisionImages(image(), settings({ callSlot, assertCurrent: () => {
    if (!current) throw Object.assign(new Error("memory_expired"), { code: "CHAT_CANCELLED" });
  } }));
  const rejected = assert.rejects(a, /memory_expired/);
  const b = describeVisionImages(image(), settings({ callSlot }));
  await tick(); current = false; hold.resolve(); await rejected;
  assert.equal((await b).text, "A visible letter."); assert.equal(getVisionDescriptionCacheStatus().entries, 1);
});

test("expired sources for all waiters cannot write an objective cache entry", async () => {
  const hold = deferred(); let current = true;
  const callSlot = async () => { await hold.promise; return raw("Expired sources."); };
  const opts = settings({ callSlot, assertCurrent: () => {
    if (!current) throw Object.assign(new Error("memory_expired"), { code: "CHAT_CANCELLED" });
  } });
  const a = describeVisionImages(image(), opts); const b = describeVisionImages(image(), opts);
  const rejected = Promise.all([assert.rejects(a, /memory_expired/), assert.rejects(b, /memory_expired/)]);
  await tick(); current = false; hold.resolve(); await rejected;
  assert.equal(getVisionDescriptionCacheStatus().entries, 0);
});

test("mutating provider options while awaiting cannot label the old result with the new model", async () => {
  const cfg = config(); let calls = 0;
  const callSlot = async () => { calls++; cfg.providers.primary.model = "new-model"; return raw("A black square."); };
  await describeVisionImages(image(), settings({ config: cfg, callSlot }));
  await describeVisionImages(image(), settings({ config: cfg, callSlot }));
  assert.equal(calls, 2);
});

test("queued dispatch uses the same immutable model snapshot as its cache identity", async t => {
  const cfg = config(); cfg.providers.primary.model = "model-A";
  const models = [];
  t.mock.method(globalThis, "fetch", async (_url, init) => {
    const body = JSON.parse(init.body); models.push(body.model);
    return new globalThis.Response(JSON.stringify({ choices: [{ message: { content: "Caption from " + body.model } }] }),
      { status: 200, headers: { "Content-Type": "application/json" } });
  });
  const pending = describeVisionImages(image(), settings({ config: cfg }));
  cfg.providers.primary.model = "model-B";
  assert.equal((await pending).text, "Caption from model-A");
  cfg.providers.primary.model = "model-A";
  const cached = await describeVisionImages(image(), settings({ config: cfg }));
  assert.equal(cached.cached, true); assert.equal(cached.text, "Caption from model-A");
  assert.deepEqual(models, ["model-A"]);
});

test("uncloneable configuration fails before transport without echoing its private function", async () => {
  const cfg = config(); cfg.providers.primary.privateHook = () => "PRIVATE_CONFIG_SECRET";
  const output = await describeVisionImages(image(), settings({ config: cfg,
    callSlot: async () => assert.fail("invalid configuration must not dispatch") }));
  assert.deepEqual(output, { ok: false, text: "", cached: false, reason: "vision_configuration_invalid" });
  assert.doesNotMatch(JSON.stringify(output), /PRIVATE_CONFIG_SECRET|privateHook/);
});

test("real chat-run cancellation does not leak its async context into a surviving command waiter", async () => {
  const cfg = { ...CFG, groupWhitelist: [scope.groupId], blacklist: [], userBlacklist: [] };
  const hold = deferred(); let calls = 0; let signal;
  const callSlot = async (_task, _position, request) => { calls++; signal = request.signal; await hold.promise; return raw("A purple square."); };
  const a = withChatRun(scope, () => describeVisionImages(image(), settings({ callSlot, assertCurrent: assertChatRunCurrent })), { cfg });
  const b = withChatRun({ ...scope, lane: "command" }, () => describeVisionImages(image(), settings({ callSlot, assertCurrent: assertChatRunCurrent })), { cfg });
  await tick(); await withChatRun(scope, async () => ({ kind: "silence" }), { cfg });
  assert.equal((await a).kind, "cancelled"); assert.equal(signal.aborted, false);
  hold.resolve(); assert.equal((await b).text, "A purple square."); assert.equal(calls, 1);
});
