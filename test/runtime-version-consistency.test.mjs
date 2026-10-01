import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { VERSION, VERSION_NAME, buildVersionText, buildVersionQueryText } from "../bridge/version.mjs";

const readJson = relative => JSON.parse(fs.readFileSync(new globalThis.URL(relative, import.meta.url), "utf8"));

test("package, root lock and runtime command versions identify the same candidate", () => {
  const pkg = readJson("../package.json");
  const lock = readJson("../package-lock.json");
  assert.equal(VERSION, pkg.version);
  assert.equal(lock.version, pkg.version);
  assert.equal(lock.packages[""].version, pkg.version);
  assert.equal(VERSION_NAME, VERSION.split("-").slice(1).join("-"));
  for (const language of ["zh", "en"]) assert.ok(buildVersionText(language).includes(VERSION));
});

test("the current candidate has a parseable latest changelog section", () => {
  const latest = buildVersionQueryText("更新 最近1版", "zh");
  assert.ok(latest.startsWith("v" + VERSION + " "));
  assert.ok(buildVersionQueryText("更新 v" + VERSION, "zh").startsWith("v" + VERSION + " "));
});
