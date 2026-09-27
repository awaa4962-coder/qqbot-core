import assert from "node:assert/strict";
import test, { after } from "node:test";

const oldWindow = globalThis.window;
const oldDocument = globalThis.document;
const nodes = new Map();
const buttons = new Map();
const node = id => {
  if (!nodes.has(id)) nodes.set(id, { value: "", textContent: "", innerHTML: "", hidden: false, checked: false,
    classList: { toggle() {} }, querySelectorAll: () => [] });
  return nodes.get(id);
};
globalThis.window = { QQFriendHost: {}, addEventListener() {} };
globalThis.document = { getElementById: node, querySelector: node,
  querySelectorAll(selector) {
    if (!buttons.has(selector)) buttons.set(selector, [{ disabled: false, dataset: {}, classList: { toggle() {} } }]);
    return buttons.get(selector);
  } };
const { renderStickers } = await import("../launcher/QQFriendLauncher/Web/pages/stickers.js");
after(() => { globalThis.window = oldWindow; globalThis.document = oldDocument; });

test("unreadable catalogs show unknown instead of empty success and disable write actions", () => {
  renderStickers({ available: false, entries: [{ description: "PRIVATE_STALE_DESCRIPTION" }], counts: { total: 18 } });
  assert.equal(node("stickerNavCount").textContent, "?");
  assert.equal(node("stickerListCount").textContent, "未知");
  assert.equal(node("stickerDetailPanel").hidden, true);
  assert.match(node("stickerGrid").innerHTML, /读取失败/);
  assert.doesNotMatch(node("stickerGrid").innerHTML, /还没有同步|PRIVATE_STALE_DESCRIPTION/);
  for (const action of ["syncStickers", "saveSticker", "analyzeStickers", "simulateSticker"]) {
    assert.equal(buttons.get(`[data-action='${action}']`)[0].disabled, true);
  }
});

test("a recovered or legacy readable snapshot restores normal empty state and action availability", () => {
  renderStickers({ entries: [], settings: {}, counts: { total: 0, sendable: 0 }, stats: {} });
  assert.equal(node("stickerNavCount").textContent, "0");
  assert.equal(node("stickerListCount").textContent, "0 张");
  assert.match(node("stickerGrid").innerHTML, /还没有同步/);
  assert.equal(buttons.get("[data-action='syncStickers']")[0].disabled, false);
  assert.doesNotMatch(node("stickerStatus").textContent, /暂不可读/);
});

test("privacy cancellation is rendered as a readable status instead of an opaque code", () => {
  renderStickers({ available: true, entries: [], settings: {}, counts: {}, stats: {}, capture: { lastError: "privacy_changed" } });
  assert.match(node("stickerCaptureStatus").textContent, /资料已更新，旧任务已停止/);
  assert.doesNotMatch(node("stickerCaptureStatus").textContent, /privacy_changed/);
});
