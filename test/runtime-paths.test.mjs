import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";

import {
  listVersionedShells,
  prepareNapCatLaunch,
  resolveNapCatExe,
} from "../scripts/runtime-paths.mjs";

const tempDirs = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("NapCat 运行时发现", () => {
  it("优先选择语义版本最高的并行安装目录", () => {
    const root = useTempRoot();
    const low = createRuntime(root, "NapCat.v4.17.2.Shell");
    const high = createRuntime(root, "NapCat.v4.18.13.Shell");

    assert.deepEqual(listVersionedShells(path.join(root, "NapCat")), [
      path.join(high, "NapCatWinBootMain.exe"),
      path.join(low, "NapCatWinBootMain.exe"),
    ]);
    assert.equal(resolveNapCatExe({ root }), path.join(high, "NapCatWinBootMain.exe"));
  });

  it("完整官方运行时优先于版本更高但不完整的目录", () => {
    const root = useTempRoot();
    const complete = createRuntime(root, "NapCat.v4.18.13.Shell", { official: true });
    createRuntime(root, "NapCat.v9.0.0.Shell");

    assert.equal(resolveNapCatExe({ root }), path.join(complete, "NapCatWinBootMain.exe"));
  });

  it("官方注入目录会生成参数、快速登录账号和加载脚本", () => {
    const root = useTempRoot();
    const runtime = createRuntime(root, "NapCat.v4.18.13.Shell", { official: true });
    fs.writeFileSync(
      path.join(runtime, "config", "webui.json"),
      JSON.stringify({ autoLoginAccount: "1000000006" }),
      "utf8"
    );

    const launch = prepareNapCatLaunch({ root });
    assert.equal(launch.mode, "official-injection");
    assert.deepEqual(launch.args.slice(-2), ["-q", "1000000006"]);
    assert.equal(launch.args[0], path.join(runtime, "QQ.exe"));
    assert.equal(launch.env.NAPCAT_MAIN_PATH, path.join(runtime, "napcat.mjs"));
    assert.match(fs.readFileSync(path.join(runtime, "loadNapCat.js"), "utf8"), /file:\/\/\/.*napcat\.mjs/);
  });

  it("旧版壳仍保留无参数回滚方式", () => {
    const root = useTempRoot();
    const legacy = path.join(root, "NapCat", "NapCat.44498.Shell");
    fs.mkdirSync(legacy, { recursive: true });
    fs.writeFileSync(path.join(legacy, "NapCatWinBootMain.exe"), "");

    const launch = prepareNapCatLaunch({ root });
    assert.equal(launch.mode, "legacy-shell");
    assert.deepEqual(launch.args, []);
  });
});

function useTempRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "qqfriend-runtime-"));
  tempDirs.push(root);
  return root;
}

function createRuntime(root, name, options = {}) {
  const runtime = path.join(root, "NapCat", name);
  fs.mkdirSync(path.join(runtime, "config"), { recursive: true });
  fs.writeFileSync(path.join(runtime, "NapCatWinBootMain.exe"), "");
  if (options.official) {
    for (const filename of ["napcat.mjs", "NapCatWinBootHook.dll", "QQ.exe", "qqnt.json"]) {
      fs.writeFileSync(path.join(runtime, filename), "");
    }
  }
  return runtime;
}
