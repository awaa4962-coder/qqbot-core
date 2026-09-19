import assert from "node:assert/strict";
import test from "node:test";

test("API page shows invalid configuration and recovery instead of an editable default form", async () => {
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  const nodes = new Map();
  const element = id => {
    if (!nodes.has(id)) nodes.set(id, { value: "", textContent: "", innerHTML: "", dataset: {},
      disabled: false, classList: { toggle() {} } });
    return nodes.get(id);
  };
  globalThis.window = { QQFriendHost: {} };
  globalThis.document = { getElementById: element, querySelectorAll: () => [] };
  try {
    const { renderApiProviders } = await import("../launcher/QQFriendLauncher/Web/pages/api.js");
    const invalid = { providers: [], routes: {}, tasks: [], configurationError: "API 配置无效；已停止模型调用", rollbackAvailable: true };
    renderApiProviders(invalid);
    assert.match(element("apiProviderList").innerHTML, /API 配置不可用/);
    assert.match(element("apiRouteOutput").textContent, /回滚/);
    assert.equal(element("apiSaveButton").disabled, true);
    assert.equal(element("apiGroupRoute").textContent, "配置不可用");
    renderApiProviders({ ...invalid, rollbackAvailable: false });
    assert.match(element("apiRouteOutput").textContent, /没有可回滚/);
    renderApiProviders({ providers: [], routes: {}, tasks: [], configurationError: null, revision: 2 });
    assert.equal(element("apiSaveButton").disabled, false);
    assert.match(element("apiRouteOutput").textContent, /配置版本 2/);
  } finally {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
  }
});
