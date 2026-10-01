import test from "node:test";
import assert from "node:assert/strict";

test("capability page separates configured model state, permission and dependency health", async () => {
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  const nodes = new Map();
  const element = id => {
    if (!nodes.has(id)) nodes.set(id, { value: "", textContent: "", innerHTML: "" });
    return nodes.get(id);
  };
  globalThis.window = { QQFriendHost: {} };
  globalThis.document = { getElementById: id => ["agentToolsPanel", "agentDraftsPanel"].includes(id) ? null : element(id) };
  try {
    const { renderCapabilities, capabilityStateLabel } = await import("../launcher/QQFriendLauncher/Web/pages/capabilities.js");
    const state = { installed: true, enabled: true, permitted: null, health: "configured" };
    renderCapabilities({ categories: [], capabilities: [{ id: "chat.reply", name: "聊天", status: "available", statusLabel: "已配置", state }] });
    assert.match(element("capabilityList").innerHTML, /连通性未探测/);
    assert.match(element("capabilityList").innerHTML, /权限按实际会话判断/);
    assert.match(element("capabilityList").innerHTML, /已安装/);
    assert.match(capabilityStateLabel({ installed: false, enabled: false, permitted: false, health: "disabled" }), /未安装.*未启用.*当前会话受限/);
    assert.match(capabilityStateLabel({ enabled: true, permitted: false, health: "unknown" }), /当前会话受限.*检查中/);
    assert.match(capabilityStateLabel({ enabled: true, permitted: true, health: "ready" }), /依赖检查通过/);
  } finally {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
  }
});
