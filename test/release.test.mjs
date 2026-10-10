import { describe, it } from "node:test";
import assert from "node:assert/strict";
import console from "node:console";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  assertPortableZipEntries,
  buildManifest,
  collectReleaseFiles,
  isForbiddenPath,
  main,
  parseTestCounts,
  sha256File,
} from "../scripts/release.mjs";

function cleanupFixture(root) {
  const resolved = fs.realpathSync(root);
  assert.ok(resolved.startsWith(fs.realpathSync(os.tmpdir()) + path.sep));
  fs.rmSync(resolved, { recursive: true, force: true });
}

function makeTempProject(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "qqfriend-release-"));
  t.after(() => cleanupFixture(root));
  const files = {
    "bridge/admin-commands.mjs": "export const ok = true;\n",
    "bridge/memory-profile/store.mjs": "export const profiles = {};\n",
    "bridge/tasks/runner.mjs": "export const ready = true;\n",
    "launcher/QQFriendLauncher/Web/ui/tasks.js": "export const ready = true;\n",
    "test/core.test.mjs": "import assert from 'node:assert/strict';\nassert.ok(true);\n",
    "scripts/runtime-check.mjs": "console.log('ok');\n",
    "deploy/linux/CONTEXT.md": "# Public context contract\n",
    "deploy/linux/qqfriend.env": "synthetic-private-env\n",
    "deploy/linux/private.key": "synthetic-private-key\n",
    "deploy/linux/notes.docx": "synthetic-private-document\n",
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
    ".env_admins": "1000000002\n",
    ".qqfriend/index.json": "{\"safe\":true}\n",
    ".qqfriend/api-providers.json": "{\"runtime\":true}\n",
    ".qqfriend/api-providers.previous.json": "{\"runtime\":true}\n",
    ".qqfriend/api-providers.pre-release.json": "{\"runtime\":true}\n",
    ".qqfriend/future-runtime-state.json": "{\"runtime\":true}\n",
    ".qqfriend/memes.json": "{\"contexts\":[\"private runtime data\"]}\n",
    ".qqfriend/memes.json.tmp.1234": "{\"runtime\":true}\n",
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
    for (const filename of ["mcp-services.json", ".mcp-secrets.json", "tool-settings.json"]) {
      assert.equal(isForbiddenPath(filename), true);
      assert.equal(isForbiddenPath("bridge/" + filename), true);
      assert.equal(isForbiddenPath("launcher/QQFriendLauncher/Web/" + filename), true);
    }
    assert.equal(isForbiddenPath(".env_admins"), true);
    assert.equal(isForbiddenPath(".env_ds"), true);
    assert.equal(isForbiddenPath("bridge/.user-salt"), true);
    assert.equal(isForbiddenPath("bridge/usage-2026-09-23.jsonl"), true);
    assert.equal(isForbiddenPath("node_modules/pkg/index.js"), true);
    assert.equal(isForbiddenPath("private/plan.docx"), true);
    assert.equal(isForbiddenPath(".qqfriend/image-memes.json"), true);
    assert.equal(isForbiddenPath(".qqfriend/memes.json"), true);
    assert.equal(isForbiddenPath(".qqfriend/memes.json.tmp.1234"), true);
    assert.equal(isForbiddenPath(".qqfriend/api-providers.json"), true);
    assert.equal(isForbiddenPath(".qqfriend/api-providers.pre-release.json"), true);
    assert.equal(isForbiddenPath(".qqfriend/future-runtime-state.json"), true);
    assert.equal(isForbiddenPath(".qqfriend/index.json"), false);
    assert.equal(isForbiddenPath("launcher/App/bin/Release/app.dll"), true);
    assert.equal(isForbiddenPath("launcher/App.exe.WebView2/Default/Cookies"), true);
    assert.equal(isForbiddenPath(".qqfriend/stickers/catalog.json"), true);
  });

  it("allows normal source paths", () => {
    assert.equal(isForbiddenPath("bridge/help.mjs"), false);
    assert.equal(isForbiddenPath("package.json"), false);
  });
});

describe("collectReleaseFiles", () => {
  it("collects whitelisted files and excludes sensitive files", t => {
    const root = makeTempProject(t);
    const files = collectReleaseFiles(root);

    assert.equal(files.includes("bridge/admin-commands.mjs"), true);
    assert.equal(files.includes("bridge/memory-profile/store.mjs"), true);
    assert.equal(files.includes("bridge/tasks/runner.mjs"), true);
    assert.equal(files.includes("launcher/QQFriendLauncher/Web/ui/tasks.js"), true);
    assert.equal(files.includes("package.json"), true);
    assert.equal(files.includes("deploy/linux/CONTEXT.md"), true);
    assert.equal(files.includes("deploy/linux/qqfriend.env"), false);
    assert.equal(files.includes("deploy/linux/private.key"), false);
    assert.equal(files.includes("deploy/linux/notes.docx"), false);
    assert.equal(files.some(file => file.startsWith(".env_")), false);
    assert.equal(files.some(file => file.startsWith("node_modules/")), false);
    assert.equal(files.some(file => file.endsWith(".docx")), false);
    assert.equal(files.includes(".qqfriend/index.json"), true);
    assert.equal(files.includes(".qqfriend/api-providers.json"), false);
    assert.equal(files.includes(".qqfriend/api-providers.previous.json"), false);
    assert.equal(files.includes(".qqfriend/api-providers.pre-release.json"), false);
    assert.equal(files.includes(".qqfriend/future-runtime-state.json"), false);
    assert.equal(files.includes(".qqfriend/memes.json"), false);
    assert.equal(files.includes(".qqfriend/memes.json.tmp.1234"), false);
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
  it("sha256File returns 64 hex characters", t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "qqfriend-hash-"));
    t.after(() => cleanupFixture(root));
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

describe("release captured test counts", () => {
  const summary = "# tests 5\n# pass 3\n# fail 0\n# cancelled 0\n# skipped 1\n# todo 1\n";

  it("parses TAP and spec summaries without counting suites", () => {
    const expected = { total: 5, pass: 3, fail: 0, skipped: 1 };
    assert.deepEqual(parseTestCounts("# suites 2\n" + summary), expected);
    assert.deepEqual(parseTestCounts(summary.replace(/#/g, "\u2139").replace(/\n/g, "\r\n")), expected);
    assert.deepEqual(parseTestCounts("# tests 0\n# pass 0\n# fail 0\n# skipped 0\n"),
      { total: 0, pass: 0, fail: 0, skipped: 0 });
    assert.deepEqual(parseTestCounts("# tests 3\n# pass 1\n# fail 1\n# skipped 1\n"),
      { total: 3, pass: 1, fail: 1, skipped: 1 });
  });

  it("leaves absent, malformed, unsafe, duplicate and inconsistent counts unknown", () => {
    for (const output of [undefined, "", "# tests 5\n# pass 5\n", summary.replace("pass 3", "pass -3"),
      summary.replace("pass 3", "pass 3x"), summary.replace("tests 5", "tests 5.0"),
      summary.replace("tests 5", "tests 9007199254740992"), summary + "# pass 3\n",
      summary + "# tests\n", summary.replace("skipped 1", "skipped NaN"),
      summary.replace("tests 5", "tests 6"), "diagnostic: # tests 5\ndiagnostic: # pass 5\n"]) {
      assert.equal(parseTestCounts(output), null);
    }
  });

  it("check-only reports the one captured test run and never prints raw output", async t => {
    const root = makeTempProject(t);
    const logs = [];
    const calls = [];
    t.mock.method(console, "log", (...args) => logs.push(args.join(" ")));
    const runner = (_command, args, options) => {
      calls.push(args.join(" "));
      assert.equal(options.cwd, root);
      if (args[0] === "test") {
        assert.equal(options.redactOutput, true);
        return "synthetic-private-test-detail\n" + summary;
      }
      if (args[1] === "check:jm") assert.equal(options.env.NODE_ENV, "test");
      return "synthetic-private-check-detail";
    };
    await main(["--check-only"], root, runner);
    assert.deepEqual(calls, ["run check:dependencies", "run lint", "test", "run check:runtime:ci", "run check:jm"]);
    assert.equal(logs.filter(line => line.includes("test counts")).length, 1);
    assert.ok(logs.includes("[release] test counts total=5 pass=3 fail=0 skipped=1"));
    assert.ok(logs.includes("[release] check-only complete"));
    assert.ok(logs.every(line => !line.includes("synthetic-private")));
    assert.equal(fs.existsSync(path.join(root, "dist", "release-manifest.json")), false);
  });

  it("check-only retains unknown counts when a successful runner has malformed metadata", async t => {
    const root = makeTempProject(t);
    const logs = [];
    t.mock.method(console, "log", line => logs.push(line));
    await main(["--check-only"], root, () => "# tests invalid\n# pass 1\n");
    assert.ok(logs.includes("[release] test counts unknown"));
    assert.ok(logs.includes("[release] check-only complete"));
  });

  it("a failed test command still blocks later gates and check-only completion", async t => {
    const root = makeTempProject(t);
    const logs = [];
    const calls = [];
    t.mock.method(console, "log", line => logs.push(line));
    await assert.rejects(main(["--check-only"], root, (_command, args) => {
      calls.push(args.join(" "));
      if (args[0] === "test") throw new Error("synthetic test gate failed");
      return summary;
    }), /synthetic test gate failed/);
    assert.deepEqual(calls, ["run check:dependencies", "run lint", "test"]);
    assert.ok(logs.every(line => !line.includes("test counts") && !line.includes("check-only complete")));
    assert.equal(fs.existsSync(path.join(root, "dist", "release-file-list.txt")), false);
  });
});
