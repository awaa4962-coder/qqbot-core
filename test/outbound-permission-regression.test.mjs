import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { ReadableStream } from "node:stream/web";
import test from "node:test";
import { CFG } from "../bridge/config.mjs";
import { chatDeliveryLedger } from "../bridge/cognition/delivery-ledger.mjs";
import { invalidateMemoryPrivacyGeneration } from "../bridge/memory-profile/generation.mjs";
import { uploadGroupFile } from "../bridge/napcat.mjs";
import { processEvent } from "../bridge/reply.mjs";
import { handleResourceTransferCommand, listResourceTasks, stopResourceTasks, transferResourceToGroup, waitResourceTasks } from "../bridge/resource-transfer.mjs";

const origin = "https://outbound-fixture.invalid";
const resource = `${origin}/sample.txt`;
const image = `${origin}/cover.png`;
const groupId = CFG.groupWhitelist[0];
const userId = 601391;
const ok = { status: "ok", retcode: 0 };

function groupEvent(messageId, text, mentioned = false) {
  const message = [{ type: "text", data: { text } }];
  if (mentioned) message.unshift({ type: "at", data: { qq: String(CFG.selfUin) } });
  return { post_type: "message", message_type: "group", group_id: groupId, user_id: userId,
    message_id: messageId, time: Math.floor(Date.now() / 1000), sender: { nickname: "Fixture" },
    raw_message: mentioned ? `[CQ:at,qq=${CFG.selfUin}] ${text}` : text, message };
}

function pageResponse() {
  return new globalThis.Response(`<title>Synthetic preview</title><meta property="og:image" content="${image}">`, {
    headers: { "content-type": "text/html" },
  });
}

function delivery(event) {
  return chatDeliveryLedger().find({ surface: "group", groupId, userId, messageId: event.message_id });
}

test("HTTP auto-preview stops between page and image acquisition when group permission changes", async t => {
  const page = `${origin}/auto-preview`;
  const event = groupEvent(981391, page);
  const whitelist = CFG.groupWhitelist;
  t.after(() => { CFG.groupWhitelist = whitelist; });
  const requests = [];
  t.mock.method(globalThis, "fetch", async url => {
    requests.push(url);
    if (url !== page) throw new Error("unexpected request");
    CFG.groupWhitelist = [];
    return pageResponse();
  });

  assert.equal((await processEvent(event)).ok, true);
  assert.deepEqual(requests, [page]);
  assert.equal(delivery(event)?.status, "cancelled");
  assert.equal(delivery(event)?.attempts, 0);
});

test("HTTP explicit preview stops after image acquisition when privacy changes", async t => {
  const page = `${origin}/explicit-preview`;
  const event = groupEvent(981392, `preview ${page}`, true);
  const requests = [];
  t.mock.method(globalThis, "fetch", async url => {
    requests.push(url);
    if (url === page) return pageResponse();
    if (url === image) {
      invalidateMemoryPrivacyGeneration();
      return new globalThis.Response("fixture image", { headers: { "content-type": "image/png" } });
    }
    throw new Error("unexpected request");
  });

  assert.equal((await processEvent(event)).ok, true);
  assert.deepEqual(requests, [page, image]);
  assert.equal(delivery(event)?.status, "cancelled");
  assert.equal(delivery(event)?.attempts, 0);
});

test("an authorized HTTP preview reaches the real outbound request and records its receipt", async t => {
  const page = `${origin}/authorized-preview`;
  const event = groupEvent(981393, `preview ${page}`, true);
  const sends = [];
  t.mock.method(globalThis, "fetch", async (url, request) => {
    if (url === page) return new globalThis.Response("<title>Authorized preview</title>");
    sends.push({ url, payload: JSON.parse(request.body) });
    return globalThis.Response.json(ok);
  });

  assert.equal((await processEvent(event)).ok, true);
  assert.equal(sends.length, 1);
  assert.equal(sends[0].url, CFG.napcatApi + "/send_group_msg");
  assert.equal(sends[0].payload.group_id, groupId);
  assert.equal(sends[0].payload.message[0].data.id, event.message_id);
  assert.equal(delivery(event)?.status, "sent");
});

function stagedNapCatUpload(streamUploader) {
  return (id, file, name, options) => uploadGroupFile(id, file, name, {
    ...options, wsUrl: "ws://staging-fixture.invalid", streamRequired: true, streamUploader,
  });
}

test("resource task rechecks both allowlists at the real final upload request without replaying", async t => {
  const originalGroups = CFG.groupWhitelist;
  const originalResources = CFG.resourceGroupWhitelist;
  t.after(() => { CFG.groupWhitelist = originalGroups; CFG.resourceGroupWhitelist = originalResources; });
  const requests = [];
  t.mock.method(globalThis, "fetch", async url => {
    requests.push(url);
    return url === resource ? new globalThis.Response("fixture data") : globalThis.Response.json(ok);
  });

  for (const [index, policy] of ["groupWhitelist", "resourceGroupWhitelist"].entries()) {
    CFG.groupWhitelist = [groupId];
    CFG.resourceGroupWhitelist = [groupId];
    let pathDuringStaging;
    const uploader = stagedNapCatUpload(file => {
      pathDuringStaging = file;
      CFG[policy] = [];
      return { filePath: "/synthetic/staged.txt" };
    });
    const ctx = { isAtMe: true, group_id: groupId, user_id: userId, message_id: 981395 + index };
    const options = { parsedCommand: { ok: true, url: resource }, uploader, trackUploadDispatch: true };
    assert.equal(await handleResourceTransferCommand(ctx, options), true);
    await waitResourceTasks();
    assert.match(listResourceTasks().at(-1).error, /权限已变化/u);
    assert.ok(pathDuringStaging);
    assert.equal(fs.existsSync(pathDuringStaging), false);
    CFG[policy] = [groupId];
    assert.equal(await handleResourceTransferCommand(ctx, options), true);
    await waitResourceTasks();
  }
  assert.deepEqual(requests, Array.from({ length: 2 }, () => [
    CFG.napcatApi + "/send_group_msg", resource, CFG.napcatApi + "/send_group_msg",
  ]).flat());
});

test("resource cancellation during NapCat staging is definitive and submits nothing", async t => {
  const controller = new globalThis.AbortController();
  const requests = [];
  let stagedFile, stagingSignal;
  t.mock.method(globalThis, "fetch", async url => {
    requests.push(url);
    return new globalThis.Response("fixture data");
  });
  const result = await transferResourceToGroup({ groupId, url: resource, signal: controller.signal,
    trackUploadDispatch: true, uploader: stagedNapCatUpload((file, options) => {
      stagedFile = file;
      stagingSignal = options.signal;
      controller.abort();
      return { filePath: "/synthetic/staged.txt" };
    }) });
  assert.deepEqual(result, { ok: false, reason: "cancelled" });
  assert.equal(stagingSignal?.aborted, true);
  assert.ok(stagedFile);
  assert.equal(fs.existsSync(stagedFile), false);
  assert.deepEqual(requests, [resource]);
});

test("resource cancellation after real upload dispatch is unconfirmed and never replays", async t => {
  const originalWs = CFG.napcatWsApi;
  CFG.napcatWsApi = "";
  t.after(() => { CFG.napcatWsApi = originalWs; });
  const controller = new globalThis.AbortController();
  const requests = [];
  let uploadPath, uploadSignal;
  t.mock.method(globalThis, "fetch", async (url, options) => {
    requests.push(url);
    if (url === resource) return new globalThis.Response("fixture data");
    uploadPath = JSON.parse(options.body).file;
    uploadSignal = options.signal;
    controller.abort();
    return globalThis.Response.json(ok);
  });

  const result = await transferResourceToGroup({ groupId, url: resource, signal: controller.signal });
  assert.deepEqual(result, { ok: false, reason: "upload_unconfirmed" });
  assert.deepEqual(requests, [resource, CFG.napcatApi + "/upload_group_file"]);
  assert.equal(uploadSignal?.aborted, true);
  assert.ok(uploadPath);
  assert.equal(fs.existsSync(uploadPath), false);
});

test("an unconfirmed resource receipt is retained and duplicate command delivery never uploads again", async t => {
  const originalWs = CFG.napcatWsApi;
  CFG.napcatWsApi = "";
  t.after(() => { CFG.napcatWsApi = originalWs; });
  const requests = [];
  t.mock.method(globalThis, "fetch", async url => {
    requests.push(url);
    if (url === resource) return new globalThis.Response("fixture data");
    if (url.endsWith("/upload_group_file")) return globalThis.Response.json({ status: "async", retcode: 1 });
    return globalThis.Response.json(ok);
  });
  const ctx = { isAtMe: true, group_id: groupId, user_id: userId, message_id: 981397 };
  const options = { parsedCommand: { ok: true, url: resource }, groupWhitelist: [groupId] };
  assert.equal(await handleResourceTransferCommand(ctx, options), true);
  await waitResourceTasks();
  assert.match(listResourceTasks().at(-1).error, /结果未确认/u);
  assert.equal(await handleResourceTransferCommand(ctx, options), true);
  await waitResourceTasks();
  assert.deepEqual(requests, [CFG.napcatApi + "/send_group_msg", resource, CFG.napcatApi + "/upload_group_file",
    CFG.napcatApi + "/send_group_msg", CFG.napcatApi + "/send_group_msg"]);
});

test("partial HTTP resources are discarded before creating a temp directory or uploading", async t => {
  let tempDirs = 0;
  let uploadCalls = 0;
  let cancelled = 0;
  let headers;
  t.mock.method(fsp, "mkdtemp", async () => { tempDirs++; throw new Error("unexpected temp directory"); });
  t.mock.method(globalThis, "fetch", async () => new globalThis.Response(new ReadableStream({
    cancel() { cancelled++; },
  }), headers));

  for (const init of [{ status: 206 }, { status: 200, headers: { "content-range": "bytes 0-3/8" } }]) {
    headers = init;
    const result = await transferResourceToGroup({ groupId, url: resource, sender: () => ok,
      uploader: () => { uploadCalls++; return ok; } });
    assert.deepEqual(result, { ok: false, reason: "download_failed" });
  }
  assert.equal(cancelled, 2);
  assert.equal(tempDirs, 0);
  assert.equal(uploadCalls, 0);
});

test("resource shutdown closes admission and waits for a dispatched task without replacing its unknown receipt", { timeout: 5000 }, async t => {
  const originalWs = CFG.napcatWsApi;
  CFG.napcatWsApi = "";
  t.after(() => { CFG.napcatWsApi = originalWs; });
  const upload = Promise.withResolvers();
  const response = Promise.withResolvers();
  const cleaning = Promise.withResolvers();
  const releaseCleanup = Promise.withResolvers();
  const requests = [];
  let uploadPath, uploadSignal;
  t.mock.method(globalThis, "fetch", async (url, request) => {
    requests.push(url);
    if (url === resource) return new globalThis.Response("fixture data");
    if (url.endsWith("/upload_group_file")) {
      uploadPath = JSON.parse(request.body).file;
      uploadSignal = request.signal;
      upload.resolve();
      return response.promise;
    }
    return globalThis.Response.json(ok);
  });
  const rm = fsp.rm;
  t.mock.method(fsp, "rm", async (target, options) => {
    if (uploadPath && String(target) === path.dirname(uploadPath)) {
      cleaning.resolve();
      await releaseCleanup.promise;
    }
    return rm(target, options);
  });

  const before = listResourceTasks().length;
  const ctx = { isAtMe: true, group_id: groupId, user_id: userId, message_id: 981398 };
  const options = { parsedCommand: { ok: true, url: resource }, groupWhitelist: [groupId] };
  assert.equal(await handleResourceTransferCommand(ctx, options), true);
  await upload.promise;
  let drained = false;
  const stopped = stopResourceTasks().then(result => { drained = true; return result; });
  try {
    await cleaning.promise;
    assert.equal(uploadSignal.aborted, true);
    assert.equal(drained, false);
    assert.equal(await handleResourceTransferCommand({ ...ctx, message_id: 981399 }, options), true);
    assert.equal(listResourceTasks().length, before + 1);
  } finally {
    response.resolve(globalThis.Response.json(ok));
    releaseCleanup.resolve();
    await stopped;
  }
  assert.equal(await stopped, true);
  const job = listResourceTasks().at(-1);
  assert.equal(job.phase, "failed");
  assert.match(job.error, /结果未确认.*不会自动重发/u);
  assert.equal(fs.existsSync(uploadPath), false);
  assert.deepEqual(requests, [CFG.napcatApi + "/send_group_msg", resource, CFG.napcatApi + "/upload_group_file"]);
});
