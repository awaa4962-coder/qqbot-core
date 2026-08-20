import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CONFIG_URL = pathToFileURL(path.join(ROOT, "bridge", "config.mjs")).href;

test("missing feature lists inherit the main group whitelist", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "qqfriend-config-missing-"));
  fs.writeFileSync(path.join(root, ".env_groups"), "123456\n", "utf8");
  try {
    const value = await readConfig(root);
    assert.deepEqual(value.summary, [123456]);
    assert.deepEqual(value.resource, [123456]);
    assert.deepEqual(value.feature, [123456]);
    assert.deepEqual(value.sticker, [123456]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("present but empty feature lists stay disabled", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "qqfriend-config-empty-"));
  fs.writeFileSync(path.join(root, ".env_groups"), "123456\n", "utf8");
  for (const file of [
    ".env_summary_groups",
    ".env_resource_groups",
    ".env_feature_groups",
    ".env_sticker_groups",
  ]) {
    fs.writeFileSync(path.join(root, file), "", "utf8");
  }
  try {
    const value = await readConfig(root);
    assert.deepEqual(value.summary, []);
    assert.deepEqual(value.resource, []);
    assert.deepEqual(value.feature, []);
    assert.deepEqual(value.sticker, []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

async function readConfig(configRoot) {
  const source = [
    `const { CFG } = await import(${JSON.stringify(CONFIG_URL)});`,
    "process.stdout.write(JSON.stringify({",
    "summary: CFG.summaryGroupWhitelist,",
    "resource: CFG.resourceGroupWhitelist,",
    "feature: CFG.featureGroupWhitelist,",
    "sticker: CFG.stickerGroupWhitelist,",
    "}));",
  ].join("\n");
  const env = { ...process.env, NODE_ENV: "test", QQBOT_CONFIG_ROOT: configRoot };
  for (const name of [
    "QQBOT_GROUPS",
    "QQBOT_SUMMARY_GROUPS",
    "QQBOT_RESOURCE_GROUPS",
    "QQBOT_FEATURE_GROUPS",
    "QQBOT_STICKER_GROUPS",
  ]) delete env[name];
  const { stdout } = await execFileAsync(process.execPath, ["--input-type=module", "--eval", source], {
    cwd: ROOT,
    env,
  });
  return JSON.parse(stdout);
}
