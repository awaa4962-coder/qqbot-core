(function createQQFriendHost(global) {
  "use strict";

  const pending = new Map();
  const listeners = new Set();

  function timeoutFor(action) {
    if (action === "startAll") return 12 * 60 * 1000;
    if (["runMemeWebUpdate", "researchMemeWeb"].includes(action)) {
      return 3 * 60 * 1000;
    }
    if (["syncStickers", "analyzeStickers"].includes(action)) return 230 * 1000;
    if (action === "health") return 90 * 1000;
    if (["restartBridge", "createBackup"].includes(action)) return 90 * 1000;
    return 30 * 1000;
  }

  function call(action, payload = {}) {
    const id = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    return new Promise((resolve, reject) => {
      const bridge = global.chrome && global.chrome.webview;
      if (!bridge || typeof bridge.postMessage !== "function") {
        reject(new Error("桌面桥接尚未就绪，请重新打开控制台。"));
        return;
      }

      const timer = global.setTimeout(() => {
        pending.delete(id);
        reject(new Error("操作等待时间过长，请查看日志或稍后重试。"));
      }, timeoutFor(action));

      pending.set(id, { resolve, reject, timer });
      try {
        bridge.postMessage({ id, action, payload });
      } catch (error) {
        global.clearTimeout(timer);
        pending.delete(id);
        reject(error);
      }
    });
  }

  function onEvent(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  function handleMessage(event) {
    const message = event.data || {};
    if (!message.id) {
      listeners.forEach((listener) => listener(message));
      return;
    }

    const item = pending.get(message.id);
    if (!item) return;
    pending.delete(message.id);
    global.clearTimeout(item.timer);
    if (message.ok) item.resolve(message.data);
    else item.reject(new Error(message.error || "操作失败"));
  }

  if (global.chrome && global.chrome.webview) {
    global.chrome.webview.addEventListener("message", handleMessage);
  }

  global.QQFriendHost = Object.freeze({ call, onEvent, timeoutFor });
})(window);
