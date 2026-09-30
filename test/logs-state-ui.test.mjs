import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import process from "node:process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { consoleHarness, deferred, flush } from "./p5-ui-harness.mjs";

const snapshot = (lines = [], overrides = {}) => ({
  files: [],
  current: { file: lines.length ? "synthetic.log" : null, lines, count: lines.length, truncated: false, ...overrides },
});
const failure = status => Object.assign(new Error("synthetic unavailable"), status ? { status } : { transportFailure: true });
const response = (status, value) => ({ ok: status < 400, status, text: async () => JSON.stringify(value) });

async function setup(mode = "browser") {
  const h = consoleHarness();
  h.host.mode = mode;
  const [logs, state] = await h.imports(["pages/logs.js", "ui/state.js"]);
  h.get("logLevel").value = "all";
  h.get("logModule").value = "all";
  h.get("logsOutput").scrollTop = 7;
  h.get("logsOutput").scrollHeight = 100;
  return { h, logs, state: state.uiState, output: h.get("logsOutput"), count: h.get("logCount"), follow: h.get("logFollowButton") };
}

if (!vm.SourceTextModule) {
  test("isolated logs UI state tests", () => {
    const child = spawnSync(process.execPath, ["--experimental-vm-modules", "--test", fileURLToPath(import.meta.url)], { encoding: "utf8", windowsHide: true });
    assert.equal(child.status, 0, child.stdout + child.stderr);
  });
} else {
  test("unread filters cannot claim the logs are empty or display unvalidated cached lines", async () => {
    const f = await setup();
    f.state.logLines = ["not a validated snapshot"];
    f.h.get("logFilter").value = "missing";
    f.logs.applyLogFilter();
    assert.match(f.output.textContent, /尚未读取/);
    assert.doesNotMatch(f.output.textContent, /暂无日志|没有匹配|not a validated/);
    assert.equal(f.output.dataset.state, "unread");
    assert.equal(f.count.textContent, "未读取");
    assert.equal(f.follow.disabled, true);
    assert.equal(f.output.scrollTop, 7);
  });

  test("initial loading remains loading through all filters and ends only on a valid response", async () => {
    const f = await setup();
    f.state.logFollow = true;
    const pending = deferred();
    f.logs.setLogsLoading();
    const refresh = pending.promise.then(f.logs.renderLogs);
    await flush();
    for (const [id, value] of [["logFilter", "missing"], ["logLevel", "error"], ["logModule", "model"]]) {
      f.h.get(id).value = value;
      f.logs.applyLogFilter();
      assert.match(f.output.textContent, /正在读取日志/);
      assert.doesNotMatch(f.output.textContent, /暂无日志|没有匹配/);
      assert.equal(f.output.dataset.state, "loading");
      assert.equal(f.output.attributes["aria-busy"], "true");
      assert.equal(f.count.textContent, "读取中");
      assert.equal(f.state.logsLoaded, false);
      assert.equal(f.follow.disabled, true);
      assert.equal(f.follow.textContent, "跟随暂停");
      assert.equal(f.follow.classList.contains("active"), false);
      assert.equal(f.output.scrollTop, 7);
    }
    pending.resolve(snapshot(["[E] model missing"]));
    await refresh;
    assert.equal(f.output.dataset.state, "ready");
    assert.equal(f.output.attributes["aria-busy"], "false");
    assert.equal(f.output.textContent, "[E] model missing");
    assert.equal(f.state.logsLoaded, true);
    assert.equal(f.follow.disabled, false);
    assert.equal(f.follow.textContent, "停止跟随");
    assert.equal(f.output.scrollTop, 100);
  });

  test("refresh loading marks the retained snapshot stale and pauses follow without losing its preference", async () => {
    const f = await setup();
    f.state.logFollow = true;
    f.logs.renderLogs(snapshot(["[E] model cached", "[I] message cached"]));
    f.output.scrollTop = 7;
    f.logs.setLogsLoading();
    assert.match(f.output.textContent, /正在读取日志.*\n.*上次快照（已过期）.*\n.*cached/);
    assert.equal(f.output.dataset.stale, "true");
    assert.equal(f.count.textContent, "2 条（过期快照）");
    f.h.get("logLevel").value = "error";
    f.logs.applyLogFilter();
    assert.match(f.output.textContent, /正在读取日志.*\n.*非最新日志.*\n.*model cached/);
    assert.doesNotMatch(f.output.textContent, /message cached/);
    assert.equal(f.count.textContent, "1 / 2 条（过期快照）");
    f.h.get("logFilter").value = "missing";
    f.logs.applyLogFilter();
    assert.match(f.output.textContent, /正在读取日志.*\n.*上次快照.*\n没有匹配的日志/);
    assert.equal(f.output.dataset.state, "loading");
    assert.equal(f.count.textContent, "0 / 2 条（过期快照）");
    assert.equal(f.follow.disabled, true);
    assert.equal(f.state.logFollow, true);
    assert.equal(f.output.scrollTop, 7);
  });

  for (const status of [503, undefined]) {
    test(`${status ?? "transport"} failure without a snapshot cannot become empty after filtering`, async () => {
      const f = await setup();
      f.logs.setLogsLoading();
      f.logs.logsReadFailed(failure(status));
      f.h.get("logModule").value = "network";
      f.logs.applyLogFilter();
      assert.match(f.output.textContent, /日志读取失败.*synthetic unavailable.*刷新重试/);
      assert.doesNotMatch(f.output.textContent, /暂无日志|没有匹配|上次快照/);
      assert.equal(f.output.dataset.state, "error");
      assert.equal(f.output.dataset.stale, "false");
      assert.equal(f.output.attributes["aria-busy"], "false");
      assert.equal(f.count.textContent, "读取失败");
      assert.equal(f.state.logsLoaded, false);
    });

    test(`${status ?? "transport"} failure retains a stale snapshot and failure notice under each filter`, async () => {
      const f = await setup();
      f.state.logFollow = true;
      f.logs.renderLogs(snapshot(["[E] model cached", "[I] message cached"]));
      f.output.scrollTop = 7;
      f.logs.setLogsLoading();
      f.logs.logsReadFailed(failure(status));
      for (const [id, value] of [["logFilter", "cached"], ["logLevel", "error"], ["logModule", "model"], ["logFilter", "missing"]]) {
        f.h.get(id).value = value;
        f.logs.applyLogFilter();
        assert.match(f.output.textContent, /日志读取失败.*synthetic unavailable.*\n.*已过期.*非最新日志/);
        assert.equal(f.output.dataset.state, "error");
        assert.equal(f.output.dataset.stale, "true");
        assert.match(f.count.textContent, /过期快照/);
        assert.equal(f.follow.disabled, true);
        assert.equal(f.follow.classList.contains("active"), false);
        assert.equal(f.output.scrollTop, 7);
      }
      assert.match(f.output.textContent, /没有匹配的日志/);
      assert.equal(f.count.textContent, "0 / 2 条（过期快照）");
      assert.deepEqual(Array.from(f.state.logLines), ["[E] model cached", "[I] message cached"]);
      assert.equal(f.state.logsLoaded, false);
    });
  }

  for (const status of [401, 403, "403"]) {
    test(`${status} clears cached lines and no filter or retry can reveal them`, async () => {
      const f = await setup();
      f.state.logFollow = true;
      f.logs.renderLogs(snapshot(["synthetic restricted line"]));
      f.output.scrollTop = 7;
      f.logs.logsReadFailed(failure(status));
      assert.deepEqual(Array.from(f.state.logLines), []);
      f.h.get("logFilter").value = "restricted";
      f.logs.applyLogFilter();
      assert.match(f.output.textContent, /无权读取日志.*清除缓存/);
      assert.doesNotMatch(f.output.textContent, /synthetic restricted|暂无日志|上次快照/);
      assert.equal(f.count.textContent, "读取失败");
      assert.equal(f.output.dataset.stale, "false");
      assert.equal(f.follow.disabled, true);
      f.logs.setLogsLoading();
      assert.doesNotMatch(f.output.textContent, /synthetic restricted|上次快照/);
      f.logs.logsReadFailed(failure(503));
      assert.doesNotMatch(f.output.textContent, /synthetic restricted|上次快照/);
      assert.equal(f.output.scrollTop, 7);
      f.logs.renderLogs(snapshot(["new restricted response"]));
      assert.equal(f.output.textContent, "new restricted response");
      assert.equal(f.output.dataset.stale, "false");
      assert.equal(f.state.logsLoaded, true);
      assert.equal(f.follow.disabled, false);
      assert.equal(f.output.scrollTop, 100);
    });
  }

  test("canonical backend empty is distinct from a nonempty snapshot with no keyword, level or module matches", async () => {
    const f = await setup();
    f.h.get("logFilter").value = "missing";
    f.logs.renderLogs(snapshot());
    assert.equal(f.output.textContent, "暂无日志");
    assert.equal(f.output.dataset.state, "empty");
    assert.equal(f.count.textContent, "0 条");
    assert.equal(f.state.logsLoaded, true);
    for (const [id, value] of [["logFilter", "missing"], ["logLevel", "error"], ["logModule", "model"]]) {
      f.h.get("logFilter").value = "";
      f.h.get("logLevel").value = "all";
      f.h.get("logModule").value = "all";
      f.h.get(id).value = value;
      f.logs.renderLogs(snapshot(["[I] ordinary line"]));
      assert.equal(f.output.textContent, "没有匹配的日志");
      assert.equal(f.output.dataset.state, "no-match");
      assert.equal(f.output.dataset.stale, "false");
      assert.equal(f.count.textContent, "0 / 1 条");
    }
  });

  test("a previously empty snapshot becomes unknown/stale after failure, not current empty", async () => {
    const f = await setup();
    f.logs.renderLogs(snapshot());
    f.logs.logsReadFailed(failure(503));
    f.logs.applyLogFilter();
    assert.match(f.output.textContent, /日志读取失败.*\n.*已过期.*\n.*上次快照为空.*当前日志状态未知/);
    assert.doesNotMatch(f.output.textContent, /暂无日志/);
    assert.equal(f.output.dataset.state, "error");
    assert.equal(f.output.dataset.stale, "true");
    assert.equal(f.count.textContent, "0 条（过期快照）");
  });

  const malformed = [
    ["undefined", undefined], ["null", null], ["array", []], ["text", "<html>not logs</html>"],
    ["missing current", {}], ["null current", { current: null }], ["array current", { current: [] }],
    ["missing lines", { current: {} }], ["null lines", { current: { lines: null } }],
    ["string lines", { current: { lines: "not an array" } }],
    ["object line", { current: { lines: [{ message: "not a string" }] } }],
    ["number line", { current: { lines: [42] } }], ["null line", { current: { lines: [null] } }],
    ["mixed lines", { current: { lines: ["valid line", false] } }],
    ["sparse lines", { current: { lines: Array(1) } }],
    ["wrong count", snapshot([], { count: 1 })], ["string count", snapshot([], { count: "0" })],
    ["invalid truncated", snapshot([], { truncated: "false" })],
    ["invalid file", snapshot([], { file: 42 })], ["null file with lines", snapshot(["line"], { file: null })],
    ["invalid files", { ...snapshot(), files: {} }], ["error envelope", { ...snapshot(), error: "failure" }],
    ["failed envelope", { ...snapshot(), ok: false }],
    ["oversized tail", snapshot(Array(1001).fill("line"))],
  ];
  for (const [label, value] of malformed) {
    test(`malformed HTTP 200 (${label}) fails without becoming empty/success or replacing a validated snapshot`, async () => {
      for (const retained of [false, true]) {
        const f = await setup();
        if (retained) f.logs.renderLogs(snapshot(["validated cached line"]));
        f.logs.setLogsLoading();
        assert.throws(() => f.logs.renderLogs(value), error => error.responseInvalid === true);
        f.h.get("logFilter").value = "cached";
        f.logs.applyLogFilter();
        assert.match(f.output.textContent, /日志读取失败.*格式错误/);
        assert.doesNotMatch(f.output.textContent, /暂无日志|\[object Object\]/);
        assert.equal(f.output.dataset.state, "error");
        assert.equal(f.output.dataset.stale, String(retained));
        assert.equal(f.state.logsLoaded, false);
        assert.equal(f.follow.disabled, true);
        assert.deepEqual(Array.from(f.state.logLines), retained ? ["validated cached line"] : []);
      }
    });
  }

  test("retry retains its failure warning until valid recovery replaces the snapshot and clears all failed state", async () => {
    const f = await setup();
    f.state.logFollow = true;
    f.logs.renderLogs(snapshot(["old line"]));
    f.logs.logsReadFailed(failure(503));
    f.logs.setLogsLoading();
    f.logs.applyLogFilter();
    assert.match(f.output.textContent, /正在读取日志.*\n.*上次日志读取失败.*\n.*过期/);
    f.logs.renderLogs(snapshot(["recovered line"]));
    assert.equal(f.output.textContent, "recovered line");
    assert.equal(f.output.dataset.state, "ready");
    assert.equal(f.output.dataset.stale, "false");
    assert.equal(f.output.attributes["aria-busy"], "false");
    assert.equal(f.count.textContent, "1 条");
    assert.equal(f.count.dataset.stale, "false");
    assert.equal(f.follow.disabled, false);
    assert.equal(f.follow.classList.contains("active"), true);
    assert.equal(f.follow.textContent, "停止跟随");
    assert.match(f.follow.title, /不会自动刷新/);
    f.logs.setLogsLoading();
    assert.doesNotMatch(f.output.textContent, /synthetic unavailable|日志读取失败/);
    f.logs.renderLogs(snapshot());
    assert.equal(f.output.textContent, "暂无日志");
    assert.equal(f.output.dataset.state, "empty");
  });

  for (const mode of ["browser", "desktop"]) {
    test(`${mode} minimal snapshot remains compatible, copied and rendered as text`, async () => {
      const f = await setup(mode);
      const lines = ["<img src=x onerror=synthetic()> [W] network warning", "[E] model failed"];
      f.logs.renderLogs({ current: { lines } });
      lines.push("must not enter the cache");
      assert.equal(f.output.textContent, lines.slice(0, 2).join("\n"));
      assert.equal(f.output.innerHTML, "");
      assert.equal(f.count.textContent, "2 条");
      assert.equal(f.output.scrollTop, 7);
      f.h.get("logLevel").value = "warn";
      f.h.get("logModule").value = "network";
      f.logs.applyLogFilter();
      assert.equal(f.output.textContent, lines[0]);
      assert.equal(f.count.textContent, "1 / 2 条");
      f.logs.renderLogs({ current: { lines: [] } });
      assert.equal(f.output.textContent, "暂无日志");
    });
  }

  test("the reader's maximum tail and valid truncation metadata are accepted", async () => {
    const f = await setup();
    f.logs.renderLogs(snapshot(Array(1000).fill("bounded line"), { truncated: true }));
    assert.equal(f.state.logLines.length, 1000);
    assert.equal(f.count.textContent, "1,000 条");
    assert.equal(f.state.logsLoaded, true);
  });

  test("optional desktop controls can be absent while output and loading state remain usable", async () => {
    const f = await setup("desktop");
    const get = f.h.document.getElementById;
    f.h.document.getElementById = id => ["logFilter", "logLevel", "logModule", "logCount", "logFollowButton"].includes(id) ? null : get(id);
    f.logs.setLogsLoading();
    assert.equal(f.output.dataset.state, "loading");
    f.logs.renderLogs(snapshot(["desktop line"]));
    assert.equal(f.output.textContent, "desktop line");
    f.logs.logsReadFailed(failure(403));
    assert.doesNotMatch(f.output.textContent, /desktop line/);
  });

  test("mocked browser log HTTP responses use the helper contract without shared action/overview edits", async () => {
    const f = await setup();
    const replies = [response(200, snapshot(["initial line"])), response(503, { error: "synthetic unavailable" }),
      response(200, { current: { lines: [42] } }), response(403, { error: "synthetic denied" }), response(200, snapshot())];
    let requests = 0;
    f.h.window.fetch = async () => { requests++; return replies.shift(); };
    const host = f.h.runHost();
    const refresh = async () => {
      f.logs.setLogsLoading();
      try { f.logs.renderLogs(await host.call("getLogs")); }
      catch (error) { f.logs.logsReadFailed(error); }
    };
    await refresh();
    assert.equal(f.output.textContent, "initial line");
    await refresh();
    f.logs.applyLogFilter();
    assert.match(f.output.textContent, /日志读取失败.*\n.*已过期.*\ninitial line/);
    await refresh();
    assert.match(f.output.textContent, /日志读取失败.*格式错误.*\n.*已过期/);
    await refresh();
    assert.deepEqual(Array.from(f.state.logLines), []);
    assert.match(f.output.textContent, /无权读取日志/);
    await refresh();
    assert.equal(f.output.textContent, "暂无日志");
    assert.equal(f.state.logsLoaded, true);
    assert.equal(requests, 5);
    assert.equal(replies.length, 0);
  });
}
