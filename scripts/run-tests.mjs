// scripts/run-tests.mjs - run the test suite with isolated mutable state.

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "qqfriend-tests-"));
const configRoot = path.join(sandbox, "config");
const dataRoot = path.join(sandbox, "data");
const tempRoot = path.join(sandbox, "temp");

for (const directory of [configRoot, dataRoot, tempRoot]) {
  fs.mkdirSync(directory, { recursive: true });
}
fs.writeFileSync(path.join(configRoot, ".env_mimo"), "test-only-mimo-key\n", "utf8");
fs.writeFileSync(path.join(configRoot, ".env_ds"), "test-only-deepseek-key\n", "utf8");

const files = collectTests(path.join(ROOT, "test"));
const child = spawn(process.execPath, ["--test", ...files], {
  cwd: ROOT,
  stdio: "inherit",
  windowsHide: true,
  env: {
    ...process.env,
    NODE_ENV: "test",
    QQBOT_CONFIG_ROOT: configRoot,
    QQBOT_DATA_DIR: dataRoot,
    QQBOT_LOG_DIR: path.join(dataRoot, "logs"),
    QQBOT_TEMP_DIR: tempRoot,
    TEMP: tempRoot,
    TMP: tempRoot,
  },
});

const exitCode = await new Promise(resolve => {
  child.once("error", () => resolve(1));
  child.once("exit", code => resolve(Number(code || 0)));
});

fs.rmSync(sandbox, { recursive: true, force: true });
process.exit(exitCode);

function collectTests(directory) {
  return fs.readdirSync(directory, { withFileTypes: true })
    .flatMap(entry => {
      const filename = path.join(directory, entry.name);
      if (entry.isDirectory()) return collectTests(filename);
      return entry.isFile() && entry.name.endsWith(".mjs") ? [filename] : [];
    })
    .sort();
}
