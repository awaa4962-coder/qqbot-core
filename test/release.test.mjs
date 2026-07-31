import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  assertPortableZipEntries,
  buildManifest,
  collectReleaseFiles,
  isForbiddenPath,
  sha256File,
} from "../scripts/release.mjs";

function makeTempProject() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "qqfriend-release-"));
  const files = {
    "bridge/admin-commands.mjs": "export const ok = true;\n",
    "test/core.test.mjs": "import assert from 'node:assert/strict';\nassert.ok(true);\n",
    "scripts/runtime-check.mjs": "console.log('ok');\n",
    ".github/workflows/ci.yml": "name: ci\n",
    "napcat_bridge.mjs": "import './bridge/admin-commands.mjs';\n",
    "start_bridge.bat": "@echo off\n",
    "package.json": JSON.stringify({ name: "qqfriend", version: "1.2.1-test" }),
    "package-lock.json": "{}\n",
    "eslint.config.mjs": "export default [];\n",
    ".env.example": "QQBOT_NAMES=QQFriend,Yexing\n",
    "README.md": "# readme\n",
    "CHANGELOG.md": "# changelog\n",
    "WORKFLOW.md": "# workflow\n",
    "TOOLS.md": "# tools\n",
    "HEARTBEAT.md": "# heartbeat\n",
    "daily_summary.mjs": "console.log('summary');\n",
    ".env_ds": "real-key\n",
    ".env_admins": "1000000010\n",
    ".qqfriend/index.json": "{\"safe\":true}\n",
    ".qqfriend/memes.json": "{\"contexts\":[\"private runtime data\"]}\n",
    ".qqfriend/image-memes.json": "{\"entries\":[{\"description\":\"runtime\"}]}\n",
    ".qqfriend/stickers/catalog.json": "{\"entries\":[{\"key\":\"runtime-send-key\"}]}\n",
    "node_modules/pkg/index.js": "bad\n",
    "notes.docx": "bad\n",
  };

  for (const [file, content] of Object.entries(files)) {
    const absolute = path.join(root, file);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, content, "utf8");
  }
  return root;
}

describe("release forbidden paths", () => {
  it("detects private config and runtime data", () => {
    assert.equal(isForbiddenPath(".env_admins"), true);
    assert.equal(isForbiddenPath(".env_ds"), true);
    assert.equal(isForbiddenPath("node_modules/pkg/index.js"), true);
    assert.equal(isForbiddenPath("private/plan.docx"), true);
    assert.equal(isForbiddenPath(".qqfriend/image-memes.json"), true);
    assert.equal(isForbiddenPath(".qqfriend/memes.json"), true);
    assert.equal(isForbiddenPath(".qqfriend/api-providers.json"), true);
    assert.equal(isForbiddenPath(".qqfriend/api-providers.previous.json"), true);
    assert.equal(isForbiddenPath(".qqfriend/stickers/catalog.json"), true);
  });

  it("allows normal source paths", () => {
    assert.equal(isForbiddenPath("bridge/help.mjs"), false);
    assert.equal(isForbiddenPath("package.json"), false);
  });
});

describe("collectReleaseFiles", () => {
  it("collects whitelisted files and excludes sensitive files", () => {
    const root = makeTempProject();
    const files = collectReleaseFiles(root);

    assert.equal(files.includes("bridge/admin-commands.mjs"), true);
    assert.equal(files.includes("package.json"), true);
    assert.equal(files.some(file => file.startsWith(".env_")), false);
    assert.equal(files.some(file => file.startsWith("node_modules/")), false);
    assert.equal(files.some(file => file.endsWith(".docx")), false);
    assert.equal(files.includes(".qqfriend/index.json"), true);
    assert.equal(files.includes(".qqfriend/memes.json"), false);
    assert.equal(files.includes(".qqfriend/image-memes.json"), false);
    assert.equal(files.includes(".qqfriend/stickers/catalog.json"), false);
  });
});

describe("zip path checks", () => {
  it("rejects Windows backslash paths", () => {
    assert.throws(() => assertPortableZipEntries(["bridge\\help.mjs"]), /Windows path/);
  });

  it("rejects parent directory escapes", () => {
    assert.throws(() => assertPortableZipEntries(["../secret.txt"]), /escapes root/);
  });
});

describe("release hashes and manifest", () => {
  it("sha256File returns 64 hex characters", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "qqfriend-hash-"));
    const file = path.join(root, "sample.txt");
    fs.writeFileSync(file, "hello\n", "utf8");
    assert.match(sha256File(file), /^[a-f0-9]{64}$/);
  });

  it("manifest includes version / sha256 / included", () => {
    const manifest = buildManifest({
      name: "qqfriend",
      version: "1.2.1-test",
      createdAt: "2026-06-20T00:00:00.000Z",
      zip: "dist/qqfriend.zip",
      sha256: "a".repeat(64),
      checks: { lint: "pass" },
      counts: { files: 1, tests: "1/1 pass" },
      included: ["package.json"],
      excluded: [".env_admins"],
    });

    assert.equal(manifest.version, "1.2.1-test");
    assert.equal(manifest.sha256, "a".repeat(64));
    assert.deepEqual(manifest.included, ["package.json"]);
  });
});
