import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { URL } from "node:url";
import test from "node:test";
import { load } from "js-yaml";
import { collectReleaseFiles, isForbiddenPath } from "../scripts/release.mjs";
import { testExitCode } from "../scripts/run-tests.mjs";

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "qqfriend-release-boundary-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function write(root, name, body = "synthetic fixture") {
  const file = path.join(root, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
}

test("release default-denies Linux runtime, private files and nested state", t => {
  const root = fixture(t);
  const privatePaths = [
    "deploy/linux/qqfriend.env", "deploy/linux/.env.local", "deploy/linux/.env.production",
    "deploy/linux/state/napcat/config/webui.json", "deploy/linux/state/napcat/qq/login.db",
    "deploy/linux/state/qqfriend/data/.qqfriend/diagnostics/replay.json",
    "deploy/linux/private/settings.json", "deploy/linux/new-runtime.json",
    "bridge/.env.production", "bridge/custom.env", "bridge/.qqfriend/tasks/admin.json",
    "bridge/chat-delivery.json",
  ];
  for (const name of privatePaths) { write(root, name); assert.equal(isForbiddenPath(name), true, name); }
  const publicPaths = ["deploy/linux/.env.example", "deploy/linux/qqfriend.env.example", "deploy/linux/compose.yaml", "deploy/linux/systemd/qqfriend.service", ".qqfriend/index.json", "bridge/help.mjs"];
  for (const name of publicPaths) write(root, name);
  assert.deepEqual(collectReleaseFiles(root), publicPaths.sort());
});

test("release rejects directory links and explicit-file symlink ancestors", t => {
  for (const name of ["bridge", ".qqfriend"]) {
    const root = fixture(t);
    const outside = fixture(t);
    write(outside, "index.json");
    try { fs.symlinkSync(outside, path.join(root, name), "junction"); }
    catch (error) { if (process.platform === "win32" && ["EPERM", "EACCES", "ENOTSUP"].includes(error.code)) { t.skip("symlinks unavailable on Windows"); return; } throw error; }
    assert.throws(() => collectReleaseFiles(root), /symbolic links are not allowed/);
  }
});

test("release refuses file links without following their content", t => {
  const root = fixture(t);
  const outside = fixture(t);
  write(outside, "target.txt");
  fs.mkdirSync(path.join(root, "bridge"));
  try { fs.symlinkSync(path.join(outside, "target.txt"), path.join(root, "bridge", "linked.mjs"), "file"); }
  catch (error) { if (process.platform === "win32" && ["EPERM", "EACCES", "ENOTSUP"].includes(error.code)) { t.skip("file symlinks unavailable on Windows"); return; } throw error; }
  assert.throws(() => collectReleaseFiles(root), /symbolic links are not allowed/);
});

test("test runner fails closed on signals and absent exit codes", () => {
  assert.equal(testExitCode(0, null), 0);
  assert.equal(testExitCode(7, null), 7);
  for (const [code, signal] of [[null, "SIGTERM"], [null, "SIGKILL"], [null, null], [undefined, undefined], [0, "SIGTERM"]]) {
    assert.notEqual(testExitCode(code, signal), 0);
  }
});

test("both Compose services have bounded Docker stdout logs", () => {
  const compose = load(fs.readFileSync(new URL("../deploy/linux/compose.yaml", import.meta.url), "utf8"));
  for (const name of ["bridge", "napcat"]) {
    assert.deepEqual(compose.services[name].logging, { driver: "json-file", options: { "max-size": "10m", "max-file": "3" } });
  }
});

test("image release identity includes package version and source commit", () => {
  const workflow = load(fs.readFileSync(new URL("../.github/workflows/publish-linux-images.yml", import.meta.url), "utf8"));
  assert.equal(workflow.env.RELEASE_TAG, undefined);
  const identify = workflow.jobs.publish.steps.find(step => step.name === "Identify versioned release");
  assert.match(identify.run, /package\.json.*version/);
  assert.match(identify.run, /RELEASE_TAG=linux-images-v%s-%s/);
  assert.match(identify.run, /GITHUB_SHA:0:12/);
  assert.doesNotMatch(workflow.jobs.publish.steps.at(-1).run, /--title .*v1\.4\.0|gh release edit/);
});
