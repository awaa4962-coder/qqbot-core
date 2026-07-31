import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import {
  buildManifestSnippet,
  buildScaffoldFiles,
  normalizeCommandId,
  parseScaffoldArgs,
  scaffoldCommand,
} from "../scripts/scaffold-command.mjs";

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "qqfriend-scaffold-"));
}

describe("command scaffold script", () => {
  it("parses CLI arguments into safe scaffold options", () => {
    const options = parseScaffoldArgs([
      "hello-world",
      "--permission=admin",
      "--aliases=hello,你好",
      "--help=  hello        demo  ",
    ]);
    assert.equal(options.id, "hello-world");
    assert.equal(options.permission, "admin");
    assert.deepEqual(options.aliases, ["hello", "你好"]);
    assert.equal(options.helpLine, "hello        demo");
  });

  it("validates command ids", () => {
    assert.equal(normalizeCommandId("hello-world"), "hello-world");
    assert.throws(() => normalizeCommandId("1-bad"), /kebab-case/);
    assert.throws(() => normalizeCommandId("bad_value"), /kebab-case/);
  });

  it("builds manifest snippets and dry-run file lists without writing", () => {
    const root = tempRoot();
    const result = scaffoldCommand({
      root,
      id: "demo-command",
      aliases: ["demo"],
      helpLine: "  demo        demo command",
    });
    assert.equal(result.write, false);
    assert.match(result.manifestSnippet, /id: "demo-command"/);
    assert.match(buildManifestSnippet({ id: "demo-command", aliases: ["demo"] }), /aliases: \["demo"\]/);
    assert.equal(result.files.includes("bridge/commands/modules/demo-command.mjs"), true);
    assert.equal(fs.existsSync(path.join(root, "bridge")), false);
  });

  it("writes module and test skeletons only when requested", () => {
    const root = tempRoot();
    const result = scaffoldCommand({
      root,
      id: "demo-command",
      aliases: ["demo"],
      helpLine: "  demo        demo command",
      write: true,
    });
    assert.equal(result.write, true);
    const files = buildScaffoldFiles({ id: "demo-command", aliases: ["demo"] });
    for (const file of files) {
      assert.equal(fs.existsSync(path.join(root, file.path)), true, file.path);
    }
    const moduleText = fs.readFileSync(path.join(root, "bridge/commands/modules/demo-command.mjs"), "utf8");
    assert.match(moduleText, /buildDemoCommandCommandReply/);
  });

  it("refuses to overwrite generated files", () => {
    const root = tempRoot();
    const options = { root, id: "demo-command", aliases: ["demo"], write: true };
    scaffoldCommand(options);
    assert.throws(() => scaffoldCommand(options), /file already exists/);
  });
});
