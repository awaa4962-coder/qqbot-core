import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { VERSION, VERSION_NAME, VERSION_NOTES_ZH, VERSION_NOTES_EN, buildVersionText, buildVersionQueryText } from "../bridge/version.mjs";
import { CHAT_TOOL_REGISTRY } from "../bridge/chat-tools/registry.mjs";

const readJson = relative => JSON.parse(fs.readFileSync(new globalThis.URL(relative, import.meta.url), "utf8"));

test("package, root lock and runtime command versions identify the same candidate", () => {
  const pkg = readJson("../package.json");
  const lock = readJson("../package-lock.json");
  assert.equal(VERSION, "2.0.2");
  assert.equal(VERSION, pkg.version);
  assert.equal(lock.version, pkg.version);
  assert.equal(lock.packages[""].version, pkg.version);
  assert.equal(VERSION_NAME, "sticker-reply-resilience");
  for (const language of ["zh", "en"]) assert.ok(buildVersionText(language).includes(VERSION));
});

test("2.0.0 bilingual notes describe the bounded registry and separate access from runtime state", () => {
  assert.equal(CHAT_TOOL_REGISTRY.length, 11);
  assert.equal(VERSION_NOTES_ZH.length, VERSION_NOTES_EN.length);
  assert.ok(Object.isFrozen(VERSION_NOTES_ZH));
  assert.ok(Object.isFrozen(VERSION_NOTES_EN));
  const zh = VERSION_NOTES_ZH.join("\n");
  const en = VERSION_NOTES_EN.join("\n");
  assert.match(zh, /单一模块化注册表定义11项有限工具/);
  assert.match(en, /single modular registry defines 11 limited tools/);
  assert.match(zh, /能力定义、运行状态与调用权限分别判断/);
  assert.match(en, /Capability definitions, runtime state and invocation permissions are distinct/);
  assert.match(zh, /默认关闭.*群白名单.*阶段白名单.*主动@.*私聊不开放/);
  assert.match(en, /off by default.*group and phase whitelists.*direct mention.*private chats are excluded/);
  assert.match(zh, /本人另发一次性确认命令.*模型不能代确认/);
  assert.match(en, /separate one-time owner confirmation command.*Models cannot confirm/);
});

test("2.0.0 notes retain Linux-only boundaries and deferred quality without claiming deployment", () => {
  const zh = buildVersionText("zh");
  const en = buildVersionText("en");
  assert.match(zh, /大写FS.*Windows继续冻结.*export-relationships.*预留未启用/);
  assert.match(en, /uppercase FS.*Windows stays frozen.*export-relationships.*reserved and disabled/);
  assert.match(zh, /9项非致命模型回答质量反例暂缓处理，未修复、未通过/);
  assert.match(en, /9 known nonfatal model-answer quality cases are deferred, not fixed or passed/);
  assert.match(zh, /原因未确认.*不宣称每个模型回答都通过/);
  assert.match(en, /causes are unconfirmed and not every model answer passes/);
  assert.match(zh, /实际部署和健康状态以运行检查为准.*版本号本身不证明服务在线/);
  assert.match(en, /Deployment and health require runtime checks.*version string alone does not prove service availability/);
  assert.doesNotMatch(zh, /2\.0\.0仅为源码候选，尚未发布或部署/);
  assert.doesNotMatch(en, /2\.0\.0 is a source candidate only, not released or deployed/);
});

test("the current candidate has a parseable latest changelog section", () => {
  const latest = buildVersionQueryText("更新 最近1版", "zh");
  assert.ok(latest.startsWith("v" + VERSION + " "));
  assert.ok(buildVersionQueryText("更新 v" + VERSION, "zh").startsWith("v" + VERSION + " "));
});
