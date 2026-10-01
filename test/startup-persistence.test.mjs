import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { Buffer } from "node:buffer";
import { setTimeout, setInterval } from "node:timers";
import { URL } from "node:url";
import test from "node:test";

const entry = name => JSON.stringify(new URL("../bridge/" + name, import.meta.url).href);

// Load the real entry module in a child with inert dependencies, but real auth,
// request parsing and receipt classification. No sockets or external services.
async function exercise(scenario, modules, source) {
  const { vm, EventEmitter, readRequestJson, isAuthorizedAdminRequest, isAllowedBrowserOrigin,
    isAuthorizedOneBotRequest, classifyOutboundDelivery, sendMsg: nativeSendMsg } = modules;
  const calls = [];
  const logs = [];
  const responses = [];
  const sends = [];
  const physicalSends = [];
  const dirty = { "storage save": true, "profiles save": true, "stickers save": true };
  let requestHandler;
  const step = name => {
    calls.push(name);
    if (scenario.fail?.[name] === "throw") throw new Error("PRIVATE_FAILURE_SENTINEL");
    if (scenario.fail?.[name] === "false") return false;
    if (scenario.fail?.[name] === "undefined") return undefined;
    if (name in dirty) dirty[name] = false;
    return true;
  };
  const drain = name => {
    const result = step(name);
    if (scenario.lateDrain !== name) return result;
    return new Promise(resolve => setTimeout(() => {
      calls.push(name + " settled");
      dirty["storage save"] = true;
      resolve(result);
    }, 30));
  };
  if (scenario.transport) {
    globalThis.fetch = async (url, options) => {
      const response = scenario.transport[physicalSends.length];
      physicalSends.push({ url: String(url), method: options.method, payload: JSON.parse(options.body) });
      if (!response) throw new Error("unexpected physical send");
      if (response.throw) throw Object.assign(new Error("PRIVATE_SEND_SENTINEL"), { name: response.throw });
      return { ok: response.httpOk !== false, json: async () => {
        if (response.jsonError) throw new SyntaxError("PRIVATE_SEND_SENTINEL");
        return response.receipt;
      } };
    };
  }
  const cfg = { listenHost: "127.0.0.1", listenPort: 0, selfUin: 10000, groupWhitelist: [],
    napcatAccessToken: "synthetic-onebot-token", legacyProfileRefreshEnabled: false };
  const inertServer = { on() {}, listen(_port, _host, callback) { callback(); },
    close(callback) { calls.push("server close"); callback(); } };
  const deps = {
    "node:http": { default: { createServer(handler) { requestHandler = handler; return inertServer; } } },
    "node:fs": { default: {} },
    ws: { WebSocketServer: class extends EventEmitter {} },
    "./config.mjs": { CFG: cfg },
    "./logger.mjs": { log: (...args) => logs.push(args.join(" ")), logE: (...args) => logs.push(args.join(" ")),
      cleanupLogger: () => step("logger cleanup"), getStormStatus: () => ({}) },
    "./cognition/chat-run.mjs": { stopChatRuns: () => step("chat stop") },
    "./cognition/chat-work.mjs": { chatWorkScheduler: { status: () => ({}), stop: () => drain("work drain") } },
    "./chat-tools/draft-tasks.mjs": { agentDraftTasks: { stop: () => drain("draft drain") } },
    "./cognition/outcome.mjs": { classifyOutboundDelivery },
    "./storage.mjs": { users: {}, groupChats: {}, flushSavesSync: () => step("storage save"), persistLoadedStorageRepairs() {} },
    "./memory-profile/store.mjs": { persistLoadedProfileRepairs() {} },
    "./napcat.mjs": { sendMsg: async (gid, message, replyTo, options) => {
      sends.push({ gid, replyTo, options });
      if (scenario.transport) return nativeSendMsg(gid, message, replyTo, options);
      if (scenario.sendThrows) throw new Error("PRIVATE_SEND_SENTINEL");
      if ((typeof message === "string" && !message.trim()) || (Array.isArray(message) && !message.length)) return null;
      return scenario.receipt ?? null;
    }, getImages() {}, getFiles() {}, getReplyData() {} },
    "./reply.mjs": { processEvent() { throw new Error("events forbidden in fixture"); } },
    "./event-admission.mjs": { getAdmissionStatus: () => ({}) },
    "./onebot-link.mjs": { createOneBotLinkManager: () => ({ status: () => ({}),
      stop: () => drain("link drain") }) },
    "./pipeline-state.mjs": { getPipelineStatus: () => ({}) },
    "./group-summary/catchup.mjs": { createDailySummaryCatchUp: () => ({ start() {}, stop: () => step("summary stop") }) },
    "./runtime-maintenance.mjs": { createRuntimeMaintenance: () => ({ start() {}, stop: () => step("maintenance stop") }) },
    "./napcat-readiness.mjs": { getCachedNapCatReadiness: () => ({}), refreshNapCatReadiness: async () => ({}) },
    "./profile.mjs": { generateProfile() { throw new Error("model calls forbidden in fixture"); } },
    "./context/messages.mjs": { cleanText: value => value },
    "./version.mjs": { VERSION: "fixture" },
    "./jm-provider.mjs": { refreshJmRuntimeHealth: async () => ({health:"fixture", reason:"fixture"}) },
    "./memory-profile.mjs": { cleanupExpiredMemoryProfiles() {}, flushMemoryProfilesSync: () => step("profiles save") },
    "./admin-api/index.mjs": { handleAdminApiRequest: async () => false },
    "./admin-api/auth.mjs": { isAuthorizedAdminRequest },
    "./http-ingress.mjs": { isAllowedBrowserOrigin, isAuthorizedOneBotRequest, readRequestJson },
    "./web-console.mjs": { handleWebConsoleRequest: async () => false },
    "./features/stickers/index.mjs": { initializeStickerSystem: () => ({}),
      shutdownStickerSystem: () => { step("stickers save"); } },
  };
  const context = vm.createContext({ process, URL, setTimeout, setInterval });
  const startup = new vm.SourceTextModule(source, { context, identifier: "startup-fixture.mjs" });
  await startup.link(specifier => {
    const exports = deps[specifier];
    if (!exports) throw new Error("Unexpected startup dependency: " + specifier);
    return new vm.SyntheticModule(Object.keys(exports), function() {
      for (const [name, value] of Object.entries(exports)) this.setExport(name, value);
    }, { context });
  });
  process.on("exit", () => {
    process.stdout.write("REPORT " + JSON.stringify({ calls, logs, dirty, sends, physicalSends, responses }) + "\n");
  });
  await startup.evaluate();
  for (const request of scenario.requests || []) {
    const req = new EventEmitter();
    Object.assign(req, { url: "/reply", method: "POST", socket: {remoteAddress:"127.0.0.1"},
      headers: request.auth ? {authorization:"Bearer synthetic-admin-token"} : {}, pause() {}, destroy() {} });
    let response;
    const res = new EventEmitter();
    Object.assign(res, { setHeader() {}, writeHead(code) { this.code = code; },
      end(text) { response = {code:this.code, body:JSON.parse(text)}; this.emit("finish"); } });
    const handling = requestHandler(req, res);
    // Wait until the actual body parser attaches; unauthorized requests never parse.
    while (!response && !req.listenerCount("data")) await new Promise(resolve => setTimeout(resolve, 0));
    if (!response) { req.emit("data", Buffer.from(JSON.stringify(request.body))); req.emit("end"); }
    await handling;
    responses.push(response);
  }
  if (scenario.exit === "fatal") process.emit("qqfriend:fatal");
  else if (scenario.exit !== "beforeExit") process.emit(scenario.exit || "SIGTERM");
}

function run(t, scenario) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "qqfriend-startup-persistence-"));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const script = `
    import fs from 'node:fs';
    import vm from 'node:vm';
    import { EventEmitter } from 'node:events';
    import { readRequestJson, isAllowedBrowserOrigin, isAuthorizedOneBotRequest } from ${entry("http-ingress.mjs")};
    import { isAuthorizedAdminRequest } from ${entry("admin-api/auth.mjs")};
    import { classifyOutboundDelivery } from ${entry("cognition/outcome.mjs")};
    import { sendMsg } from ${entry("napcat.mjs")};
    globalThis.fetch = async () => { throw new Error('network forbidden in startup fixture'); };
    await (${exercise.toString()})(${JSON.stringify(scenario)},
      {vm, EventEmitter, readRequestJson, isAuthorizedAdminRequest, isAllowedBrowserOrigin,
        isAuthorizedOneBotRequest, classifyOutboundDelivery, sendMsg}, fs.readFileSync(new URL(${entry("startup.mjs")}), 'utf8'));
  `;
  const child = spawnSync(process.execPath, ["--experimental-vm-modules", "--input-type=module", "-e", script], {
    cwd: root, encoding: "utf8", windowsHide: true, timeout: 15000,
    env: { ...process.env, NODE_ENV:"test", QQBOT_CONFIG_ROOT:root, QQBOT_DATA_DIR:root,
      QQBOT_LOG_DIR:path.join(root, "logs"), QQBOT_TEMP_DIR:root,
      QQBOT_MEMORY_PROFILE_FILE:path.join(root, "profiles.json"), QQFRIEND_ADMIN_TOKEN:"synthetic-admin-token" },
  });
  assert.equal(child.error, undefined);
  const report = child.stdout.split("\n").find(line => line.startsWith("REPORT "));
  assert.ok(report, child.stdout + child.stderr);
  assert.doesNotMatch(child.stdout + child.stderr, /PRIVATE_(FAILURE|SEND)_SENTINEL/);
  return { code:child.status, ...JSON.parse(report.slice(7)) };
}

const flushes = ["summary stop", "maintenance stop", "stickers save", "storage save", "profiles save", "logger cleanup"];

for (const exit of ["SIGINT", "SIGTERM", "beforeExit", "fatal"]) {
  test(`${exit}: complete saves attempt every step and exit with the appropriate code`, t => {
    const result = run(t, {exit});
    assert.equal(result.code, exit === "fatal" ? 1 : 0);
    assert.deepEqual(result.calls.slice(-flushes.length), flushes);
    assert.ok(Object.values(result.dirty).every(value => !value));
  });
}

for (const exit of ["SIGTERM", "beforeExit", "fatal"]) {
  for (const failure of ["false", "throw"]) {
    test(`${exit}: ${failure} from storage still flushes profiles and exits nonzero`, t => {
      const result = run(t, {exit, fail:{"storage save":failure}});
      assert.equal(result.code, 1);
      assert.deepEqual(result.calls.slice(-flushes.length), flushes);
      assert.equal(result.dirty["storage save"], true);
      assert.equal(result.dirty["profiles save"], false);
      assert.ok(result.logs.includes("shutdown state incomplete: storage save"));
    });
  }
}

test("sticker and profile failures do not prevent any remaining shutdown steps", t => {
  const result = run(t, {fail:{"stickers save":"throw", "profiles save":"false"}});
  assert.equal(result.code, 1);
  assert.deepEqual(result.calls.slice(-flushes.length), flushes);
  assert.deepEqual(result.dirty, {"storage save":false, "profiles save":true, "stickers save":true});
});

test("a rejected drain still attempts all synchronous saves and exits nonzero", t => {
  const result = run(t, {fail:{"work drain":"throw"}});
  assert.equal(result.code, 1);
  assert.ok(result.calls.includes("link drain"));
  assert.deepEqual(result.calls.slice(-flushes.length), flushes);
});

for (const [failedDrain, lateDrain] of [["link drain", "work drain"], ["work drain", "link drain"],
  ["link drain", "draft drain"], ["draft drain", "work drain"]]) {
  test(`a rejected ${failedDrain} cannot flush or exit before ${lateDrain} settles`, t => {
    const result = run(t, { fail: { [failedDrain]: "throw" }, lateDrain });
    assert.equal(result.code, 1);
    const settled = result.calls.indexOf(lateDrain + " settled");
    assert.ok(settled >= 0);
    assert.ok(result.calls.indexOf("server close") > settled);
    assert.ok(result.calls.indexOf("storage save") > settled);
    assert.equal(result.dirty["storage save"], false);
    assert.deepEqual(result.calls.slice(-flushes.length), flushes);
  });
}

for (const exit of ["SIGINT", "SIGTERM"]) {
  for (const drain of ["work drain", "link drain", "draft drain"]) {
    test(`${exit}: false from ${drain} closes the server, flushes all stores and exits nonzero`, t => {
      const result = run(t, { exit, fail: { [drain]: "false" } });
      assert.equal(result.code, 1);
      assert.ok(result.calls.includes("server close"));
      assert.ok(result.calls.includes("work drain"));
      assert.ok(result.calls.includes("link drain"));
      assert.ok(result.calls.includes("draft drain"));
      assert.deepEqual(result.calls.slice(-flushes.length), flushes);
      assert.ok(Object.values(result.dirty).every(value => !value));
      assert.ok(result.logs.includes("shutdown drain incomplete"));
    });
  }
}

test("a void link drain retains the existing successful stop contract", t => {
  const result = run(t, { fail: { "link drain": "undefined" } });
  assert.equal(result.code, 0);
  assert.deepEqual(result.calls.slice(-flushes.length), flushes);
  assert.equal(result.logs.includes("shutdown drain incomplete"), false);
});

test("an incomplete drain and failed storage still attempt every remaining save", t => {
  const result = run(t, { fail: { "work drain": "false", "storage save": "false" } });
  assert.equal(result.code, 1);
  assert.deepEqual(result.calls.slice(-flushes.length), flushes);
  assert.equal(result.dirty["storage save"], true);
  assert.equal(result.dirty["profiles save"], false);
  assert.ok(result.logs.includes("shutdown drain incomplete"));
  assert.ok(result.logs.includes("shutdown state incomplete: storage save"));
});

const sent = {status:"ok", retcode:0, data:{message_id:70100}};
const failed = {status:"failed", retcode:1200};
const unknown = {status:"unknown", delivery:"unconfirmed"};
const cases = [
  ["confirmed", sent, "sent", 200], ["id-only confirmed", {message_id:70100}, "sent", 200],
  ["confirmed multipart", [sent, sent], "sent", 200],
  ["rejected", failed, "failed", 502], ["failed multipart", [failed, failed], "failed", 502],
  ["unconfirmed", unknown, "unknown", 502], ["null", null, "unknown", 502],
  ["empty receipts", [], "unknown", 502], ["unknown multipart", [failed, unknown], "unknown", 502],
  ["partial rejection", [sent, failed], "partial", 502], ["partial unknown", [sent, unknown], "partial", 502],
  ["contradictory receipt", {status:"failed", retcode:0, data:{message_id:70100}}, "unknown", 502],
  ["cancelled", {status:"cancelled"}, "cancelled", 409],
];

for (const [name, receipt, status, code] of cases) {
  test(`authenticated /reply: ${name} reports actual delivery without route replay`, t => {
    const result = run(t, {receipt, requests:[{auth:true, body:{group_id:50100, message:"synthetic reply", reply_to:70100}}]});
    assert.equal(result.code, 0);
    assert.deepEqual(result.responses, [{code, body:{status, result:receipt}}]);
    assert.deepEqual(result.sends, [{gid:50100, replyTo:70100}]);
  });
}

test("/reply rejects unauthenticated requests before attempting sends", t => {
  const result = run(t, {receipt:sent, requests:[{body:{group_id:50100, message:"synthetic reply"}}]});
  assert.deepEqual(result.responses, [{code:403, body:{error:"forbidden"}}]);
  assert.deepEqual(result.sends, []);
});

test("/reply never calls empty input or transport exceptions sent", t => {
  const empty = run(t, {requests:[
    {auth:true, body:{group_id:50100, message:""}},
    {auth:true, body:{group_id:50100, message:"  "}},
    {auth:true, body:{group_id:50100, message:[]}},
  ]});
  assert.deepEqual(empty.responses, [
    {code:400, body:{error:"group_id and message required"}},
    {code:502, body:{status:"unknown", result:null}},
    {code:502, body:{status:"unknown", result:null}},
  ]);
  const thrown = run(t, {sendThrows:true, requests:[{auth:true, body:{group_id:50100, message:"synthetic reply"}}]});
  assert.deepEqual(thrown.responses, [{code:502, body:{status:"unknown", result:null}}]);
  assert.equal(thrown.sends.length, 1);
});

function physicalReply(t, message, transport, auth = true) {
  const result = run(t, { transport, requests: [{ auth, body: { group_id: 50100, message, reply_to: 70100 } }] });
  assert.equal(result.code, 0);
  assert.equal(result.sends.length, auth ? 1 : 0);
  for (const send of result.physicalSends) {
    assert.match(send.url, /\/send_group_msg$/);
    assert.equal(send.method, "POST");
    assert.equal(send.payload.group_id, 50100);
  }
  return result;
}

const transportCases = [
  ["safe rejection retries and succeeds", [{ receipt: failed }, { receipt: sent }], 2, "sent", 200, sent],
  ["safe rejection remains bounded", [{ receipt: failed }, { receipt: failed }], 2, "failed", 502, failed],
  ["unknown delivery never repeats", [{ receipt: unknown }], 1, "unknown", 502, unknown],
  ["timeout never repeats", [{ throw: "TimeoutError" }], 1, "unknown", 502, unknown],
  ["connection reset never repeats", [{ throw: "TypeError" }], 1, "unknown", 502, unknown],
  ["invalid JSON never repeats", [{ jsonError: true }], 1, "unknown", 502, unknown],
  ["HTTP error cannot turn a failure body into a safe retry", [{ httpOk: false, receipt: failed }], 1, "unknown", 502, unknown],
  ["async receipt never repeats", [{ receipt: { status: "async", retcode: 1 } }], 1, "unknown", 502, unknown],
  ["failure with a message id never repeats", [{ receipt: { ...failed, data: { message_id: 70100 } } }], 1, "unknown", 502, unknown],
  ["failure with code zero never repeats", [{ receipt: { status: "failed", retcode: 0 } }], 1, "unknown", 502, unknown],
  ["safe retry becoming unknown stops immediately", [{ receipt: failed }, { receipt: unknown }], 2, "unknown", 502, unknown],
  ["malformed receipt never repeats", [{ receipt: {} }], 1, "unknown", 502, unknown],
];

for (const [shape, message] of [["text", "synthetic reply"], ["segments", [{ type: "text", data: { text: "synthetic reply" } }]]]) {
  for (const [name, transport, count, status, code, receipt] of transportCases) {
    test(`/reply physical ${shape}: ${name} and reports the final HTTP status`, t => {
      const result = physicalReply(t, message, transport);
      assert.equal(result.physicalSends.length, count);
      assert.deepEqual(result.responses, [{ code, body: { status, result: receipt } }]);
      assert.deepEqual(result.physicalSends[0].payload.message, [
        { type: "reply", data: { id: 70100 } }, { type: "text", data: { text: "synthetic reply" } },
      ]);
      if (count === 2) assert.deepEqual(result.physicalSends[0], result.physicalSends[1]);
    });
  }
}

test("/reply physical multipart: first unknown stops all tails without route fallback", t => {
  const result = physicalReply(t, "x".repeat(1900), [{ receipt: unknown }]);
  assert.equal(result.physicalSends.length, 1);
  assert.deepEqual(result.responses, [{ code: 502, body: { status: "unknown", result: unknown } }]);
});

test("/reply physical multipart: second unknown preserves partial status without replay", t => {
  const result = physicalReply(t, "x".repeat(1900), [{ receipt: sent }, { receipt: unknown }]);
  assert.equal(result.physicalSends.length, 2);
  assert.deepEqual(result.responses, [{ code: 502, body: { status: "partial", result: [sent, unknown] } }]);
  assert.equal(result.physicalSends[0].payload.message[0].type, "reply");
  assert.deepEqual(result.physicalSends[1].payload.message, [{ type: "text", data: { text: "x".repeat(900) } }]);
});

test("/reply physical multipart: safe retry repeats only the rejected chunk and reports sent", t => {
  const result = physicalReply(t, "x".repeat(1900), [{ receipt: sent }, { receipt: failed }, { receipt: sent }, { receipt: sent }]);
  assert.equal(result.physicalSends.length, 4);
  assert.deepEqual(result.responses, [{ code: 200, body: { status: "sent", result: [sent, sent, sent] } }]);
  assert.equal(result.physicalSends[0].payload.message[0].type, "reply");
  assert.deepEqual(result.physicalSends[1], result.physicalSends[2]);
  assert.deepEqual(result.physicalSends[1].payload.message, [{ type: "text", data: { text: "x".repeat(900) } }]);
  assert.deepEqual(result.physicalSends[3].payload.message, [{ type: "text", data: { text: "x".repeat(100) } }]);
});

test("/reply physical transport: authentication prevents any native send or fetch", t => {
  const result = physicalReply(t, "synthetic reply", [{ receipt: sent }], false);
  assert.deepEqual(result.physicalSends, []);
  assert.deepEqual(result.responses, [{ code: 403, body: { error: "forbidden" } }]);
});

test("/reply physical transport: empty text and segments never reach fetch or report success", t => {
  const result = run(t, { transport: [], requests: ["", "  ", []].map(message => ({
    auth: true, body: { group_id: 50100, message },
  })) });
  assert.equal(result.code, 0);
  assert.deepEqual(result.physicalSends, []);
  assert.deepEqual(result.responses, [
    { code: 400, body: { error: "group_id and message required" } },
    { code: 502, body: { status: "unknown", result: null } },
    { code: 502, body: { status: "unknown", result: null } },
  ]);
});
