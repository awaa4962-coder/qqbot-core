import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, URL } from "node:url";
import test from "node:test";
import { MODULE_DEFINITIONS } from "../bridge/modules/manifest.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const require = createRequire(import.meta.url);
const { parse } = createRequire(require.resolve("eslint"))("espree");
const DIRECTORIES = ["bridge", "scripts", "test", "launcher/QQFriendLauncher/Web"];
const sourceFiles = DIRECTORIES.flatMap(directory => collectSources(path.join(ROOT, directory)));
sourceFiles.push(...fs.readdirSync(ROOT).filter(file => /\.(?:mjs|js)$/.test(file)).map(file => path.join(ROOT, file)));
const modules = new Map(sourceFiles.map(filename => [relative(filename), inspectModule(filename)]));
const packageJson = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
const runtimeRoots = [...new Set(Object.entries(packageJson.scripts)
  .filter(([name]) => name !== "test" && name !== "lint")
  .map(([, command]) => command.match(/^node\s+(\S+\.mjs)(?:\s|$)/)?.[1]).filter(Boolean))];
const production = reachable(runtimeRoots);

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

function collectSources(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const filename = path.join(directory, entry.name);
    return entry.isDirectory() ? collectSources(filename) : /\.(?:mjs|js)$/.test(entry.name) ? [filename] : [];
  });
}

function relative(filename) {
  return path.relative(ROOT, filename).replaceAll("\\", "/");
}

function inspectModule(filename) {
  const ast = parse(fs.readFileSync(filename, "utf8"), { ecmaVersion: "latest", sourceType: "module" });
  const facts = { body: ast.body, dependencies: new Set(), identifiers: new Set(), exports: new Set(), computedImports: 0 };
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
      if (source.value.startsWith(".")) facts.dependencies.add(relative(path.resolve(path.dirname(filename), source.value)));
    } else if (node.type === "ImportExpression") facts.computedImports++;
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) pending.push(...value.filter(item => item && typeof item === "object"));
      else if (value && typeof value === "object") pending.push(value);
    }
  }
  return facts;
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
