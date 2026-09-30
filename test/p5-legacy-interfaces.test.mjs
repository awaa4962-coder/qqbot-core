import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { clearTimeout, setTimeout } from "node:timers";
import { fileURLToPath, pathToFileURL, URL } from "node:url";
import vm from "node:vm";
import test from "node:test";
import { MODULE_DEFINITIONS } from "../bridge/modules/manifest.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const require = createRequire(import.meta.url);
const { parse } = createRequire(require.resolve("eslint"))("espree");
const WEB = "launcher/QQFriendLauncher/Web/";
const DIRECTORIES = ["bridge", "scripts", "test", WEB];
const sourceFiles = DIRECTORIES.flatMap(directory => collectSources(path.join(ROOT, directory)));
sourceFiles.push(...fs.readdirSync(ROOT).filter(file => /\.(?:mjs|js)$/.test(file)).map(file => path.join(ROOT, file)));
const modules = new Map(sourceFiles.map(filename => [relative(filename), inspectModule(filename)]));
const packageJson = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
const runtimeCommands = Object.entries(packageJson.scripts).filter(([name]) => !/^(?:test|lint)(?::|$)/.test(name));
const runtimeRoots = [...new Set(runtimeCommands
  .map(([, command]) => command.match(/^node\s+(\S+\.mjs)(?:\s|$)/)?.[1]).filter(Boolean))];
const production = reachable(runtimeRoots);
const browserScripts = readBrowserScripts(readSource(WEB + "index.html"));
const browserRoots = browserScripts.map(script => script.filename);
const browser = reachable(browserRoots);

test("Node command roots are explicit and do not promote test consumers to production", () => {
  for (const [name, command] of runtimeCommands) {
    assert.match(command, /^node\s+\S+\.mjs(?:\s|$)/, "unclassified command root: " + name);
  }
  assert.ok(runtimeRoots.includes(packageJson.main));
  assert.equal(runtimeRoots.includes("scripts/run-tests.mjs"), false);
  for (const filename of production) {
    assert.equal(filename.startsWith("test/") || filename.startsWith(WEB), false, filename);
  }
});

test("browser roots come from index scripts, including the classic host and cache suffixes", () => {
  const scripts = readBrowserScripts(`
    <!-- <script src="./not-loaded.js"></script> -->
    <script src='./host-client.js?v=fixture#host'></script>
    <script type="module" src=./app.js?v=fixture></script>
    <script type="application/json">{"fixture":true}</script>
  `);
  assert.deepEqual(scripts, [
    { filename: WEB + "host-client.js", type: "classic" },
    { filename: WEB + "app.js", type: "module" },
  ]);
  for (const src of ["https://outside.invalid/code.js", "../outside.js"]) {
    assert.throws(() => readBrowserScripts(`<script src="${src}"></script>`), /outside console/);
  }
  assert.throws(() => readBrowserScripts("<script>window.fixture = true;</script>"), /inline script/);
  assert.throws(() => readBrowserScripts('<script src="./app.js">'), /unsupported script tag/);
  assert.throws(() => readBrowserScripts('<script type="text/ecmascript" src="./app.js"></script>'), /unclassified script type/);
});

test("AST dependency inspection follows aliases reexports and literal imports, not fixture strings", () => {
  const facts = inspectSource(path.join(ROOT, WEB, "fixture.js"), `
    import { renderMemes as renderArchive } from "./pages/memes.js?v=fixture";
    import * as actions from "./ui/actions.js#fixture";
    export * from "./ui/state.js";
    const literal = import("./ui/tasks.js?v=fixture#tasks");
    const computed = import("./" + name);
    const fixture = 'import("./not-executed.js")';
  `);
  assert.deepEqual([...facts.dependencies].sort(), ["pages/memes.js", "ui/actions.js", "ui/state.js", "ui/tasks.js"]
    .map(filename => WEB + filename).sort());
  assert.equal(facts.computedImports, 1);
});

test("every browser index root reaches only served console sources without computed imports", () => {
  assert.deepEqual(browserScripts[0], { filename: WEB + "host-client.js", type: "classic" });
  assert.equal(new Set(browserRoots).size, browserRoots.length);
  for (const filename of ["app.js", "api-usage.js", "diagnostics.js", "conversation-summaries.js", "summaries.js"]) {
    assert.ok(browserRoots.includes(WEB + filename), filename);
  }
  const served = consoleScriptAssets();
  for (const filename of browser) {
    assert.ok(filename.startsWith(WEB), filename);
    assert.ok(served.has(filename.slice(WEB.length)), "unserved browser source: " + filename);
    assert.equal(modules.get(filename).computedImports, 0, filename);
    for (const specifier of modules.get(filename).specifiers) assert.ok(specifier.startsWith("."), "non-local browser import: " + specifier);
    assert.equal(production.has(filename), false, filename);
  }
  for (const filename of ["ui/state.js", "ui/actions.js", "ui/tasks.js", "pages/memes.js", "pages/stickers.js"]) {
    assert.ok(browser.has(WEB + filename), filename);
  }
  assert.ok(modules.get(WEB + "ui/state.js").identifiers.has("QQFriendHost"));
});

test("unused sticker declaration is removed without replacing the shared authority", () => {
  assert.equal(fs.existsSync(path.join(ROOT, "bridge/features/stickers/manifest.mjs")), false);
  const declarations = MODULE_DEFINITIONS.filter(module => module.id === "stickers");
  assert.equal(declarations.length, 1);
  assert.equal(declarations[0].enabled, true);
  assert.ok(declarations[0].entrypoints.includes("bridge/features/stickers/"));
  assert.ok(declarations[0].entrypoints.includes("bridge/admin-api/sticker-manager.mjs"));
  for (const [filename, facts] of modules) {
    assert.equal(facts.identifiers.has("STICKER_MODULE_MANIFEST"), false, filename);
    assert.equal(facts.dependencies.has("bridge/features/stickers/manifest.mjs"), false, filename);
  }
});

test("unused fixed-endpoint MiMo chat adapter stays removed while tested adapters remain", () => {
  for (const [filename, facts] of modules) assert.equal(facts.identifiers.has("mimoChat"), false, filename);
  assert.ok(modules.get("bridge/clients/providers/mimo.mjs").exports.has("mimoVision"));
  assert.ok(modules.get("bridge/clients/providers/deepseek.mjs").exports.has("deepseekChat"));
  assert.ok(modules.get("bridge/clients/llm-client.mjs").exports.has("llmCall"));
  assert.ok(modules.get("bridge/clients/llm-client.mjs").exports.has("llmChat"));
});

test("runtime commands use current model dispatch and shared auth, not legacy provider adapters", () => {
  assert.ok(runtimeRoots.includes("napcat_bridge.mjs"));
  assert.ok(runtimeRoots.includes("daily_summary.mjs"));
  assert.ok(runtimeRoots.includes("scripts/send-summary-for-date.mjs"));
  for (const filename of ["bridge/model-router.mjs", "bridge/api-providers/gateway.mjs", "bridge/clients/auth.mjs",
    "bridge/features/stickers/index.mjs", "bridge/jm-provider.mjs", "bridge/memory-profile.mjs"]) {
    assert.ok(production.has(filename), filename);
  }
  for (const filename of ["bridge/clients/llm-client.mjs", "bridge/clients/providers/mimo.mjs", "bridge/clients/providers/deepseek.mjs"]) {
    assert.equal(production.has(filename), false, filename);
  }
  for (const filename of production) assert.equal(modules.get(filename).computedImports, 0, filename);
});

test("all runtime command graphs keep retired meme implementations outside production", () => {
  const legacy = [...production].filter(filename => filename.startsWith("bridge/knowledge/memes/")).sort();
  assert.deepEqual(legacy, ["bridge/knowledge/memes/archive.mjs", "bridge/knowledge/memes/image-context.mjs"]);
});

test("stable compatibility barrels remain thin reexports rather than duplicate implementations", () => {
  const barrels = {
    "bridge/admin-commands.mjs": "bridge/commands/index.mjs",
    "bridge/context.mjs": "bridge/context/messages.mjs",
    "bridge/group-summary.mjs": "bridge/group-summary/index.mjs",
    "bridge/jm-provider.mjs": "bridge/jm/commands.mjs",
    "bridge/memory-profile.mjs": "bridge/memory-profile/store.mjs",
    "bridge/mentions/index.mjs": "bridge/mentions/parse.mjs",
    "bridge/knowledge/memes/index.mjs": "bridge/knowledge/memes/store.mjs",
  };
  for (const [filename, target] of Object.entries(barrels)) {
    const facts = modules.get(filename);
    assert.ok(facts.dependencies.has(target), filename);
    assert.ok(facts.body.every(node => ["ExportNamedDeclaration", "ExportAllDeclaration"].includes(node.type) && node.source), filename);
  }
});

test("historical safety and reserved-interface consumers are not mistaken for dead files", () => {
  const compatibility = reachable(["test/llm-client.test.mjs", "test/meme-updater.test.mjs", "test/meme-governance.test.mjs",
    "test/meme-knowledge.test.mjs", "test/feature-fetch-boundaries.test.mjs", "test/relationship-export.test.mjs"]);
  for (const filename of ["bridge/clients/providers/mimo.mjs", "bridge/clients/providers/deepseek.mjs",
    "bridge/knowledge/memes/trend-updater.mjs", "bridge/knowledge/memes/evidence-search.mjs", "bridge/knowledge/memes/evidence-verifier.mjs",
    "bridge/knowledge/memes/sources/daily-hot.mjs", "bridge/knowledge/memes/sources/rsshub.mjs",
    "bridge/context-builder.mjs", "bridge/style-router.mjs", "bridge/relationship-export.mjs"]) {
    assert.ok(compatibility.has(filename), filename);
    assert.equal(production.has(filename), false, filename);
  }
});

test("remaining facade inventory matches direct Node and test consumers separately", () => {
  const inventory = {
    "bridge/admin-commands.mjs": {
      node: ["bridge/admin-api/diagnose-reply.mjs", "bridge/reply-private.mjs"],
      tests: ["admin-commands", "api-usage", "group-summary-command", "version-command"],
    },
    "bridge/context.mjs": { node: [], tests: ["context-modular", "core"] },
    "bridge/group-summary.mjs": { node: ["scripts/send-summary-for-date.mjs"], tests: ["group-summary-command", "group-summary"] },
    "bridge/jm-provider.mjs": {
      node: ["bridge/admin-api/diagnose-reply.mjs", "bridge/admin-api/runtime-status.mjs", "bridge/commands/action-dispatcher.mjs",
        "bridge/reply-private.mjs", "bridge/runtime-maintenance.mjs", "bridge/startup.mjs"],
      tests: ["jm-provider"],
    },
    "bridge/memory-profile.mjs": {
      node: ["bridge/commands/modules/admin.mjs", "bridge/commands/modules/relationship.mjs", "bridge/context-retriever.mjs",
        "bridge/reply-group.mjs", "bridge/startup.mjs", "bridge/user-preferences.mjs"],
      tests: ["chat-outcome-integration", "context-retriever", "memory-evidence-integration", "memory-privacy",
        "memory-profile", "mentions", "quote-context"],
    },
  };
  const record = readSource("deploy/linux/LEGACY-INTERFACES.md");
  for (const [filename, consumers] of Object.entries(inventory)) {
    assert.deepEqual(directConsumers(filename).filter(consumer => production.has(consumer)), consumers.node.sort(), filename);
    const tests = consumers.tests.map(name => `test/${name}.test.mjs`).sort();
    assert.deepEqual(directConsumers(filename).filter(consumer => consumer.startsWith("test/")), tests, filename);
    for (const item of [filename, ...consumers.node, ...tests]) assert.ok(record.includes("`" + item + "`"), "undocumented consumer: " + item);
  }
});

test("boolean and text result adapters remain single projections of the current authority", () => {
  const adapters = [
    ["bridge/reply-handlers.mjs", "handleExplicitLinkPreviewCommand", "executeExplicitLinkPreviewCommand", "handled"],
    ["bridge/features/wordcloud/index.mjs", "handleWordcloudCommand", "executeWordcloudCommand", "handled"],
    ["bridge/group-summary/providers.mjs", "generateGroupSummary", "generateGroupSummaryResult", "text"],
    ["bridge/model-mimo.mjs", "tryMiMo", "tryMiMoResult", "text"],
    ["bridge/model-ds.mjs", "tryDeepSeek", "tryDeepSeekResult", "text"],
  ];
  for (const [filename, name, target, field] of adapters) {
    const declaration = modules.get(filename).body.find(node => node.declaration?.id?.name === name)?.declaration;
    assert.ok(declaration, name);
    assert.equal(declaration.body.body.length, 1, name);
    const statement = declaration.body.body[0];
    assert.equal(statement.type, "ReturnStatement", name);
    assert.equal(statement.argument.type, "MemberExpression", name);
    assert.equal(statement.argument.property.name, field, name);
    assert.equal(statement.argument.object.type, "AwaitExpression", name);
    assert.equal(statement.argument.object.argument.callee.name, target, name);
  }
  assert.ok(modules.get("bridge/clients/llm-client.mjs").dependencies.has("bridge/api-providers/transport.mjs"));
  assert.ok(modules.get("bridge/clients/llm-client.mjs").dependencies.has("bridge/clients/auth.mjs"));
});

test("browser direct compatibility routes remain callable while retired meme writes make no request", async () => {
  const requests = [];
  const { host } = hostHarness(async (url, options) => {
    requests.push({ url, method: options.method, body: options.body && JSON.parse(options.body) });
    return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, fixture: true }) };
  });
  for (const [action, url] of [["getMemes", "/admin/memes"], ["getStickers", "/admin/stickers"], ["getReplay", "/admin/diagnose/replay"]]) {
    assert.equal((await host.call(action)).fixture, true);
    assert.deepEqual(requests.at(-1), { url, method: "GET", body: undefined });
  }
  for (const [action, url, payload] of [
    ["manageStickers", "/admin/stickers", { action: "capabilities" }],
    ["replayAction", "/admin/diagnose/replay", { action: "check" }],
    ["startTask", "/admin/tasks", { module: "stickers", payload: { action: "capabilities" } }],
  ]) {
    await host.call(action, payload);
    assert.deepEqual(requests.at(-1), { url, method: "POST", body: payload });
  }
  const before = requests.length;
  for (const action of ["saveMeme", "toggleMeme", "deleteMeme", "clearMemeCandidates", "runMemeWebUpdate",
    "researchMemeWeb", "rollbackMemeWebUpdate", "restoreMemeHistory"]) {
    await assert.rejects(host.call(action, { action: "research-web", query: "synthetic" }), /已停用/);
  }
  for (const action of ["startAll", "restartBridge", "stopBridge", "stopAll", "openNativePage"]) {
    await assert.rejects(host.call(action), /Linux|Windows/);
  }
  assert.equal(requests.length, before);
});

test("frozen Windows host actions retain a separate desktop message consumer", async () => {
  let posted;
  let receive;
  const { host } = hostHarness(() => assert.fail("desktop calls must not use browser HTTP"), {
    addEventListener(type, listener) { if (type === "message") receive = listener; },
    postMessage(message) { posted = message; },
  });
  assert.equal(host.mode, "desktop");
  const form = readSource("launcher/QQFriendLauncher/App/LauncherForm.Home.cs");
  const client = readSource("launcher/QQFriendLauncher/Services/BridgeAdminClient.cs");
  for (const action of ["getMemes", "saveMeme", "runMemeWebUpdate", "manageStickers", "diagnose"]) {
    assert.ok(form.includes('"' + action + '" =>'), action);
    const result = host.call(action, { fixture: true });
    assert.equal(posted.action, action);
    assert.equal(posted.payload.fixture, true);
    receive({ data: { id: posted.id, ok: true, data: { fixture: true } } });
    assert.equal((await result).fixture, true);
  }
  for (const endpoint of ["/admin/memes", "/admin/stickers", "/admin/diagnose/reply"]) assert.ok(client.includes('"' + endpoint + '"'), endpoint);
});

function collectSources(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    if (entry.isSymbolicLink() || /^(?:outputs|\.qqfriend|backups|logs|node_modules|bin|obj|publish-.*)$/i.test(entry.name)) return [];
    const filename = path.join(directory, entry.name);
    return entry.isDirectory() ? collectSources(filename) : /\.(?:mjs|js)$/.test(entry.name) ? [filename] : [];
  });
}

function relative(filename) {
  return path.relative(ROOT, filename).replaceAll("\\", "/");
}

function inspectModule(filename) {
  return inspectSource(filename, fs.readFileSync(filename, "utf8"));
}

function inspectSource(filename, sourceText) {
  const ast = parse(sourceText, { ecmaVersion: "latest", sourceType: "module" });
  const facts = { body: ast.body, dependencies: new Set(), specifiers: new Set(), identifiers: new Set(), exports: new Set(), computedImports: 0 };
  const pending = [ast];
  while (pending.length) {
    const node = pending.pop();
    if (node.type === "Identifier") facts.identifiers.add(node.name);
    if (node.type === "ExportNamedDeclaration") {
      if (node.declaration?.id) facts.exports.add(node.declaration.id.name);
      for (const specifier of node.specifiers) facts.exports.add(specifier.exported.name);
    }
    const source = ["ImportDeclaration", "ExportNamedDeclaration", "ExportAllDeclaration", "ImportExpression"].includes(node.type) ? node.source : null;
    if (source?.type === "Literal" && typeof source.value === "string") {
      facts.specifiers.add(source.value);
      if (source.value.startsWith(".")) facts.dependencies.add(relative(fileURLToPath(new URL(source.value, pathToFileURL(filename)))));
    } else if (node.type === "ImportExpression") facts.computedImports++;
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) pending.push(...value.filter(item => item && typeof item === "object"));
      else if (value && typeof value === "object") pending.push(value);
    }
  }
  return facts;
}

function readSource(filename) {
  return fs.readFileSync(path.join(ROOT, filename), "utf8");
}

function directConsumers(filename) {
  return [...modules].filter(([, facts]) => facts.dependencies.has(filename)).map(([consumer]) => consumer).sort();
}

function readBrowserScripts(html) {
  const scripts = [];
  const source = html.replace(/<!--[\s\S]*?-->/g, "");
  const scriptPattern = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
  assert.doesNotMatch(source.replace(scriptPattern, ""), /<script\b/i, "unsupported script tag");
  // This repository uses external script tags only; fail closed on executable inline/new remote roots.
  for (const match of source.matchAll(scriptPattern)) {
    const attributes = new Map([...match[1].matchAll(/([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'<>`=]+)))?/g)]
      .map(attribute => [attribute[1].toLowerCase(), attribute[2] ?? attribute[3] ?? attribute[4] ?? ""]));
    const type = (attributes.get("type") || "").toLowerCase();
    if (type === "application/json") continue;
    assert.ok(["", "module", "text/javascript", "application/javascript"].includes(type), "unclassified script type");
    assert.ok(attributes.get("src") && !match[2].trim(), "unsupported executable inline script");
    const url = new URL(attributes.get("src"), "https://qqfriend.invalid/console/index.html");
    assert.ok(url.origin === "https://qqfriend.invalid" && url.pathname.startsWith("/console/"), "script outside console");
    assert.ok(url.pathname.endsWith(".js"), "unsupported browser script root");
    scripts.push({ filename: WEB + url.pathname.slice("/console/".length), type: type === "module" ? "module" : "classic" });
  }
  return scripts;
}

function consoleScriptAssets() {
  const declarations = modules.get("bridge/web-console.mjs").body.filter(node => node.type === "VariableDeclaration")
    .flatMap(node => node.declarations);
  const assets = declarations.find(node => node.id.name === "ASSETS")?.init;
  const moduleAssets = declarations.find(node => node.id.name === "MODULE_ASSETS")?.init;
  assert.equal(assets?.callee.name, "Map");
  assert.equal(moduleAssets?.type, "ArrayExpression");
  return new Set([
    ...assets.arguments[0].elements.map(node => node.elements[1].elements[0].value),
    ...moduleAssets.elements.map(node => node.value),
  ].filter(filename => filename.endsWith(".js")));
}

function hostHarness(fetchImpl, desktop) {
  const window = { fetch: fetchImpl, clearTimeout, setTimeout,
    AbortController: globalThis.AbortController,
    sessionStorage: { getItem: () => null },
    ...(desktop ? { chrome: { webview: desktop } } : {}),
  };
  vm.runInNewContext(readSource(WEB + "host-client.js"), { window });
  return { host: window.QQFriendHost };
}

function reachable(roots) {
  const visited = new Set();
  const pending = [...roots];
  while (pending.length) {
    const filename = pending.pop();
    if (visited.has(filename)) continue;
    const facts = modules.get(filename);
    assert.ok(facts, "missing source dependency: " + filename);
    visited.add(filename);
    pending.push(...facts.dependencies);
  }
  return visited;
}
