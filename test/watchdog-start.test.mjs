import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { URL } from "node:url";

const source = fs.readFileSync(new URL("../scripts/watchdog.mjs", import.meta.url), "utf8");

test("watchdog starts Bridge directly without cmd redirection", function () {
  assert.match(source, /startDetached\(process\.execPath,\s*\["napcat_bridge\.mjs"\]/);
  assert.match(source, /stdio:\s*\["ignore",\s*logFd,\s*logFd\]/);
  assert.doesNotMatch(source, /startDetached\("cmd\.exe"/);
});
