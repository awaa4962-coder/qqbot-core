import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { after, mock, test } from "node:test";

const parent = fs.realpathSync(os.tmpdir());
const root = fs.mkdtempSync(path.join(parent, "qqfriend-failed-attempt-"));
const env = { NODE_ENV: "test", QQBOT_CONFIG_ROOT: root, QQBOT_DATA_DIR: path.join(root, "data"),
  QQBOT_LOG_DIR: path.join(root, "logs"), QQBOT_TEMP_DIR: path.join(root, "temp"),
  QQBOT_MEMORY_PROFILE_FILE: path.join(root, "profiles.json") };
const prior = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
Object.assign(process.env, env);
const network = mock.method(globalThis, "fetch", () => { throw new Error("real network forbidden"); });
const { buildChatSystemPrompt } = await import("../bridge/system-prompts/chat.mjs");
const { buildModelPrompt } = await import("../bridge/system-prompts/compose.mjs");
const { CORE_IDENTITY, CONTEXT_SAFETY } = await import("../bridge/system-prompts/identity.mjs");
const { MEMORY_SEMANTIC_BOUNDARY } = await import("../bridge/memory-profile/semantics.mjs");
const { buildImageInterpretationRules } = await import("../bridge/system-prompts/image-context.mjs");
const { IMAGE_POLICY_EVIDENCE, IMAGE_POLICY_STABLE } = await import("../bridge/system-prompts/image-policy.mjs");
const { CFG } = await import("../bridge/config.mjs");
const { cleanupLogger } = await import("../bridge/logger.mjs");
const { saveApiProvider } = await import("../bridge/api-providers/store.mjs");
const { tryMiMoResult } = await import("../bridge/model-mimo.mjs");
const { tryDeepSeekResult } = await import("../bridge/model-ds.mjs");
const { withChatRun } = await import("../bridge/cognition/chat-run.mjs");
const { buildCurrentInput } = await import("../bridge/context/messages.mjs");
const evidence = { imagePolicy: IMAGE_POLICY_EVIDENCE };

after(() => {
  cleanupLogger();
  network.mock.restore();
  for (const [key, value] of Object.entries(prior)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  assert.equal(path.dirname(fs.realpathSync(root)), parent);
  fs.rmSync(root, { recursive: true, force: true });
});

// Prompt and mocked wire contracts only; the placeholder is not a semantic answer.
test("both real builders distinguish failed attempts and require this attempt's decisive evidence", () => {
  for (const imageTask of [false, true]) {
    const options = Object.freeze({ ...evidence, imageTask });
    const prompt = buildChatSystemPrompt(options);
    assert.equal(buildModelPrompt(options).system, prompt);
    assert.match(prompt, /已试失败非未试|已尝试但失败，不是未尝试/);
    assert.match(prompt, /失败不证建议有效或参数正确|不能证明先前建议有效或参数正确/);
    assert.match(prompt, /缺本次决定性报错(?:或|\/)现象只取该项|缺本次决定性报错或现象，只取这一项/);
    assert.match(prompt, /旧错误只确认是否同一|已有旧错误只确认本次是否仍同一错误/);
    assert.match(prompt, /本次报错\/现象足够则给有据步骤|本次报错或现象足够时给有依据的下一步/);
    assert.match(prompt, /错误标签不证(?:明)?前置步骤或口令(?:已)?成功/);
    assert.match(prompt, /不预写(?:各错误分支的)?确定诊断/);
    assert.doesNotMatch(prompt, /本次错误才给/);
    assert.match(prompt, /不重复|不重复已试动作/);
    assert.match(prompt, /未试才解释/);
    assert.match(prompt, /不猜密码(?:、|\/)参数(?:、|\/)编码(?:或|\/)工具原因/);
    assert.match(prompt, /empty\/denied\/unavailable.*状态.*不证(?:明)?(?:已)?删除.*网络(?:或|\/)连接故障/);
    assert.match(prompt, /不猜机制.*(?:合法真实错误证据|真实合法错误)/);
    if (!imageTask) {
      const example = prompt.split("\n").find(line => line.startsWith("承接示例："));
      assert.match(example, /前轮建议改一个参数且已试失败，先确认本次现象而不推定参数正确/);
      assert.doesNotMatch(example, /FS|漏字符|解压器/);
    }
    for (const text of [CORE_IDENTITY, CONTEXT_SAFETY, MEMORY_SEMANTIC_BOUNDARY,
      buildImageInterpretationRules(options)]) assert.equal(prompt.split(text).length, 2);
  }
});

test("original focused ceiling and twenty percent reduction hold with bounded shared-rule growth", t => {
  const baselines = { chat: 3018, interjection: 2999, technical: 2951, summary: 2951, admin: 2951 };
  for (const [replyMode, before] of Object.entries(baselines)) {
    const normal = buildChatSystemPrompt({ ...evidence, replyMode });
    const focused = buildChatSystemPrompt({ ...evidence, replyMode, imageTask: true });
    assert.ok(normal.length <= before + 82);
    assert.ok(focused.length <= 2360);
    assert.ok(focused.length <= normal.length * 0.8);
    assert.equal(buildChatSystemPrompt({ imagePolicy: IMAGE_POLICY_STABLE, replyMode, imageTask: true }),
      buildChatSystemPrompt({ imagePolicy: IMAGE_POLICY_STABLE, replyMode }));
    t.diagnostic(`${replyMode}: normal=${normal.length}, delta=${normal.length - before}, focused=${focused.length}`);
  }
});

test("actual primary and fallback constructors carry rules and supplied feedback unchanged onto mocked wire", async t => {
  Object.assign(CFG, { groupWhitelist: [55100], friendWhitelist: [65100], botBlacklist: [] });
  saveApiProvider({ id: "source55-wire", model: "source55-synthetic", presetId: "custom-openai-chat",
    auth: "none", endpoint: "https://example.com/source55-wire", enabled: true,
    capabilities: ["text", "tools"] }, { root });
  const bodies = [];
  t.mock.method(globalThis, "fetch", async (url, init) => {
    assert.equal(String(url), "https://example.com/source55-wire");
    const body = JSON.parse(init.body);
    assert.equal(body.model, "source55-synthetic");
    bodies.push(body);
    return { ok: true, status: 200, json: async () => ({ choices: [{ message:
      { content: "Transport placeholder only.", reasoning_content: "SOURCE55_PRIVATE_REASONING" } }] }) };
  });
  const cases = [
    ["Synthetic advice: try uppercase FS.", "I tried uppercase FS; it still failed. What next?"],
    ["Synthetic prior error: password error; advice: uppercase FS.", "I tried FS; it still failed."],
    ["Synthetic advice: try uppercase FS.", "FS failed this time with: unsupported archive format."],
    ["Synthetic advice: restart once.", "After restarting, the display is still black and there is no error message."],
    ["Synthetic tool result: {\"status\":\"unavailable\"}", "What is known about the result?"],
  ];
  for (const imageTask of [false, true]) for (const [previous, current] of cases) {
    const history = [{ role: "assistant", content: previous }];
    const currentInput = buildCurrentInput("synthetic-speaker", current, "65100");
    const options = { ...evidence, imageTask, currentUserId: "65100", currentInput,
      allowTools: false, providerId: "source55-wire", personaCue: "synthetic-cue" };
    for (const call of [
      () => tryMiMoResult(current, "synthetic-speaker", history, [], "55100", true, "normal", options),
      () => tryDeepSeekResult(current, "synthetic-speaker", history, "55100", true, "normal", options),
    ]) {
      const result = await withChatRun({ surface: "group", groupId: "55100", userId: "65100" }, call);
      assert.equal(result.kind, "reply");
      assert.equal(result.text, "Transport placeholder only.");
      assert.doesNotMatch(JSON.stringify(result), /SOURCE55_PRIVATE_REASONING/);
      const body = bodies.at(-1);
      assert.equal(body.messages[0].content, buildChatSystemPrompt({ ...evidence, imageTask }));
      assert.equal(body.messages.at(-1).content, currentInput);
      assert.ok(body.messages.some(message => message.role === "assistant" && message.content === previous));
      assert.ok(!body.tools?.length);
    }
  }
  assert.equal(bodies.length, cases.length * 4);
});
