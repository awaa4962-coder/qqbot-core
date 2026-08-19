import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { clearTimeout, setTimeout } from 'node:timers';
import { URL } from 'node:url';
import vm from 'node:vm';

const hostClientPath = new URL('../launcher/QQFriendLauncher/Web/host-client.js', import.meta.url);
const indexPath = new URL('../launcher/QQFriendLauncher/Web/index.html', import.meta.url);
const appPath = new URL('../launcher/QQFriendLauncher/Web/app.js', import.meta.url);
const runtimeServicePath = new URL('../launcher/QQFriendLauncher/Services/LauncherRuntimeService.cs', import.meta.url);
const napCatClientPath = new URL('../launcher/QQFriendLauncher/Services/NapCatClient.cs', import.meta.url);
const launcherConfigPath = new URL('../launcher/QQFriendLauncher/Config/LauncherConfig.cs', import.meta.url);
const launcherFormPath = new URL('../launcher/QQFriendLauncher/App/LauncherForm.cs', import.meta.url);

async function createHostHarness() {
  const source = await readFile(hostClientPath, 'utf8');
  let posted = null;
  let messageHandler = null;
  const window = {
    chrome: {
      webview: {
        addEventListener(type, listener) {
          if (type === 'message') messageHandler = listener;
        },
        postMessage(message) {
          posted = message;
        },
      },
    },
    clearTimeout,
    setTimeout,
  };
  vm.runInNewContext(source, vm.createContext({ window }));
  return {
    emit(data) {
      messageHandler({ data });
    },
    host: window.QQFriendHost,
    posted() {
      return posted;
    },
  };
}

async function createBrowserHostHarness(fetchImpl, promptImpl = () => "") {
  const source = await readFile(hostClientPath, 'utf8');
  const session = new Map();
  const local = new Map();
  const window = {
    clearTimeout,
    setTimeout,
    fetch: fetchImpl,
    prompt: promptImpl,
    sessionStorage: storageFor(session),
    localStorage: storageFor(local),
  };
  vm.runInNewContext(source, vm.createContext({ window }));
  return { host: window.QQFriendHost, session };
}

function storageFor(values) {
  return {
    getItem(key) {
      return values.has(key) ? values.get(key) : null;
    },
    setItem(key, value) {
      values.set(key, String(value));
    },
    removeItem(key) {
      values.delete(key);
    },
  };
}

function jsonResponse(status, payload) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() {
      return JSON.stringify(payload);
    },
  };
}

test('launcher host client resolves matching WebView responses', async () => {
  const harness = await createHostHarness();
  const resultPromise = harness.host.call('refreshStatus', { source: 'test' });
  const request = harness.posted();

  assert.equal(request.action, 'refreshStatus');
  assert.deepEqual(request.payload, { source: 'test' });
  harness.emit({ id: request.id, ok: true, data: { status: 'ok' } });
  assert.deepEqual(await resultPromise, { status: 'ok' });
});

test('launcher host client rejects host errors at the caller', async () => {
  const harness = await createHostHarness();
  const resultPromise = harness.host.call('diagnose');
  const request = harness.posted();

  harness.emit({ id: request.id, ok: false, error: 'diagnose failed' });
  await assert.rejects(resultPromise, /diagnose failed/);
});

test('launcher host client forwards unsolicited snapshot events', async () => {
  const harness = await createHostHarness();
  let received = null;
  harness.host.onEvent((message) => {
    received = message;
  });

  harness.emit({ action: 'snapshot', ok: true, data: { status: { status: 'ok' } } });
  assert.equal(received.action, 'snapshot');
  assert.equal(received.data.status.status, 'ok');
});

test('launcher host client keeps long-running actions above normal timeout', async () => {
  const harness = await createHostHarness();
  assert.equal(harness.host.timeoutFor('runMemeWebUpdate'), 180_000);
  assert.equal(harness.host.timeoutFor('researchMemeWeb'), 180_000);
  assert.equal(harness.host.timeoutFor('restartBridge'), 90_000);
  assert.equal(harness.host.timeoutFor('refreshStatus'), 30_000);
});

test('browser host routes Linux status calls and keeps service control terminal-only', async () => {
  const requests = [];
  const harness = await createBrowserHostHarness(async (url, options) => {
    requests.push({ url, options });
    return jsonResponse(200, { status: 'ok' });
  });

  const ready = await harness.host.call('ready');
  const status = await harness.host.call('refreshStatus');
  assert.equal(harness.host.mode, 'browser');
  assert.equal(ready.mode, 'linux-browser');
  assert.equal(status.status, 'ok');
  assert.equal(requests[0].url, '/admin/status');
  await assert.rejects(harness.host.call('startAll'), /Docker Compose.*systemd/);
});

test('browser host prompts after 403 and keeps the admin token in session storage', async () => {
  const requests = [];
  const harness = await createBrowserHostHarness(async (url, options) => {
    requests.push({ url, options });
    return requests.length === 1
      ? jsonResponse(403, { error: 'forbidden' })
      : jsonResponse(200, { status: 'ok' });
  }, () => 'session-only-token');

  const status = await harness.host.call('refreshStatus');
  assert.equal(status.status, 'ok');
  assert.equal(requests.length, 2);
  assert.equal(requests[0].options.headers['X-QQFriend-Admin-Token'], undefined);
  assert.equal(requests[1].options.headers['X-QQFriend-Admin-Token'], 'session-only-token');
  assert.equal(harness.session.get('qqfriend-admin-token'), 'session-only-token');
});

test('launcher frontend separates daily work into focused views', async () => {
  const html = await readFile(indexPath, 'utf8');
  for (const view of ['overview', 'capabilities', 'api-center', 'services', 'configuration', 'memes', 'stickers', 'diagnostics', 'logs', 'maintenance']) {
    assert.match(html, new RegExp(`data-view-panel="${view}"`));
  }
  assert.match(html, /class="sidebar"/);
  assert.match(html, /data-list-editor-for="cfgGroupWhitelist"/);
  assert.match(html, /data-native-page="命令"/);
  assert.doesNotMatch(html, /class="hero /);
  assert.match(html, /id="diagnoseDetails"/);
  assert.match(html, /id="memeDirtyState"/);
  assert.match(html, /id="memeUpdateState"/);
  assert.match(html, /data-action="runMemeWebUpdate"/);
  assert.match(html, /data-action="researchMemeWeb"/);
  assert.match(html, /data-action="rollbackMemeWebUpdate"/);
  assert.match(html, /id="memeHistorySelect"/);
  assert.match(html, /id="memeSourceList"/);
  assert.match(html, /data-meme-lock="meaning"/);
  assert.doesNotMatch(html, /data-action="importChinaMemes"/);
  assert.match(html, /id="configDirtyState"/);
  assert.match(html, /id="capabilityList"/);
  assert.match(html, /id="apiProviderList"/);
  assert.match(html, /id="apiRouteList"/);
  assert.match(html, /id="apiReasoningPresets"/);
  assert.match(html, /data-reasoning-preset="economy"/);
  assert.match(html, /data-reasoning-preset="deep"/);
  assert.match(html, /仅发送结果/);
  assert.match(html, /支持推理/);
  assert.match(html, /id="stickerGrid"/);
  assert.match(html, /id="stickerCaptureStatus"/);
  assert.match(html, /data-capture-mode="auto"/);
  assert.match(html, /id="stickerFilter"/);
  assert.match(html, /<option value="sendable">/);
  assert.match(html, /id="removeCapturedStickerButton"/);
  assert.match(html, /Key 只写入本机，不会回显/);
  assert.match(html, /host-client\.js/);
  const app = await readFile(appPath, 'utf8');
  assert.match(app, /图片语境/);
  assert.match(app, /不存图片/);
  assert.match(app, /function renderCapabilities/);
  assert.match(app, /getCapabilities/);
  assert.match(app, /function renderApiProviders/);
  assert.match(app, /function applyGlobalReasoningPreset/);
  assert.match(app, /data-route-reasoning/);
  assert.match(app, /manageApiProviders/);
  assert.match(app, /manageStickers/);
  assert.match(app, /function renderStickerCaptureStatus/);
  assert.match(app, /setStickerCaptureMode/);
  assert.match(app, /removeCapturedSticker/);
  assert.match(app, /counts\.sendable/);
  assert.match(app, /\/admin\/stickers\/image/);
  assert.match(app, /data-lazy="true"/);
  assert.match(app, /IntersectionObserver/);
  assert.match(app, /加载中/);
  assert.match(app, /function bindStickerImageFallbacks/);
  assert.match(app, /entry\.source !== "group-capture"/);
  assert.match(app, /apiEditorMode = item\.id \? "edit" : "create"/);
  assert.match(app, /新增不会覆盖原实例/);
  assert.match(html, /id="apiSaveButton"/);
  assert.match(html, /保存修改/);
});

test('launcher confirms stop and keeps intentional stop state coherent', async () => {
  const html = await readFile(indexPath, 'utf8');
  const source = await readFile(appPath, 'utf8');

  assert.match(source, /action === "stopBridge"/);
  assert.match(source, /action === "stopAll"/);
  assert.match(source, /确定停止 Bridge 吗/);
  assert.match(html, /data-action="stopAll"/);
  assert.match(source, /function renderStoppedStatus/);
  assert.match(source, /bridgeIntentionallyStopped/);
  assert.match(source, /function syncRuntimeTransition/);
});

test('launcher runtime refuses duplicate NapCat and Bridge starts', async () => {
  const source = await readFile(runtimeServicePath, 'utf8');

  assert.match(source, /FindNapCatProcessIds/);
  assert.match(source, /等待 OneBot 就绪，不重复启动/);
  assert.match(source, /FindNodeEntrypointProcessIdsAsync/);
  assert.match(source, /\$_\.Name -eq 'node\.exe'/);
  assert.match(source, /IsBridgePortListening/);
  assert.match(source, /StopAllAsync/);
  assert.match(source, /\[IO\.Path\]::GetDirectoryName\(\$_\.ExecutablePath\) -eq \$runtime/);
  assert.match(source, /@\('NapCatWinBootMain\.exe', 'QQ\.exe'\)/);
  assert.match(source, /为避免重复启动，已取消本次操作/);
});

test('launcher starts official NapCat injection and rejects empty login responses', async () => {
  const config = await readFile(launcherConfigPath, 'utf8');
  const client = await readFile(napCatClientPath, 'utf8');
  const runtime = await readFile(runtimeServicePath, 'utf8');

  assert.match(config, /CreateNapCatStartInfo/);
  assert.match(config, /NAPCAT_MAIN_PATH/);
  assert.match(config, /autoLoginAccount/);
  assert.match(runtime, /CreateNapCatStartInfo/);
  assert.match(client, /TryGetProperty\("user_id"/);
  assert.match(client, /QQ 尚未登录/);
});

test('launcher local service checks bypass system proxy', async () => {
  const source = await readFile(launcherFormPath, 'utf8');
  const matches = source.match(/new HttpClientHandler \{ UseProxy = false \}/g) || [];

  assert.equal(matches.length, 2);
});
