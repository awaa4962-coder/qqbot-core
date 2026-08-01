import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { describe, it } from "node:test";

import {
  buildJmDownloadEnv,
  buildSevenZipArgs,
  cleanupExpiredJmTempDirs,
  handleJmTransferCommand,
  handlePrivateJmTransferCommand,
  isJmUserAllowed,
  jmErrorText,
  parseJmCommand,
  transferJmToPrivate,
  transferJmToGroup,
  zipDirectory,
} from "../bridge/jm-provider.mjs";

describe("jm provider", () => {
  it("parses jm code commands after bot mention", () => {
    assert.deepEqual(parseJmCommand("@QQFriend jm 123456", {
      requireMention: true,
      botNames: ["QQFriend"],
    }), { ok: true, jmId: "123456" });

    assert.deepEqual(parseJmCommand("@QQFriend JM123456", {
      requireMention: true,
      botNames: ["QQFriend"],
    }), { ok: true, jmId: "123456" });
  });

  it("ignores non-jm commands", () => {
    assert.equal(parseJmCommand("@QQFriend help", {
      requireMention: true,
      botNames: ["QQFriend"],
    }), null);
  });

  it("rejects groups outside whitelist before running provider", async () => {
    let runnerCalled = false;
    const sent = [];
    const handled = await handleJmTransferCommand({
      isAtMe: true,
      text: "@QQFriend jm 123456",
      rawText: "@QQFriend jm 123456",
      group_id: 100,
    }, {
      botNames: ["QQFriend"],
      groupWhitelist: [200],
      sender: async (groupId, text) => sent.push({ groupId, text }),
      runner: async () => { runnerCalled = true; },
    });

    assert.equal(handled, true);
    assert.equal(runnerCalled, false);
    assert.match(sent[0].text, /白名单/);
  });

  it("uploads zip and keeps temp files until delayed cleanup", async () => {
    let zipPathSeen = "";
    let tempRoot = "";
    let zipOptions = null;
    const sent = [];

    const result = await transferJmToGroup({
      jmId: "123456",
      groupId: 300,
      zipPassword: "FS",
      cleanupDelayMs: 60 * 60 * 1000,
      sender: async (groupId, text) => sent.push({ groupId, text }),
      runner: async (_jmId, outputDir) => {
        tempRoot = path.dirname(outputDir);
        await fsp.writeFile(path.join(outputDir, "001.jpg"), "image", "utf8");
        return { ok: true };
      },
      zipper: async (_sourceDir, zipPath, options) => {
        zipOptions = options;
        await fsp.writeFile(zipPath, "zip", "utf8");
      },
      uploader: async (groupId, filePath, name) => {
        assert.equal(groupId, 300);
        assert.equal(name, "jm-123456.zip");
        zipPathSeen = filePath;
        assert.equal(fs.existsSync(filePath), true);
        return { status: "ok" };
      },
    });

    assert.equal(result.ok, true);
    assert.equal(zipOptions.password, "FS");
    assert.equal(fs.existsSync(zipPathSeen), true);
    assert.equal(fs.existsSync(tempRoot), true);
    assert.ok(sent.some(item => item.text.includes("已转发")));
    assert.ok(sent.some(item => item.text.includes("FS")));
    assert.ok(sent.some(item => item.text.includes("1 天后")));
    await fsp.rm(tempRoot, { recursive: true, force: true });
  });

  it("allows private jm only for jm user whitelist", async () => {
    let runnerCalled = false;
    const sent = [];
    const handled = await handlePrivateJmTransferCommand({
      text: "jm 123456",
      rawText: "jm 123456",
      user_id: 1000000002,
    }, {
      userWhitelist: [1000000002],
      sender: async (userId, text) => sent.push({ userId, text }),
      runner: async (_jmId, outputDir) => {
        runnerCalled = true;
        await fsp.writeFile(path.join(outputDir, "001.jpg"), "image", "utf8");
        return { ok: true };
      },
      zipper: async (_sourceDir, zipPath) => {
        await fsp.writeFile(zipPath, "zip", "utf8");
      },
      uploader: async (userId, filePath, name) => {
        assert.equal(userId, 1000000002);
        assert.equal(name, "jm-123456.zip");
        assert.equal(fs.existsSync(filePath), true);
        return { status: "ok" };
      },
    });

    assert.equal(handled, true);
    assert.equal(runnerCalled, true);
    assert.ok(sent.some(item => item.userId === 1000000002));
  });

  it("accepts optional bot mention for private jm commands", async () => {
    let runnerCalled = false;
    const handled = await handlePrivateJmTransferCommand({
      text: "@QQFriend jm 123456",
      rawText: "@QQFriend jm 123456",
      user_id: 1000000002,
    }, {
      botNames: ["QQFriend"],
      userWhitelist: [1000000002],
      sender: async () => {},
      runner: async (_jmId, outputDir) => {
        runnerCalled = true;
        await fsp.writeFile(path.join(outputDir, "001.jpg"), "image", "utf8");
        return { ok: true };
      },
      zipper: async (_sourceDir, zipPath) => {
        await fsp.writeFile(zipPath, "zip", "utf8");
      },
      uploader: async () => ({ status: "ok" }),
    });

    assert.equal(handled, true);
    assert.equal(runnerCalled, true);
  });

  it("rejects private jm outside jm user whitelist before running provider", async () => {
    let runnerCalled = false;
    const sent = [];
    const handled = await handlePrivateJmTransferCommand({
      text: "/jm 123456",
      rawText: "/jm 123456",
      user_id: 12345,
    }, {
      userWhitelist: [1000000002],
      sender: async (userId, text) => sent.push({ userId, text }),
      runner: async () => { runnerCalled = true; },
    });

    assert.equal(handled, true);
    assert.equal(runnerCalled, false);
    assert.equal(sent[0].userId, 12345);
    assert.match(sent[0].text, /JM/);
  });

  it("checks private jm user whitelist numerically", () => {
    assert.equal(isJmUserAllowed("1000000002", [1000000002]), true);
    assert.equal(isJmUserAllowed(12345, [1000000002]), false);
  });

  it("uploads private jm zip and keeps temp files until delayed cleanup", async () => {
    let zipPathSeen = "";
    let tempRoot = "";
    let zipOptions = null;

    const result = await transferJmToPrivate({
      jmId: "123456",
      userId: 1000000002,
      zipPassword: "FS",
      cleanupDelayMs: 60 * 60 * 1000,
      sender: async () => {},
      runner: async (_jmId, outputDir) => {
        tempRoot = path.dirname(outputDir);
        await fsp.writeFile(path.join(outputDir, "001.jpg"), "image", "utf8");
        return { ok: true };
      },
      zipper: async (_sourceDir, zipPath, options) => {
        zipOptions = options;
        await fsp.writeFile(zipPath, "zip", "utf8");
      },
      uploader: async (userId, filePath, name) => {
        assert.equal(userId, 1000000002);
        assert.equal(name, "jm-123456.zip");
        zipPathSeen = filePath;
        assert.equal(fs.existsSync(filePath), true);
        return { status: "ok" };
      },
    });

    assert.equal(result.ok, true);
    assert.equal(zipOptions.password, "FS");
    assert.equal(fs.existsSync(zipPathSeen), true);
    assert.equal(fs.existsSync(tempRoot), true);
    await fsp.rm(tempRoot, { recursive: true, force: true });
  });

  it("has a dependency fallback message", () => {
    assert.match(jmErrorText("missing_dependency"), /依赖/);
    assert.match(jmErrorText("missing_jmcomic_source"), /源码文件/);
    assert.match(jmErrorText("missing_python_dependency"), /Python 依赖/);
    assert.match(jmErrorText("jmcomic_import_failed"), /模块导入失败/);
  });

  it("builds jm downloader env without relying on Windows Temp source", () => {
    const env = buildJmDownloadEnv({ QQBOT_JMCOMIC_SRC: "legacy-temp-src" });
    assert.equal(typeof env.QQBOT_JMCOMIC_SRC, "string");
    assert.equal(typeof env.QQBOT_JM_DOMAINS, "string");
  });

  it("builds encrypted 7z zip args with uppercase FS password", () => {
    assert.deepEqual(buildSevenZipArgs("out.zip", "FS"), [
      "a",
      "-tzip",
      "-mx=0",
      "-mem=AES256",
      "-pFS",
      "out.zip",
      ".",
    ]);
  });

  it("fails closed when encrypted zip has no 7z tool", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "qqfriend-jm-zip-test-"));
    const source = path.join(root, "src");
    const zipPath = path.join(root, "out.zip");
    await fsp.mkdir(source);
    await fsp.writeFile(path.join(source, "001.jpg"), "image", "utf8");

    try {
      await assert.rejects(
        zipDirectory(source, zipPath, {
          password: "FS",
          sevenZipPath: "qqfriend-definitely-missing-7z",
        }),
        /zip_tool_missing/,
      );
      assert.equal(fs.existsSync(zipPath), false);
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it("cleans expired jm temp dirs on startup sweep", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "qqfriend-jm-test-"));
    const oldDir = path.join(root, "qqfriend-jm-old");
    const freshDir = path.join(root, "qqfriend-jm-fresh");
    const unrelatedDir = path.join(root, "other-dir");
    await fsp.mkdir(oldDir);
    await fsp.mkdir(freshDir);
    await fsp.mkdir(unrelatedDir);
    const oldTime = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    await fsp.utimes(oldDir, oldTime, oldTime);

    try {
      const cleaned = await cleanupExpiredJmTempDirs({
        root,
        maxAgeMs: 24 * 60 * 60 * 1000,
        now: Date.now(),
      });
      assert.equal(cleaned, 1);
      assert.equal(fs.existsSync(oldDir), false);
      assert.equal(fs.existsSync(freshDir), true);
      assert.equal(fs.existsSync(unrelatedDir), true);
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it("jm download script reports incomplete source without site-package fallback", async t => {
    const python = findTestPython();
    if (!python) t.skip("python unavailable");

    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "qqfriend-jm-script-test-"));
    const emptySrc = path.join(root, "src");
    const outDir = path.join(root, "out");
    await fsp.mkdir(path.join(emptySrc, "jmcomic"), { recursive: true });
    await fsp.mkdir(outDir);

    try {
      const result = await runPythonScript(python, [
        "-S",
        path.resolve("scripts", "jm_download_once.py"),
        "--id",
        "000000000000",
        "--out",
        outDir,
      ], {
        QQBOT_JMCOMIC_SRC: emptySrc,
        QQBOT_JM_AUTO_INSTALL: "0",
      });
      assert.equal(result.code, 2);
      assert.match(result.stdout, /QQFRIEND_JM_RESULT/);
      assert.match(result.stdout, /missing_jmcomic_source/);
      assert.match(result.stdout, /jm_config\.py/);
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });
});

function findTestPython() {
  if (process.env.QQBOT_TEST_PYTHON && fs.existsSync(process.env.QQBOT_TEST_PYTHON)) {
    return process.env.QQBOT_TEST_PYTHON;
  }
  const bundled = path.join(
    process.env.USERPROFILE || "",
    ".cache",
    "codex-runtimes",
    "codex-primary-runtime",
    "dependencies",
    "python",
    "python.exe",
  );
  return fs.existsSync(bundled) ? bundled : "";
}

function runPythonScript(command, args, envPatch) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: {
        ...process.env,
        ...envPatch,
        PYTHONNOUSERSITE: "1",
      },
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", chunk => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", chunk => { stderr += chunk.toString("utf8"); });
    child.on("error", reject);
    child.on("close", code => resolve({ code, stdout, stderr }));
  });
}
