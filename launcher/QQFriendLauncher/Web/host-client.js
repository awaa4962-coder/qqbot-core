(function createQQFriendHost(global) {
  "use strict";

  const desktopBridge = global.chrome && global.chrome.webview;
  const mode = desktopBridge && typeof desktopBridge.postMessage === "function" ? "desktop" : "browser";
  const pending = new Map();
  const listeners = new Set();
  const TOKEN_KEY = "qqfriend-admin-token";
  const BACKGROUND_MODE_KEY = "qqfriend-background-mode";
  let activeBackgroundUrl = "";

  function timeoutFor(action) {
    if (action === "startAll") return 12 * 60 * 1000;
    if (["runMemeWebUpdate", "researchMemeWeb"].includes(action)) return 3 * 60 * 1000;
    if (["syncStickers", "analyzeStickers"].includes(action)) return 230 * 1000;
    if (action === "health") return 90 * 1000;
    if (["restartBridge", "createBackup"].includes(action)) return 90 * 1000;
    return 30 * 1000;
  }

  function call(action, payload = {}) {
    return mode === "desktop" ? callDesktop(action, payload) : callBrowser(action, payload);
  }

  function callDesktop(action, payload) {
    const id = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    return new Promise((resolve, reject) => {
      const timer = global.setTimeout(() => {
        pending.delete(id);
        reject(new Error("操作等待时间过长，请查看日志或稍后重试。"));
      }, timeoutFor(action));

      pending.set(id, { resolve, reject, timer });
      try {
        desktopBridge.postMessage({ id, action, payload });
      } catch (error) {
        global.clearTimeout(timer);
        pending.delete(id);
        reject(error);
      }
    });
  }

  async function callBrowser(action, payload) {
    if (action === "ready") return browserRuntimeInfo();
    if (action === "refresh") return buildBrowserSnapshot();
    if (action === "refreshStatus") return apiRequest("/admin/status");
    if (action === "getCapabilities") return apiRequest("/admin/capabilities");
    if (action === "getLogs") return apiRequest("/admin/logs?tail=120");
    if (action === "getConfig" || action === "refreshConfig") return apiRequest("/admin/config");
    if (action === "getApiProviders") return apiRequest("/admin/api-providers");
    if (action === "getMemes") return apiRequest("/admin/memes");
    if (action === "getStickers") return apiRequest("/admin/stickers");
    if (action === "getBackground") return getBrowserBackground();
    if (action === "setBackground") return setBrowserBackground(payload);
    if (action === "chooseBackgroundImage") return chooseBrowserBackground();
    if (action === "saveConfig") return apiPost("/admin/config", payload);
    if (action === "manageApiProviders") return apiPost("/admin/api-providers", payload);
    if (action === "manageStickers") return apiPost("/admin/stickers", payload);
    if (isMemeAction(action)) return apiPost("/admin/memes", payload);
    if (action === "diagnose") return apiPost("/admin/diagnose/reply", payload);
    if (action === "createBackup") return apiPost("/admin/backups", { action: "create" });
    if (action === "health") return runBrowserHealthCheck();
    if (action === "openLogs") return { message: "日志已显示在控制台的日志页。" };
    if (["startAll", "restartBridge", "stopBridge", "stopAll"].includes(action)) {
      throw new Error("Linux 服务由 Docker Compose 或 systemd 管理，请在服务器终端执行服务操作。");
    }
    if (action === "openNativePage") {
      throw new Error("这是 Windows 桌面版入口；Linux 请使用左侧对应页面。");
    }
    throw new Error("浏览器控制台暂不支持此操作：" + action);
  }

  async function buildBrowserSnapshot() {
    const status = await apiRequest("/admin/status");
    const [config, logs] = await Promise.all([
      apiRequest("/admin/config", {}, false),
      apiRequest("/admin/logs?tail=80", {}, false),
    ]);
    return { launcher: browserRuntimeInfo(), status, config, logs };
  }

  async function runBrowserHealthCheck() {
    const [health, status] = await Promise.all([
      publicRequest("/health"),
      apiRequest("/admin/status"),
    ]);
    return {
      message: `健康检查完成\nBridge: ${health.status || "unknown"}\n运行: ${Math.round(Number(health.uptime || 0))} 秒`,
      health,
      snapshot: { status },
    };
  }

  function browserRuntimeInfo() {
    return {
      mode: "linux-browser",
      bridgeHealthUrl: "/health",
      consoleUrl: "/console/",
      serviceManager: "docker-or-systemd",
    };
  }

  function isMemeAction(action) {
    return [
      "saveMeme",
      "toggleMeme",
      "deleteMeme",
      "clearMemeCandidates",
      "runMemeWebUpdate",
      "researchMemeWeb",
      "rollbackMemeWebUpdate",
      "restoreMemeHistory",
    ].includes(action);
  }

  function apiPost(path, payload) {
    return apiRequest(path, { method: "POST", body: payload });
  }

  async function apiRequest(path, options = {}, allowPrompt = true) {
    const headers = { Accept: "application/json" };
    const token = readAdminToken();
    if (token) headers["X-QQFriend-Admin-Token"] = token;
    if (options.body !== undefined) headers["Content-Type"] = "application/json; charset=utf-8";

    const response = await global.fetch(path, {
      method: options.method || "GET",
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      cache: "no-store",
      credentials: "same-origin",
    });
    if (response.status === 403 && allowPrompt) {
      const entered = global.prompt("请输入 Linux 控制台管理令牌。令牌只保存在当前标签页。", "");
      if (entered && entered.trim()) {
        global.sessionStorage.setItem(TOKEN_KEY, entered.trim());
        return apiRequest(path, options, false);
      }
    }
    const payload = await readResponsePayload(response);
    if (!response.ok) {
      if (response.status === 403) global.sessionStorage.removeItem(TOKEN_KEY);
      throw new Error(payload.error || `管理接口返回 ${response.status}`);
    }
    return payload;
  }

  async function publicRequest(path) {
    const response = await global.fetch(path, { cache: "no-store", credentials: "same-origin" });
    const payload = await readResponsePayload(response);
    if (!response.ok) throw new Error(payload.error || `接口返回 ${response.status}`);
    return payload;
  }

  async function readResponsePayload(response) {
    const raw = await response.text();
    if (!raw) return {};
    try {
      return JSON.parse(raw);
    } catch {
      return { error: raw.slice(0, 240) };
    }
  }

  function readAdminToken() {
    try {
      return String(global.sessionStorage.getItem(TOKEN_KEY) || "").trim();
    } catch {
      return "";
    }
  }

  async function getBrowserBackground() {
    const backgroundMode = global.localStorage.getItem(BACKGROUND_MODE_KEY) || "built-in";
    if (backgroundMode !== "image") return { mode: "built-in", uri: "" };
    try {
      const blob = await readBackgroundBlob();
      if (!blob) return { mode: "built-in", uri: "" };
      if (activeBackgroundUrl) global.URL.revokeObjectURL(activeBackgroundUrl);
      activeBackgroundUrl = global.URL.createObjectURL(blob);
      return { mode: "image", uri: activeBackgroundUrl };
    } catch {
      return { mode: "built-in", uri: "" };
    }
  }

  async function setBrowserBackground(payload) {
    const selectedMode = String(payload && payload.mode || "built-in");
    if (selectedMode === "desktop") {
      throw new Error("浏览器不能直接读取 Linux 桌面壁纸，请选择一张图片。");
    }
    global.localStorage.setItem(BACKGROUND_MODE_KEY, "built-in");
    return { mode: "built-in", uri: "" };
  }

  async function chooseBrowserBackground() {
    const file = await chooseImageFile();
    if (!file) return getBrowserBackground();
    await writeBackgroundBlob(file);
    global.localStorage.setItem(BACKGROUND_MODE_KEY, "image");
    return getBrowserBackground();
  }

  function chooseImageFile() {
    return new Promise(resolve => {
      const input = global.document.createElement("input");
      input.type = "file";
      input.accept = "image/png,image/jpeg,image/webp,image/gif";
      let settled = false;
      const finish = file => {
        if (settled) return;
        settled = true;
        resolve(file || null);
      };
      input.addEventListener("change", () => finish(input.files && input.files[0]), { once: true });
      input.addEventListener("cancel", () => finish(null), { once: true });
      input.click();
    });
  }

  function openBackgroundDb() {
    return new Promise((resolve, reject) => {
      const request = global.indexedDB.open("qqfriend-console", 1);
      request.onupgradeneeded = () => request.result.createObjectStore("appearance");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error("背景存储不可用"));
    });
  }

  async function writeBackgroundBlob(blob) {
    const db = await openBackgroundDb();
    await new Promise((resolve, reject) => {
      const transaction = db.transaction("appearance", "readwrite");
      transaction.objectStore("appearance").put(blob, "background");
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error || new Error("背景保存失败"));
    });
    db.close();
  }

  async function readBackgroundBlob() {
    const db = await openBackgroundDb();
    const result = await new Promise((resolve, reject) => {
      const request = db.transaction("appearance", "readonly").objectStore("appearance").get("background");
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error || new Error("背景读取失败"));
    });
    db.close();
    return result;
  }

  function onEvent(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  function handleMessage(event) {
    const message = event.data || {};
    if (!message.id) {
      listeners.forEach(listener => listener(message));
      return;
    }

    const item = pending.get(message.id);
    if (!item) return;
    pending.delete(message.id);
    global.clearTimeout(item.timer);
    if (message.ok) item.resolve(message.data);
    else item.reject(new Error(message.error || "操作失败"));
  }

  if (mode === "desktop") desktopBridge.addEventListener("message", handleMessage);

  global.QQFriendHost = Object.freeze({ call, onEvent, timeoutFor, mode });
})(window);
