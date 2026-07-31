import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import {
  buildCurrentInput as buildCurrentInputFromFacade,
  cleanText as cleanTextFromFacade,
  recentHistory as recentHistoryFromFacade,
} from "../bridge/context.mjs";
import { buildCurrentInput, cleanText } from "../bridge/context/messages.mjs";
import { recentHistory } from "../bridge/context/history.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

describe("context module boundaries", () => {
  it("keeps context.mjs as a compatibility facade for split modules", () => {
    const msg = [{ type: "text", data: { text: "你好" } }];
    assert.equal(cleanTextFromFacade(msg), cleanText(msg));
    assert.equal(
      buildCurrentInputFromFacade("Alice", "hello", "42"),
      buildCurrentInput("Alice", "hello", "42")
    );
    assert.equal(recentHistoryFromFacade("missing").length, recentHistory("missing").length);
  });

  it("keeps bridge runtime imports on split context modules", () => {
    const offenders = [];
    for (const file of listMjsFiles(path.join(ROOT, "bridge"))) {
      if (path.basename(file) === "context.mjs") continue;
      const source = fs.readFileSync(file, "utf8");
      if (/from\s+["'](?:\.\/|\.\.\/)context\.mjs["']/.test(source)) {
        offenders.push(path.relative(ROOT, file));
      }
    }
    assert.deepEqual(offenders, []);
  });
});

function listMjsFiles(dir) {
  const files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...listMjsFiles(fullPath));
    else if (entry.name.endsWith(".mjs")) files.push(fullPath);
  }
  return files;
}
