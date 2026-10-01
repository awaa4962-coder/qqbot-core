import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import test from "node:test";
import { fileURLToPath, URL } from "node:url";
import { runVmTestFile } from "./vm-test-runner.mjs";

const SOURCE = fileURLToPath(new URL("../launcher/QQFriendLauncher/Web/agent-drafts.js", import.meta.url));
const ID = "c96cf9b3-51be-4fd8-9c22-47763f884144";
const OTHER_ID = "21d770d8-295e-40bc-823c-5edb0d435192";
const START = Date.parse("2026-10-01T00:00:00Z");
const PHASES = { queued: "排队中", collecting: "收集中", analyzing: "分析中", fallback: "备用处理中",
  overdue: "已超时，等待收尾", cancelling: "取消中", cancelled: "已取消", done: "已完成", failed: "失败", interrupted: "已中断" };

function node(document, tag = "div") {
  let text = "";
  return {
    ownerDocument: document, tagName: tag.toUpperCase(), className: "", children: [], attributes: {},
    dataset: {}, style: {}, disabled: false, listeners: {},
    get textContent() { return text + this.children.map(child => child.textContent).join(""); },
    set textContent(value) { text = String(value); this.children = []; },
    set innerHTML(_value) { assert.fail("HTML parsing forbidden"); },
    set outerHTML(_value) { assert.fail("HTML parsing forbidden"); },
    insertAdjacentHTML() { assert.fail("HTML parsing forbidden"); },
    append(...children) { this.children.push(...children); },
    replaceChildren(...children) { text = ""; this.children = [...children]; },
    setAttribute(name, value) { this.attributes[name] = String(value); },
    addEventListener() { assert.fail("renderer must not attach callbacks"); },
  };
}

async function environment() {
  const forbidden = () => assert.fail("renderer I/O, timers, storage and callbacks forbidden");
  const document = { createElement: tag => node(document, tag), addEventListener: forbidden };
  const window = new Proxy({}, { get: forbidden });
  const context = vm.createContext({ document, window, fetch: forbidden, XMLHttpRequest: forbidden, WebSocket: forbidden,
    setInterval: forbidden, setTimeout: forbidden, queueMicrotask: forbidden, MutationObserver: forbidden,
    localStorage: new Proxy({}, { get: forbidden }), sessionStorage: new Proxy({}, { get: forbidden }),
    navigator: new Proxy({}, { get: forbidden }), console: new Proxy({}, { get: forbidden }) });
  const module = new vm.SourceTextModule(fs.readFileSync(SOURCE, "utf8"), { identifier: SOURCE, context });
  await module.link(() => assert.fail("standalone renderer must not import I/O"));
  await module.evaluate();
  return { document, container: () => node(document), mount: module.namespace.mountAgentDrafts, renderer: module.namespace };
}

const job = (extra = {}) => ({ id: ID, action: "daily", phase: "queued", startedAt: START, resultAvailable: false, ...extra });
const ready = (extra = {}) => ({ status: "ready", enabled: false, tasks: [], ...extra });
const result = (extra = {}) => ({ text: "A cleaned draft.", coverage: { captured: 3, complete: false }, sent: false, persisted: false, ...extra });
function loaded(extra = {}) {
  const completed = job({ phase: "done", finishedAt: START + 1000, resultAvailable: true });
  return ready({ enabled: true, tasks: [completed], task: { ...completed, result: result() }, ...extra });
}
const descendants = element => [element, ...element.children.flatMap(descendants)];
const find = (element, tag) => descendants(element).filter(item => item.tagName === tag.toUpperCase());
const commands = (element, action) => find(element, "button").filter(item => item.dataset.action === action);
const output = element => descendants(element).map(item => item.textContent + JSON.stringify(item.attributes) + JSON.stringify(item.dataset)).join("\n");
const render = (h, value) => h.mount(h.container(), value);

if (!vm.SourceTextModule) {
  test("agent drafts execute real isolated VM cases", t => {
    t.diagnostic(JSON.stringify(runVmTestFile(import.meta.url, { minTests: 28 })));
  });
} else {
  test("valid empty snapshot stays explicitly unopened without a fabricated task count or result", async () => {
    const h = await environment(); const panel = render(h, ready());
    assert.match(panel.textContent, /未开放/); assert.match(panel.textContent, /服务端未列出任务/);
    assert.match(panel.textContent, /尚未载入草稿/);
    assert.doesNotMatch(panel.textContent, /0.*任务|已完成|成功|已开放|未发送|未落盘/);
    assert.equal(find(panel, "table").length, 0); assert.equal(find(panel, "pre").length, 0);
    assert.equal(commands(panel, "refreshAgentDrafts").length, 1);
    assert.equal(commands(panel, "refreshAgentDrafts")[0].disabled, false);
  });

  test("unavailable suppresses stale jobs and bodies and allows only manual refresh", async () => {
    const h = await environment(); const panel = render(h, loaded({ status: "unavailable", enabled: false }));
    assert.match(panel.textContent, /状态无法读取.*未开放/); assert.match(panel.textContent, /任务列表未知/);
    assert.equal(find(panel, "button").length, 1); assert.equal(find(panel, "pre").length, 0);
    assert.doesNotMatch(panel.textContent, /已完成|A cleaned|已停止|0.*任务/);
  });

  test("legacy missing and malformed snapshot fields fail closed rather than becoming ready", async () => {
    const h = await environment();
    for (const value of [undefined, null, true, [], {}, { enabled: true, tasks: [] }, ready({ status: "success" }),
      loaded({ enabled: undefined }), loaded({ enabled: "true" }), loaded({ tasks: undefined }), loaded({ tasks: {} }),
      loaded({ status: "READY" }), loaded({ status: "constructor" }), Object.create(loaded())]) {
      const panel = render(h, value);
      assert.match(panel.textContent, /未知/); assert.equal(find(panel, "button").length, 1);
      assert.equal(find(panel, "pre").length, 0); assert.doesNotMatch(panel.textContent, /已完成|A cleaned|成功|0.*任务/);
    }
  });

  test("all fixed phases and action labels render without copying source codes", async () => {
    const h = await environment();
    for (const [phase, label] of Object.entries(PHASES)) {
      for (const action of ["daily", "conversation"]) {
        const panel = render(h, ready({ tasks: [job({ phase, action })] }));
        assert.match(panel.textContent, new RegExp(label));
        assert.match(panel.textContent, action === "daily" ? /日报草稿/ : /对话总结草稿/);
        assert.doesNotMatch(panel.textContent, /queued|collecting|analyzing|fallback|overdue|cancelling|cancelled|done|failed|interrupted|conversation|daily/);
      }
    }
  });

  test("only active enabled jobs have cancel commands and cancelling remains a disabled request", async () => {
    const h = await environment();
    for (const phase of ["queued", "collecting", "analyzing", "fallback", "overdue", "cancelling"]) {
      const panel = render(h, ready({ enabled: true, tasks: [job({ phase })] }));
      const cancel = commands(panel, "cancelAgentDraft");
      assert.equal(cancel.length, 1); assert.equal(cancel[0].dataset.taskId, ID);
      assert.equal(cancel[0].disabled, phase === "cancelling");
      assert.equal(cancel[0].textContent, phase === "cancelling" ? "取消中" : "取消任务");
      assert.doesNotMatch(panel.textContent, /已停止|已取消/);
      const closed = render(h, ready({ tasks: [job({ phase })] }));
      assert.equal(commands(closed, "cancelAgentDraft").length, 0); assert.match(closed.textContent, /未开放/);
    }
  });

  test("done failed interrupted and cancelled are terminal and never offer pseudo-cancellation", async () => {
    const h = await environment();
    for (const phase of ["done", "failed", "interrupted", "cancelled"]) {
      const panel = render(h, ready({ enabled: true, tasks: [job({ phase, resultAvailable: true })] }));
      assert.equal(commands(panel, "cancelAgentDraft").length, 0);
      assert.equal(commands(panel, "inspectAgentDraft")[0].disabled, phase !== "done");
      assert.match(panel.textContent, new RegExp(PHASES[phase]));
      assert.equal(find(panel, "pre").length, 0);
    }
  });

  test("inspect is enabled only for validated done jobs with the exact true availability flag", async () => {
    const h = await environment();
    for (const phase of Object.keys(PHASES)) {
      for (const resultAvailable of [true, false, undefined, null, 1, "true"]) {
        const panel = render(h, ready({ enabled: true, tasks: [job({ phase, resultAvailable })] }));
        const inspect = commands(panel, "inspectAgentDraft");
        assert.equal(inspect.some(item => !item.disabled), phase === "done" && resultAvailable === true);
        if (typeof resultAvailable !== "boolean") assert.match(panel.textContent, /状态未知/);
      }
    }
  });

  test("invalid IDs never reach action attributes or visible task metadata", async () => {
    const h = await environment();
    for (const id of [null, 12345, {}, [], "", "123456789", "../private", ID + " ", " " + ID,
      ID + "\n", ID + "\r", ID + "\u2028", ID + "\u2029",
      "00000000-0000-0000-0000-000000000000", ID.replace("4fd8", "0fd8"), ID.replace("9c22", "1c22"),
      'bad-id-<img onerror="alert(1)">', "sk-SYNTHETIC-PRIVATE", "x".repeat(100000)]) {
      const panel = render(h, ready({ enabled: true, tasks: [job({ id, phase: "done", resultAvailable: true })] }));
      assert.equal(commands(panel, "inspectAgentDraft").length, 0);
      assert.equal(commands(panel, "cancelAgentDraft").length, 0); assert.match(panel.textContent, /状态未知/);
      assert.doesNotMatch(output(panel), /123456789|private|onerror|sk-SYNTHETIC|00000000-0000/);
      assert.ok(output(panel).length < 10000);
    }
    const panel = render(h, ready({ enabled: true, tasks: [job({ id: ID.toUpperCase() })] }));
    assert.equal(commands(panel, "cancelAgentDraft")[0].dataset.taskId, ID.toUpperCase());
  });

  test("unknown actions phases and missing job fields stay unknown with no operative command", async () => {
    const h = await environment();
    for (const value of [null, true, [], {}, job({ action: undefined }), job({ phase: undefined }),
      job({ action: "constructor" }), job({ phase: "success" }), job({ phase: "running" }),
      job({ action: '<svg onload="alert(1)">' }), job({ phase: "__proto__" }), Object.create(job())]) {
      const panel = render(h, ready({ enabled: true, tasks: [value] }));
      assert.match(panel.textContent, /未知/); assert.equal(find(panel, "button").length, 1);
      assert.doesNotMatch(output(panel), /constructor|__proto__|onload|running|success/);
    }
  });

  test("bad timestamps and contradictory finished active jobs do not assert success", async () => {
    const h = await environment();
    for (const extra of [{ startedAt: undefined }, { startedAt: "2026-10-01" }, { startedAt: -1 },
      { startedAt: NaN }, { startedAt: Infinity }, { startedAt: Number.MAX_SAFE_INTEGER },
      { finishedAt: null }, { finishedAt: START - 1 }, { startedAt: 1.5 }, { finishedAt: "123" }]) {
      const panel = render(h, ready({ enabled: true, tasks: [job({ phase: "done", resultAvailable: true, ...extra })] }));
      assert.match(panel.textContent, /状态未知/); assert.equal(find(panel, "button").length, 1);
      assert.doesNotMatch(panel.textContent, /已完成|Invalid Date|NaN|Infinity/);
    }
    const panel = render(h, ready({ enabled: true, tasks: [job({ phase: "collecting", finishedAt: START + 1 })] }));
    assert.equal(commands(panel, "cancelAgentDraft").length, 0); assert.match(panel.textContent, /状态未知/);
    const valid = render(h, loaded());
    assert.match(valid.textContent, /2026-10-01 08:00:00/); assert.match(valid.textContent, /结束：2026-10-01 08:00:01/);
  });

  test("duplicate case-insensitive IDs and oversized or sparse lists cannot look empty or actionable", async () => {
    const h = await environment();
    for (const tasks of [[job(), job({ id: ID.toUpperCase() })], Array.from({ length: 101 }, () => job())]) {
      const panel = render(h, loaded({ tasks }));
      assert.match(panel.textContent, /任务列表未知/); assert.equal(find(panel, "button").length, 1);
      assert.equal(find(panel, "pre").length, 0); assert.doesNotMatch(panel.textContent, /服务端未列出任务/);
    }
    const sparse = render(h, ready({ tasks: new Array(2) }));
    assert.match(sparse.textContent, /状态未知/); assert.doesNotMatch(sparse.textContent, /服务端未列出任务/);
  });

  test("list bodies private fields and nested raw envelopes are never read or spread", async () => {
    const h = await environment(); const item = job({ phase: "done", resultAvailable: true });
    for (const key of ["result", "body", "raw", "reasoning_content", "key", "path", "qqIds", "userRecords"]) {
      Object.defineProperty(item, key, { get: () => assert.fail("list-only field read: " + key) });
    }
    const panel = render(h, ready({ tasks: [item] }));
    assert.equal(find(panel, "pre").length, 0); assert.match(panel.textContent, /尚未载入草稿/);
    assert.equal(commands(panel, "inspectAgentDraft")[0].disabled, false);
  });

  test("safe error codes map to fixed messages without displaying the code itself", async () => {
    const h = await environment();
    const labels = { invalid_arguments: "参数无效", not_allowed: "未获授权", target_not_allowed: "目标未获授权",
      invalid_date: "日期无效", guard_unavailable: "安全检查不可用", model_callback_required: "模型接口不可用",
      cancelled: "取消请求已处理", permission_changed: "权限已变化", privacy_changed: "隐私设置已变化",
      stale_request: "请求已失效", budget_exceeded: "任务预算超限", no_records: "无可用记录",
      model_unavailable: "模型不可用", unsafe_service_result: "结果未通过安全检查", business_unavailable: "业务不可用" };
    for (const [error, label] of Object.entries(labels)) {
      const panel = render(h, ready({ enabled: true, tasks: [job({ phase: "failed", error })] }));
      assert.match(panel.textContent, new RegExp(label)); assert.ok(!output(panel).includes(error));
      assert.equal(commands(panel, "cancelAgentDraft").length, 0);
    }
  });

  test("unsafe error text objects and prototype names never leak into text attributes or dataset", async () => {
    const h = await environment(); const raw = 'VENDOR-PRIVATE sk-SYNTHETIC-PRIVATE C:\\private\\key <img onerror="alert(1)">';
    for (const error of [raw, "constructor", "__proto__", "unknown_vendor_error", { code: "no_records", message: raw }, true, 42, []]) {
      const panel = render(h, ready({ tasks: [job({ phase: "failed", error })] }));
      assert.match(panel.textContent, /错误未知/);
      assert.doesNotMatch(output(panel), /VENDOR-PRIVATE|sk-SYNTHETIC|private|onerror|constructor|__proto__|unknown_vendor_error|no_records/);
    }
  });

  test("selected completed task renders only textContent pre and structured coverage with real false flags", async () => {
    const h = await environment(); const data = loaded(); const panel = render(h, data);
    assert.equal(find(panel, "pre").length, 1); assert.equal(find(panel, "pre")[0].textContent, data.task.result.text);
    assert.match(panel.textContent, /未发送 · 未落盘/); assert.match(panel.textContent, /采集记录3/);
    assert.match(panel.textContent, /完整覆盖否/); assert.equal(commands(panel, "cancelAgentDraft").length, 0);
    assert.doesNotMatch(output(panel), /sent|persisted|resultAvailable|coverage|provider|reasoning/);
  });

  test("unopened group remains unopened while allowing read-only inspection of validated historical drafts", async () => {
    const h = await environment(); const panel = render(h, loaded({ enabled: false }));
    assert.match(panel.textContent, /未开放/); assert.doesNotMatch(panel.textContent, /已开放/);
    assert.equal(commands(panel, "inspectAgentDraft")[0].disabled, false);
    assert.equal(commands(panel, "cancelAgentDraft").length, 0); assert.equal(find(panel, "pre").length, 1);
  });

  test("XSS and HTML-looking drafts remain inert literal text rather than inserted markup", async () => {
    const h = await environment(); const text = '<img src=x onerror="alert(1)">\n<script>alert(2)</script>\n<a href="javascript:alert(3)">link</a>';
    const data = loaded(); data.task.result.text = text;
    const panel = render(h, data); const pre = find(panel, "pre")[0];
    assert.ok(pre); assert.equal(pre.textContent, text); assert.equal(pre.children.length, 0);
    assert.equal(find(panel, "img").length, 0); assert.equal(find(panel, "script").length, 0); assert.equal(find(panel, "a").length, 0);
    for (const element of descendants(panel)) assert.ok(Object.keys(element.attributes).every(name => !/^on/i.test(name)));
  });

  test("active and terminal non-done selected jobs cannot expose even an attached result", async () => {
    const h = await environment();
    for (const phase of Object.keys(PHASES).filter(value => value !== "done")) {
      const data = loaded(); data.task.phase = phase; data.tasks[0].phase = phase;
      delete data.task.finishedAt; delete data.tasks[0].finishedAt;
      const panel = render(h, data);
      assert.equal(find(panel, "pre").length, 0); assert.match(panel.textContent, /结果未知/);
      assert.doesNotMatch(panel.textContent, /A cleaned|未发送|未落盘|已停止/);
    }
  });

  test("unknown result availability missing body bad result types and unconfirmed safety flags hide preview", async () => {
    const h = await environment();
    for (const value of [undefined, null, true, [], {}, "raw body", result({ sent: undefined }), result({ persisted: undefined }),
      result({ sent: 0 }), result({ persisted: "false" }), result({ sent: true }), result({ persisted: true }),
      result({ text: { text: "A cleaned draft." } }), result({ text: "" }), result({ text: "  " }), Object.create(result())]) {
      const data = loaded(); data.task.result = value;
      const panel = render(h, data);
      assert.equal(find(panel, "pre").length, 0); assert.match(panel.textContent, /结果未知/);
      assert.doesNotMatch(panel.textContent, /A cleaned|未发送|未落盘/);
    }
    for (const availability of [undefined, false, "true", 1]) {
      const data = loaded(); data.task.resultAvailable = availability;
      assert.equal(find(render(h, data), "pre").length, 0);
    }
  });

  test("selected result must agree with list identity action start time and completed lifecycle", async () => {
    const h = await environment();
    for (const extra of [{ id: OTHER_ID }, { id: "123456789" }, { action: "conversation" }, { startedAt: START - 1 }, { phase: "failed" }]) {
      const data = loaded(); Object.assign(data.task, extra);
      const panel = render(h, data); assert.match(panel.textContent, /结果未知/); assert.equal(find(panel, "pre").length, 0);
    }
    for (const tasks of [[], [job({ phase: "failed", resultAvailable: true })], [job({ phase: "done", resultAvailable: false })]]) {
      const panel = render(h, loaded({ tasks }));
      assert.match(panel.textContent, /结果未知/); assert.equal(find(panel, "pre").length, 0);
    }
  });

  test("long list metadata and long or late-tainted result text are bounded without silent truncation", async () => {
    const h = await environment();
    for (const text of ["a".repeat(32769), "a".repeat(1000000), "a".repeat(32000) + "\nBearer SYNTHETIC-PRIVATE"]) {
      const data = loaded(); data.task.result.text = text;
      const panel = render(h, data);
      assert.match(panel.textContent, /结果未知/); assert.equal(find(panel, "pre").length, 0); assert.ok(output(panel).length < 10000);
    }
    const data = loaded(); data.task.result.text = "a".repeat(32768);
    assert.equal(find(render(h, data), "pre")[0].textContent.length, 32768);
  });

  test("credentials reasoning raw envelopes and local paths are rejected even inside the draft text", async () => {
    const h = await environment();
    for (const text of ["sk-SYNTHETIC-PRIVATE", "Bearer SYNTHETIC-PRIVATE", 'api_key="SYNTHETIC-PRIVATE"',
      "password: SYNTHETIC-PRIVATE", "authorization: SYNTHETIC-PRIVATE", "token=SYNTHETIC-PRIVATE", "key: SYNTHETIC-PRIVATE",
      "api key: SYNTHETIC-PRIVATE", "private_key=SYNTHETIC-PRIVATE", "ghp_SYNTHETICPRIVATE", "github_pat_SYNTHETICPRIVATE",
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.SYNTHETICSIGNATURE", "-----BEGIN PRIVATE KEY-----", "<think>Private reasoning</think>",
      "<analysis>Private reasoning</analysis>", "reasoning_content: Private reasoning", "analysis: Private reasoning",
      "thinking: Private reasoning", "```analysis\nPrivate reasoning\n```",
      '<|channel|>analysis', '{"choices":[{"message":"raw"}]}', '[{"text":"raw envelope"}]',
      'C:\\private\\configuration.json', "F:/private/key", "/srv/private/key", "path=/srv/private/key", "文件：/srv/private/key",
      "../private/key", "~/private/key", "\\\\server\\private",
      "file:///private/key", "https://user:secret@synthetic.invalid", "https://synthetic.invalid?api_key=SYNTHETIC", "safe\u202eprivate"]) {
      const data = loaded(); data.task.result.text = text;
      const panel = render(h, data);
      assert.equal(find(panel, "pre").length, 0, text); assert.match(panel.textContent, /结果未知/);
      assert.doesNotMatch(output(panel), /SYNTHETIC|Private reasoning|private|reasoning_content|choices|eyJ/);
    }
  });

  test("R2 Basic and NFKC Cf-obfuscated credentials and paths never enter a preview or validate", async () => {
    const h = await environment(); const module = h.renderer;
    const credential = "c3ludGhldGljOnNlY3JldA==";
    for (const text of ["Basic " + credential, "basic " + credential, "Digest response=\"SYNTHETIC_SECRET\"",
      "ａｐｉ＿ｋｅｙ=SYNTHETIC_SECRET", "Ａｕｔｈｏｒｉｚａｔｉｏｎ＝Ｂａｓｉｃ " + credential,
      "api_\u00adkey=SYNTHETIC_SECRET", "Ｂａ\u2063ｓｉｃ " + credential, "Ｃ：／private／key", "path=／srv／private／key"]) {
      const data = loaded(); data.task.result.text = text;
      assert.equal(module.validateAgentDraftSnapshot(data, { requireResult: true }), false);
      const panel = render(h, data); assert.equal(find(panel, "pre").length, 0); assert.match(panel.textContent, /结果未知/);
      assert.doesNotMatch(output(panel), /SYNTHETIC_SECRET|c3ludGhldGlj|private|Bearer|Authorization|ａｐｉ/);
    }
  });

  test("R2 safe multilingual draft text remains exactly as supplied rather than displaying canonicalized text", async () => {
    const h = await environment(); const module = h.renderer;
    const data = loaded(); data.task.result.text = "讨论结论：Ａ方案通过，明日继续。\nRésumé et résultats.";
    assert.equal(module.validateAgentDraftSnapshot(data, { requireResult: true }), true);
    assert.equal(find(render(h, data), "pre")[0].textContent, data.task.result.text);
  });

  test("coverage uses allowlisted scalar counts and booleans without IDs paths raw metadata or invented zeros", async () => {
    const h = await environment(); const data = loaded();
    data.task.result.coverage = { captured: 0, selected: 3, background: "42", targetCount: -1, missingTargets: 2,
      malformed: {}, complete: false, partial: true, sampled: "yes", capped: false, truncated: 4,
      path: "C:/private/key", userId: "123456789", raw: { key: "sk-SYNTHETIC-PRIVATE" }, source: "private", body: "private" };
    const panel = render(h, data);
    assert.match(panel.textContent, /采集记录0/); assert.match(panel.textContent, /选中记录3/); assert.match(panel.textContent, /背景记录未知/);
    assert.match(panel.textContent, /目标数量未知/); assert.match(panel.textContent, /缺失目标2/); assert.match(panel.textContent, /截断情况4 条/);
    assert.doesNotMatch(output(panel), /123456789|private|sk-SYNTHETIC|"42"|body|path|source/);
    for (const coverage of [undefined, null, [], {}, { selected: undefined }, Object.create({ captured: 99 })]) {
      const empty = loaded(); empty.task.result.coverage = coverage;
      const rendered = render(h, empty);
      assert.match(rendered.textContent, /覆盖范围未知/); assert.doesNotMatch(rendered.textContent, /采集记录0|选中记录0|99/);
    }
  });

  test("selected extra fields and coverage unknown properties are not consulted", async () => {
    const h = await environment(); const data = loaded();
    for (const value of [data.task, data.task.result, data.task.result.coverage]) {
      for (const key of ["raw", "body", "reasoning_content", "apiKey", "path", "groupId", "userRecords"]) {
        Object.defineProperty(value, key, { get: () => assert.fail("unexpected property read: " + key) });
      }
    }
    assert.equal(find(render(h, data), "pre").length, 1);
  });

  test("320 390 and 1440 width constraints retain an unframed scroll-contained table and wrapping preview", async () => {
    const h = await environment();
    for (const width of [320, 390, 1440]) {
      const container = h.container(); container.style.width = width + "px";
      const panel = h.mount(container, loaded());
      assert.equal(panel.className, "agent-tools agent-drafts"); assert.equal(panel.style.minWidth, "0"); assert.equal(panel.style.maxWidth, "100%");
      assert.equal(find(panel, "section").length, 1); assert.equal(find(panel, "h3").length, 1);
      const wrap = descendants(panel).find(item => item.className === "agent-drafts-list");
      assert.equal(wrap.style.overflow, "auto"); assert.equal(wrap.style.maxWidth, "100%"); assert.equal(wrap.tabIndex, 0);
      assert.equal(find(panel, "table")[0].style.tableLayout, "fixed"); assert.equal(find(panel, "table")[0].style.minWidth, "420px");
      const operationWidth = parseFloat(find(panel, "th").at(-1).style.width);
      assert.ok(420 * operationWidth / 100 - 16 >= 96, "narrowest operation cell must fit its fixed button and padding");
      assert.equal(find(panel, "h4")[0].style.fontSize, "13px");
      const pre = find(panel, "pre")[0];
      assert.equal(pre.style.whiteSpace, "pre-wrap"); assert.equal(pre.style.overflowWrap, "anywhere"); assert.equal(pre.style.maxHeight, "360px");
      for (const button of find(panel, "button")) {
        assert.equal(button.type, "button"); assert.equal(button.style.width, "96px"); assert.equal(button.style.height, "34px");
        assert.equal(button.style.flexShrink, "0"); assert.equal(button.style.whiteSpace, "normal");
      }
    }
  });

  test("passive mount and remount preserve input snapshots siblings and dirty controls while clearing stale results", async () => {
    const h = await environment(); const container = h.container(); const parent = h.container(); const sibling = node(h.document, "input");
    sibling.value = "dirty parent input"; parent.append(container, sibling);
    const data = loaded(); const before = JSON.stringify(data);
    const freeze = value => {
      if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); }
    };
    freeze(data);
    const first = h.mount(container, data); assert.equal(JSON.stringify(data), before);
    const second = h.mount(container, { status: "unavailable", enabled: false });
    assert.notEqual(first, second); assert.equal(container.children.length, 1); assert.equal(container.children[0], second);
    assert.equal(parent.children[1], sibling); assert.equal(sibling.value, "dirty parent input");
    assert.equal(find(second, "pre").length, 0); assert.doesNotMatch(second.textContent, /A cleaned|已完成/);
    for (const element of descendants(second)) assert.deepEqual(element.listeners, {});
    assert.throws(() => h.mount(null, data), /DOM container/);
  });
}
