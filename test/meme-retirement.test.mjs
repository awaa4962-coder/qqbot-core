import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, URL } from "node:url";
import test from "node:test";
import { readMemeArchive } from "../bridge/knowledge/memes/archive.mjs";
import { buildCapabilityCatalog, buildCapabilityHelpText } from "../bridge/capabilities/catalog.mjs";
import { adminHelpLines, helpLinesForPage } from "../bridge/commands/manifest.mjs";
import { buildRuntimeStatus } from "../bridge/admin-api/runtime-status.mjs";
import { buildReplyContextPacket } from "../bridge/context/index.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
function fixture(value) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qqfriend-meme-retirement-"));
  const filename = path.join(dir, "memes.json");
  if (value !== undefined) fs.writeFileSync(filename, typeof value === "string" ? value : JSON.stringify(value));
  return filename;
}

test("missing archive stays missing instead of loading builtin seeds", () => {
  const filename = fixture();
  const snapshot = readMemeArchive({ filename });
  assert.equal(snapshot.available, false);
  assert.equal(snapshot.readError, false);
  assert.deepEqual(snapshot.entries, []);
  assert.equal(fs.existsSync(filename), false);
});

test("archive reads preserve exact data bytes and modification time", () => {
  const filename = fixture({ version: 3, mode: "steady", entries: [{ name: "旧词", meaning: "人工整理" }] });
  const before = fs.readFileSync(filename);
  const modified = fs.statSync(filename).mtimeMs;
  const snapshot = readMemeArchive({ filename });
  assert.equal(snapshot.readonly, true);
  assert.equal(snapshot.mode, "off");
  assert.equal(snapshot.entries[0].meaning, "人工整理");
  assert.deepEqual(fs.readFileSync(filename), before);
  assert.equal(fs.statSync(filename).mtimeMs, modified);
});

test("corrupt or unknown archive shapes fail visibly without replacing the file", () => {
  for (const content of ["{broken", "null", '{"entries":{}}']) {
    const filename = fixture(content);
    const result = readMemeArchive({ filename });
    assert.equal(result.readError, true);
    assert.equal(result.available, false);
    assert.equal(fs.readFileSync(filename, "utf8"), content);
    assert.equal(JSON.stringify(result).includes(filename), false);
  }
});

test("archive projection omits raw evidence identifiers and redacts credentials", () => {
  const fakeCredential = "sk-" + "syntheticcredentialonly";
  const filename = fixture({ entries: [{ name: "旧词", meaning: "api_key=synthetic-value", usage: fakeCredential,
    rawText: "private-raw", userHashes: ["private-hash"], scope: { groupIds: ["55555555"] },
    sources: [{ snippet: "private-snippet", url: "https://example.com/?token=private-url" }],
    aliases: ["alias"], examples: ["password=hidden-pass"] }], stats: { groupIds: ["55555555"] } });
  const snapshot = readMemeArchive({ filename });
  const serialized = JSON.stringify(snapshot);
  for (const value of ["synthetic-value", fakeCredential, "private-raw", "private-hash", "private-snippet", "private-url", "55555555", "hidden-pass"]) {
    assert.equal(serialized.includes(value), false, value);
  }
  assert.equal(snapshot.entries[0].groupCount, 1);
  assert.equal(snapshot.entries[0].sourceCount, 1);
});

test("archive input size is bounded without modifying an oversized file", () => {
  const filename = fixture(" ".repeat(8 * 1024 * 1024 + 1));
  assert.equal(readMemeArchive({ filename }).readError, true);
  assert.equal(fs.statSync(filename).size, 8 * 1024 * 1024 + 1);
});

test("archive refuses file symlinks", t => {
  const filename = fixture({ entries: [] });
  const link = filename + ".link";
  try { fs.symlinkSync(filename, link, "file"); }
  catch (error) { if (["EPERM", "EACCES"].includes(error.code)) { t.skip("file symlink permission unavailable"); return; } throw error; }
  assert.equal(readMemeArchive({ filename: link }).readError, true);
});

test("capability help retires the text library while retaining stickers and JM", () => {
  const catalog = buildCapabilityCatalog({ surface: "console" });
  assert.equal(catalog.capabilities.some(item => item.id === "memes.knowledge"), false);
  assert.ok(catalog.capabilities.some(item => item.id === "memes.stickers"));
  assert.ok(catalog.capabilities.some(item => item.id === "resources.jm"));
  assert.match(buildCapabilityHelpText("梗库"), /已停用/);
  assert.doesNotMatch(helpLinesForPage(2).join("\n"), /梗库/);
  assert.doesNotMatch(adminHelpLines("base").join("\n"), /梗库/);
});

test("runtime status never advertises an enabled meme updater", () => {
  const state = buildRuntimeStatus().modules.memeKnowledge;
  assert.equal(state.enabled, false);
  assert.equal(state.retired, true);
  assert.equal(state.mode, "off");
  assert.equal(state.autoUpdate, false);
});

test("active and passive context builders do not inject old term definitions", () => {
  for (const isPassiveInterjection of [false, true]) {
    const packet = buildReplyContextPacket({ uid: "synthetic", groupId: "synthetic", userMsg: "哈基米启动",
      userName: "样例", isPassiveInterjection, mode: isPassiveInterjection ? "interjection" : "group-at" });
    assert.equal(JSON.stringify(packet.messages).includes("梗库语境提示"), false);
  }
});

test("production entry graphs import only archive and shared image utilities from legacy meme directory", () => {
  const visited = new Set();
  const queue = ["napcat_bridge.mjs", "daily_summary.mjs", "scripts/audit-meme-matches.mjs"].map(file => path.join(ROOT, file));
  while (queue.length) {
    const file = queue.pop();
    if (visited.has(file)) continue;
    visited.add(file);
    const source = fs.readFileSync(file, "utf8");
    for (const match of source.matchAll(/(?:\bfrom\s*|\bimport\s*(?:\(\s*)?)["'](\.[^"']+)["']/g)) {
      const dependency = path.resolve(path.dirname(file), match[1]);
      if (dependency.endsWith(".mjs") && fs.existsSync(dependency)) queue.push(dependency);
    }
  }
  const related = [...visited].map(file => path.relative(ROOT, file).replaceAll("\\", "/"))
    .filter(file => file.startsWith("bridge/knowledge/memes/"));
  assert.ok(related.includes("bridge/knowledge/memes/archive.mjs"));
  assert.ok(related.includes("bridge/knowledge/memes/image-context.mjs"));
  assert.ok(related.every(file => ["bridge/knowledge/memes/archive.mjs", "bridge/knowledge/memes/image-context.mjs"].includes(file)), related.join("\n"));
});
