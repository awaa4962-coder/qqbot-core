import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { runVmTestFile } from "./vm-test-runner.mjs";
import { consoleHarness, deferred, flush } from "./p5-ui-harness.mjs";
import { uiFixtureData } from "./p5-ui-fixtures.mjs";

const response = (status, value) => ({ ok: status < 400, status, text: async () => typeof value === "string" ? value : JSON.stringify(value) });
const failure = status => Object.assign(new Error("synthetic failure"), status ? { status } : { transportFailure: true });
const configModules = ["ui/actions.js", "pages/configuration.js", "ui/state.js"];
const apiModules = ["ui/actions.js", "pages/api.js", "ui/state.js"];

if (!vm.SourceTextModule) {
  test("P5 deterministic frontend state matrix", () => {
    runVmTestFile(import.meta.url, { minTests: 45 });
  });
} else {
  for (const raw of ["", "<html>gateway unavailable</html>", "null", "[]", '{"error":"synthetic proxy error"}']) {
    test("host rejects misleading HTTP 200 payload: " + JSON.stringify(raw), async () => {
      const h = consoleHarness(); let requests = 0;
      h.window.fetch = async () => { requests++; return response(200, raw); };
      await assert.rejects(h.runHost().call("saveConfig", {}), error => error.responseInvalid === true);
      assert.equal(requests, 1);
    });
  }

  test("POST deadline covers response body, rejects once, and never resubmits", async () => {
    const h = consoleHarness(); let requests = 0;
    h.window.AbortController = globalThis.AbortController;
    h.window.fetch = async (_url, options) => {
      requests++; assert.equal(options.method, "POST"); assert.equal(options.redirect, "error");
      return { ok: true, status: 200, text: () => new Promise((_resolve, reject) => options.signal.addEventListener("abort", () => reject(Object.assign(new Error("deadline"), { name: "AbortError" })))) };
    };
    const pending = h.runHost().call("saveConfig", {}); await flush(); h.fireTimer(30000);
    await assert.rejects(pending, error => error.transportFailure === true);
    assert.equal(requests, 1);
  });

  test("admin fetch never follows redirects or moves header credentials into URLs", async () => {
    const h = consoleHarness(); const requests = []; h.session.set("qqfriend-admin-token", "synthetic-session-token");
    h.window.fetch = async (url, options) => { requests.push({ url, options }); return response(200, {}); };
    const host = h.runHost(); await host.call("getCapabilities"); await host.call("saveConfig", {});
    for (const { url, options } of requests) {
      assert.ok(url.startsWith("/admin/")); assert.doesNotMatch(url, /token|https?:/);
      assert.equal(options.redirect, "error"); assert.equal(options.credentials, "same-origin"); assert.equal(options.cache, "no-store");
      assert.equal(options.headers["X-QQFriend-Admin-Token"], "synthetic-session-token");
    }
  });

  test("partial snapshot retains fresh status and reports config/log failures separately", async () => {
    const h = consoleHarness(); const data = uiFixtureData();
    h.window.fetch = async url => url === "/admin/status" ? response(200, data.status) : response(503, { error: "synthetic unavailable" });
    const snapshot = await h.runHost().call("refresh");
    assert.equal(snapshot.status.status, "ok"); assert.equal(snapshot.errors.config.status, 503); assert.equal(snapshot.errors.logs.status, 503);
    const [overview, state] = await h.imports(["pages/overview.js", "ui/state.js"]);
    overview.renderSnapshot(snapshot);
    assert.match(h.get("lastUpdated").textContent, /刚刚刷新/);
    assert.match(h.get("configStatus").textContent, /配置读取失败/); assert.match(h.get("logsOutput").textContent, /日志读取失败/);
    assert.equal(state.uiState.configBlocked, true); assert.equal(h.select('[data-action="saveConfig"]').disabled, true);
  });

  test("capability loading, denial, stale failure, empty and recovery live on that page", async () => {
    const h = consoleHarness(); const data = uiFixtureData();
    const [actions, capabilities] = await h.imports(["ui/actions.js", "pages/capabilities.js"]);
    const pending = deferred(); h.setReply(() => pending.promise);
    const loading = actions.runAction("refreshCapabilities", null, { silent: true });
    assert.equal(h.get("capabilityNotice").dataset.state, "loading"); assert.equal(h.get("capabilityPanel").attributes["aria-busy"], "true");
    pending.resolve(data.capabilities); await loading;
    assert.match(h.get("capabilityList").innerHTML, /预留/);
    h.setReply(() => { throw failure(503); }); await actions.runAction("refreshCapabilities", null, { silent: true });
    assert.match(h.get("capabilityNotice").textContent, /上次快照/); assert.equal(h.get("capabilityNotice").dataset.state, "error");
    h.setReply(() => { throw failure(403); }); await actions.runAction("refreshCapabilities", null, { silent: true });
    assert.match(h.get("capabilityNotice").textContent, /无权/); assert.equal(h.get("capabilityList").innerHTML, "");
    h.setReply(() => ({ categories: [], capabilities: [] })); await actions.runAction("refreshCapabilities", null, { silent: true });
    assert.match(h.get("capabilityList").innerHTML, /暂无能力记录/); assert.equal(h.get("capabilityNotice").dataset.state, "empty");
    assert.match(capabilities.capabilityStateLabel({}), /启用状态待确认.*权限按实际会话判断/);
  });

  test("initial config is unread and non-writable, not saved", async () => {
    const h = consoleHarness(); const [config] = await h.imports(["pages/configuration.js"]);
    config.setConfigDirty(false);
    assert.equal(h.get("configDirtyState").textContent, "尚未读取"); assert.equal(h.select('[data-action="saveConfig"]').disabled, true);
  });

  for (const outcome of [400, 403, 409, 503, undefined]) {
    test(`config save ${outcome ?? "transport unknown"} retains draft and has no successful activity`, async () => {
      const h = consoleHarness(); const [actions, config, state] = await h.imports(configModules);
      config.renderConfigEditor(uiFixtureData().config); h.get("cfgBotNames").value = "Local edit"; config.updateConfigDirty();
      h.setReply(() => { throw failure(outcome); });
      await actions.runAction("saveConfig");
      assert.equal(h.get("cfgBotNames").value, "Local edit"); assert.equal(state.uiState.configDirty, true);
      assert.equal(h.get("activityBar").classes.has("success"), false); assert.equal(h.get("configStatus").dataset.state, "error");
      if (outcome !== 400) {
        assert.equal(state.uiState.configBlocked, true); assert.equal(h.select('[data-action="saveConfig"]').disabled, true);
        await actions.runAction("saveConfig"); assert.equal(h.calls.length, 1);
        h.confirmationAnswers.push(false); await actions.runAction("refreshConfig"); assert.equal(h.calls.length, 1);
        h.setReply(() => uiFixtureData().config); await actions.runAction("refreshConfig"); assert.equal(state.uiState.configBlocked, false);
      }
    });
  }

  test("config explicit false and incomplete success cannot claim saved", async () => {
    for (const result of [{ ok: false, error: "synthetic write failed" }, {}]) {
      const h = consoleHarness(); const [actions, config] = await h.imports(configModules);
      config.renderConfigEditor(uiFixtureData().config); h.get("cfgBotNames").value = "Local"; config.updateConfigDirty(); h.setReply(() => result);
      await actions.runAction("saveConfig");
      assert.equal(h.get("cfgBotNames").value, "Local"); assert.equal(h.calls.length, 1);
      assert.equal(h.get("activityBar").classes.has("success"), false); assert.doesNotMatch(h.get("configStatus").textContent, /^配置已保存/);
    }
  });

  test("config confirmed save with unreadable verification is distinct from unsaved failure", async () => {
    const h = consoleHarness(); const [actions, config, state] = await h.imports(configModules);
    config.renderConfigEditor(uiFixtureData().config); h.get("cfgBotNames").value = "Local"; config.updateConfigDirty();
    h.setReply(action => { if (action === "saveConfig") return { ok: true }; throw failure(503); });
    await actions.runAction("saveConfig");
    assert.match(h.get("configStatus").textContent, /已保存，但重新读取失败/); assert.equal(state.uiState.configBlocked, true);
    assert.equal(h.get("cfgBotNames").value, "Local"); assert.equal(h.calls.filter(call => call.action === "saveConfig").length, 1);
  });

  for (const action of ["saveApiProvider", "saveApiRoutes", "deleteApiProvider", "rollbackApiProviders"]) {
    test(action + " carries the exact byte revision token without preflight GET", async () => {
      const h = consoleHarness(); const [actions, api] = await h.imports(apiModules); const data = uiFixtureData();
      api.renderApiProviders(data.api); h.setReply(() => ({ ok: true, snapshot: { ...data.api, configurationRevision: "b".repeat(64), revision: 8 } }));
      await actions.runAction(action);
      assert.equal(h.calls.length, 1); assert.equal(h.calls[0].action, "manageApiProviders");
      assert.equal(h.calls[0].payload.configurationRevision, "a".repeat(64));
      assert.equal(h.get("activityBar").classes.has("success"), true);
      if (action === "saveApiRoutes") {
        assert.equal(h.calls[0].payload.routes.group_chat.fallback, "deepseek"); assert.equal(h.calls[0].payload.routes.group_chat.reasoning, "deep");
      }
    });
  }

  for (const value of [false, undefined, "false"]) {
    test("failed connection result " + String(value) + " is never green", async () => {
      const h = consoleHarness(); const [actions, api] = await h.imports(apiModules); api.renderApiProviders(uiFixtureData().api);
      h.setReply(() => ({ ok: value, error: "synthetic connection failed" })); await actions.runAction("testApiProvider");
      assert.match(h.get("apiTestOutput").textContent, /失败/); assert.equal(h.get("apiNotice").dataset.state, "error");
      assert.equal(h.get("activityBar").classes.has("error"), true); assert.equal(h.get("activityBar").classes.has("success"), false);
      assert.equal(h.calls.length, 1); assert.equal(h.calls[0].payload.configurationRevision, undefined, "read-only test is exempt from mutation CAS");
    });
  }

  for (const status of [409, 503, undefined]) {
    test("API conflict/uncertainty " + String(status) + " retains provider and route drafts until explicit refresh", async () => {
      const h = consoleHarness(); const [actions, api, state] = await h.imports(apiModules); const data = uiFixtureData(); api.renderApiProviders(data.api);
      h.get("apiModel").value = "unsaved-model"; h.get("apiKey").value = "synthetic-key";
      h.apiRows[0].querySelector("[data-route-reasoning]").value = "economy";
      h.setReply(() => { throw failure(status); }); await actions.runAction("saveApiRoutes");
      assert.equal(h.get("apiModel").value, "unsaved-model"); assert.equal(h.apiRows[0].querySelector("[data-route-reasoning]").value, "economy");
      assert.equal(h.get("apiKey").value, "synthetic-key");
      assert.equal(state.uiState.apiBlocked, true); await actions.runAction("saveApiRoutes"); assert.equal(h.calls.length, 1);
      h.confirmationAnswers.push(false); await actions.runAction("refreshApiProviders"); assert.equal(h.calls.length, 1);
      h.setReply(() => ({ ...data.api, configurationRevision: "b".repeat(64) })); await actions.runAction("refreshApiProviders");
      assert.equal(state.uiState.apiSnapshot.configurationRevision, "b".repeat(64)); assert.equal(h.get("apiKey").value, "");
      assert.equal(h.apiRows[0].querySelector("[data-route-fallback]").disabled, true, "fixed DS fallback survives re-enable");
    });
  }

  test("API malformed save response blocks duplicates and preserves input", async () => {
    const h = consoleHarness(); const [actions, api, state] = await h.imports(apiModules); api.renderApiProviders(uiFixtureData().api);
    h.get("apiModel").value = "draft"; h.setReply(() => ({})); await actions.runAction("saveApiProvider");
    assert.equal(h.get("apiModel").value, "draft"); assert.equal(state.uiState.apiBlocked, true);
    await actions.runAction("saveApiProvider"); assert.equal(h.calls.length, 1); assert.match(h.get("apiNotice").textContent, /待核实/);
  });

  test("task submit transport uncertainty blocks repeats until server recovery without a new POST", async () => {
    const h = consoleHarness(); const [tasks] = await h.imports(["ui/tasks.js"]);
    h.setReply(() => { throw failure(); });
    await assert.rejects(tasks.callManagedAction("manageStickers", { action: "analyze" }), error => error.taskStateUnknown === true);
    await assert.rejects(tasks.callManagedAction("manageStickers", { action: "analyze" }), /勿重复/);
    assert.equal(h.calls.length, 1); assert.equal(tasks.managedTaskIsBlocked("stickers"), true);
    h.setReply(() => ({ tasks: [] })); await tasks.resumeManagedTasks();
    assert.equal(tasks.managedTaskIsBlocked("stickers"), false); assert.match(h.get("managedTaskNotice").textContent, /先前提交结果无法确认/);
    assert.equal(h.calls.filter(call => call.action === "startTask").length, 1);
  });

  test("native-tool verification asks once, retains task scope, and never marks partial evidence successful", async () => {
    const h = consoleHarness();
    const [actions, state, tasks] = await h.imports(["ui/actions.js", "ui/state.js", "ui/tasks.js"]);
    const data = uiFixtureData();
    data.capabilities.agentTools.compatibility.probeAllowed = true;
    data.capabilities.agentTools.compatibility.provenance = "live";
    state.uiState.capabilitySnapshot = data.capabilities;
    h.confirmationAnswers.push(false);
    await actions.runAction("probeAgentTools");
    assert.equal(h.calls.length, 0);
    const id = "00000000-0000-0000-0000-000000000041";
    h.setReply(action => action === "startTask" ? { jobId: id } : action === "getTasks"
      ? { task: { id, module: "agent_tools", phase: "done", resultAvailable: true, result: { ok: true } } }
      : data.capabilities);
    await actions.runAction("probeAgentTools");
    assert.equal(h.calls.filter(call => call.action === "startTask").length, 1);
    assert.deepEqual(JSON.parse(JSON.stringify(h.calls[0].payload)), { module: "agent_tools", payload: { action: "probe" } });
    assert.match(h.get("capabilityNotice").textContent, /未完整通过/);
    assert.equal(h.get("activityBar").classes.has("success"), false);
    assert.equal(tasks.managedTaskIsBlocked("agent_tools"), false);
    assert.equal(h.confirmations.length, 2);
  });

  test("uncertain native-probe submission cannot be repeated or confused with a failed model", async () => {
    const h = consoleHarness(); const [actions, state] = await h.imports(["ui/actions.js", "ui/state.js"]);
    const data = uiFixtureData(); data.capabilities.agentTools.compatibility.probeAllowed = true;
    data.capabilities.agentTools.compatibility.provenance = "live";
    state.uiState.capabilitySnapshot = data.capabilities;
    h.setReply(() => { throw failure(); });
    await actions.runAction("probeAgentTools");
    assert.match(h.get("capabilityNotice").textContent, /结果尚未确认/);
    assert.equal(h.get("capabilityPanel").attributes["aria-busy"], "false");
    await actions.runAction("probeAgentTools");
    assert.equal(h.calls.filter(call => call.action === "startTask").length, 1);
    assert.match(h.get("capabilityNotice").textContent, /勿重复提交/);
    assert.equal(h.get("activityBar").classes.has("success"), false);
  });

  test("known failed native-probe task refreshes partial proof without claiming a read failure", async () => {
    const h = consoleHarness(); const [actions, state] = await h.imports(["ui/actions.js", "ui/state.js"]);
    const data = uiFixtureData(); data.capabilities.agentTools.compatibility.probeAllowed = true;
    data.capabilities.agentTools.compatibility.provenance = "live";
    state.uiState.capabilitySnapshot = data.capabilities;
    const id = "00000000-0000-0000-0000-000000000042";
    const partial = { ...data.capabilities, agentTools: { ...data.capabilities.agentTools,
      compatibility: { ...data.capabilities.agentTools.compatibility, status: "partial" } } };
    h.setReply(action => action === "startTask" ? { jobId: id } : action === "getTasks"
      ? { task: { id, module: "agent_tools", phase: "failed", error: "验证未完整通过", resultAvailable: true, result: { ok: false } } }
      : partial);
    await actions.runAction("probeAgentTools");
    assert.equal(h.calls.filter(call => call.action === "getCapabilities").length, 1);
    assert.equal(state.uiState.capabilitySnapshot.agentTools.compatibility.status, "partial");
    assert.equal(state.uiState.capabilitiesLoaded, true);
    assert.match(h.get("capabilityNotice").textContent, /未完整通过/);
    assert.doesNotMatch(h.get("capabilityNotice").textContent, /读取失败/);
    assert.equal(h.get("activityBar").classes.has("success"), false);
  });

  test("native-probe success must match the exact proof rendered, not just aggregate status", async () => {
    for (const overrides of [{ model: "x".repeat(81) }, { expiresAt: 1 }, { provenance: "qa" }]) {
      const h = consoleHarness(); const [actions, state] = await h.imports(["ui/actions.js", "ui/state.js"]);
      const data = uiFixtureData(); data.capabilities.agentTools.compatibility.probeAllowed = true;
      data.capabilities.agentTools.compatibility.provenance = "live";
      state.uiState.capabilitySnapshot = data.capabilities;
      const now = Date.now();
      const compatibility = { status: "verified", provenance: overrides.provenance || "live", probeAllowed: false,
        slots: ["primary", "fallback"].map(position => ({ position, status: "verified", model: "synthetic-model",
          checkedAt: now - 1000, expiresAt: now + 60000, ...overrides })) };
      const id = "00000000-0000-0000-0000-000000000043";
      h.setReply(action => action === "startTask" ? { jobId: id } : action === "getTasks"
        ? { task: { id, module: "agent_tools", phase: "done", resultAvailable: true, result: { ok: true } } }
        : { ...data.capabilities, agentTools: { ...data.capabilities.agentTools, compatibility } });
      await actions.runAction("probeAgentTools");
      assert.equal(h.get("activityBar").classes.has("success"), false);
      assert.match(h.get("capabilityNotice").textContent, /未完整通过/);
    }
  });

  for (const outcome of ["failed", "cancelled", "expired", "nested-false", "nested-cancelled"]) {
    test("managed task " + outcome + " is not an operation success", async () => {
      const h = consoleHarness(); const [tasks] = await h.imports(["ui/tasks.js"]);
      const id = "00000000-0000-0000-0000-000000000001";
      h.setReply(action => action === "startTask" ? { jobId: id } : { task: { id, phase: ["failed", "cancelled"].includes(outcome) ? outcome : "done",
        resultAvailable: outcome !== "expired", result: { ok: true, result: { ok: outcome !== "nested-false", cancelled: outcome === "nested-cancelled" } } } });
      await assert.rejects(tasks.callManagedAction("manageStickers", { action: "analyze" }));
      assert.equal(tasks.managedTaskIsBlocked("stickers"), false, "only a terminal record releases the task lock");
      assert.equal(h.calls.filter(call => call.action === "startTask").length, 1);
    });
  }

  test("resumed cancelled task cannot display a green completion banner", async () => {
    const h = consoleHarness(); const [feedback] = await h.imports(["ui/background-feedback.js"]); feedback.installTaskFeedback();
    h.setReply(() => uiFixtureData().stickers);
    h.window.dispatchEvent({ type: "qqfriend:task", detail: { type: "complete", task: { module: "stickers", action: "analyze", phase: "done", resultAvailable: true, result: { ok: true, result: { cancelled: true } } } } });
    await flush(); assert.match(h.get("stickerStatus").textContent, /取消/); assert.equal(h.get("activityBar").classes.has("success"), false);
  });

  test("overdue means still settling, not cancelled; unknown result is retained across refresh", async () => {
    const h = consoleHarness(); const [tasks] = await h.imports(["ui/tasks.js"]); const id = "00000000-0000-0000-0000-000000000002";
    assert.match(tasks.taskPhaseLabel("overdue"), /尚未确认停止/);
    h.setReply(action => { if (action === "startTask") return { jobId: id }; throw failure(503); });
    await assert.rejects(tasks.callManagedAction("manageStickers", { action: "sync" }), error => error.taskStateUnknown === true);
    assert.equal(h.calls.filter(call => call.action === "getTasks").length, 4); assert.equal(tasks.managedTaskIsBlocked("stickers"), true);
    assert.deepEqual(JSON.parse(h.session.get("qqfriend-pending-tasks-v1")), [id]);
    h.setReply((_action, payload) => payload?.id ? { task: { id, phase: "done", resultAvailable: true, result: { ok: true } } } : { tasks: [{ id, module: "stickers", action: "sync", phase: "done" }] });
    await tasks.resumeManagedTasks(); await flush(); assert.equal(tasks.managedTaskIsBlocked("stickers"), false);
    assert.equal(h.calls.filter(call => call.action === "startTask").length, 1);
  });

  test("memory malformed records keep the existing editor and cannot break final controls", async () => {
    const h = consoleHarness(); const [memory] = await h.imports(["memory.js"]); const data = uiFixtureData();
    h.setReply(() => data.memory); memory.initializeMemory(h.host); await h.get("memoryQuery").fire("submit");
    h.get("memoryText").value = "draft"; await h.get("memoryText").fire("input");
    h.setReply(() => ({ ...data.memory, items: [null] })); await h.get("memoryRefresh").fire("click");
    assert.equal(h.get("memoryText").value, "draft"); assert.equal(h.get("memorySave").disabled, true); assert.match(h.get("memoryNotice").textContent, /响应不完整/);
  });

  test("memory read cancellation invalidates late data but never claims a write was cancelled", async () => {
    const h = consoleHarness(); const [memory] = await h.imports(["memory.js"]); const pending = deferred(); h.setReply(() => pending.promise);
    const controller = memory.initializeMemory(h.host); const read = h.get("memoryQuery").fire("submit");
    assert.equal(controller.canLeave(), true); pending.resolve(uiFixtureData().memory); await read;
    assert.equal(h.get("memoryText").value, ""); assert.match(h.get("memoryNotice").textContent, /读取已取消/);
  });

  test("diagnostic denial retries on re-entry; empty replay clears old candidate and disables writes", async () => {
    const h = consoleHarness(); const data = uiFixtureData(); let denied = true;
    h.setReply(action => { if (action === "getTasks") return { tasks: [] }; if (denied) throw failure(403);
      return action === "getReplay" ? data.replay : action === "getMessageTraces" ? data.traces : data.deliveries; });
    await h.imports(["diagnostics.js"]); h.show("diagnostics"); await flush();
    assert.equal(h.get("traceNotice").dataset.error, "true"); denied = false; h.show("diagnostics", false); h.show("diagnostics"); await flush();
    assert.match(h.get("traceNotice").textContent, /当前显示 1/); assert.equal(h.get("replayCandidate").textContent, "合成候选");
    h.setReply(action => action === "getTasks" ? { tasks: [] } : { cases: [], todayRuns: 0, dailyLimit: 3 });
    h.click("data-diagnostic-action", "replay"); await flush();
    assert.equal(h.get("replayCandidate").textContent, "尚未生成候选"); assert.equal(h.get("replayPacket").textContent, "");
    assert.equal(h.get("replayPanel").querySelector('[data-diagnostic-action="generate"]').disabled, true);
  });

  test("summary failed save keeps draft, suppresses fake success and requires refresh", async () => {
    const h = consoleHarness(); const data = uiFixtureData(); h.setReply(() => data.summaries); await h.imports(["summaries.js"]);
    h.click("data-summary-action", "refresh"); await flush(); h.get("summaryBody").value = "unsaved summary"; await h.get("summaryBody").fire("input");
    h.setReply(() => ({})); h.click("data-summary-action", "save"); await flush();
    assert.equal(h.get("summaryBody").value, "unsaved summary"); assert.match(h.get("summaryProgress").textContent, /结果未确认/);
    assert.equal(h.select('[data-summary-action="save"]').disabled, true); assert.doesNotMatch(h.get("summaryProgress").textContent, /新版本已保存/);
  });

  test("summary group removal clears stale body, evidence and sending controls", async () => {
    const h = consoleHarness(); const data = uiFixtureData(); h.setReply(() => data.summaries); await h.imports(["summaries.js"]);
    h.click("data-summary-action", "refresh"); await flush(); assert.equal(h.get("summaryBody").value, "合成日报正文");
    h.setReply(() => ({ groups: [], revisions: [], jobs: [], coverage: null })); h.click("data-summary-action", "refresh"); await flush();
    assert.equal(h.get("summaryBody").value, ""); assert.equal(h.get("summaryPrevious").value, ""); assert.match(h.get("summaryProgress").textContent, /尚未配置/);
    assert.equal(h.select('[data-summary-action="send"]').disabled, true);
  });
}
