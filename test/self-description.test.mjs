import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { URL } from "node:url";

import {
  buildProjectSelfDescription,
  handleAdminApiRequest,
} from "../bridge/admin-api/index.mjs";
import { writeProjectSelfDescription } from "../bridge/self-description.mjs";
import { moduleIds } from "../bridge/modules/manifest.mjs";
import { commandIds } from "../bridge/commands/manifest.mjs";

test("project self-description mirrors module and command manifests", () => {
  const data = buildProjectSelfDescription();
  assert.equal(data.modules.count, moduleIds().length);
  assert.equal(data.commands.count, commandIds().length);
  assert.ok(data.workflows.workflows.some(workflow => workflow.id === "diagnose-reply"));
  assert.ok(data.diagnostics.diagnostics.some(item => item.id === "group-no-reply"));
});

test("self-description writer creates .qqfriend json files", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "qqfriend-self-"));
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "qqfriend", version: "test" }), "utf8");
  const result = writeProjectSelfDescription({ root });
  const out = result.outputDir;

  for (const file of ["index.json", "architecture.json", "modules.json", "commands.json", "workflows.json", "diagnostics.json"]) {
    assert.equal(fs.existsSync(path.join(out, file)), true, file);
    JSON.parse(fs.readFileSync(path.join(out, file), "utf8"));
  }
});

test("self-description does not expose configured secret-like values", () => {
  const data = buildProjectSelfDescription({
    cfg: {
      botNames: ["夜星"],
      adminUins: ["1000000010"],
      resourceGroupWhitelist: [1],
      summaryGroupWhitelist: [2],
      legacyProfileRefreshEnabled: false,
      resourceMaxBytes: 1,
      jmTimeoutMs: 1,
      jmDomains: ["secret-domain.example"],
      jmPython: "python",
      jmZipPassword: "FS",
      jmSevenZipPath: "C:/secret/7z.exe",
    },
    longGroups: ["3"],
  });
  const text = JSON.stringify(data);
  assert.equal(text.includes("FS"), false);
  assert.equal(text.includes("C:/secret/7z.exe"), false);
});

test("admin self-description route returns project facts", async () => {
  const writes = [];
  const req = {
    method: "GET",
    url: "/admin/self-description",
    socket: { remoteAddress: "127.0.0.1" },
    headers: {},
  };

  const handled = await handleAdminApiRequest(req, {}, {
    pathname: "/admin/self-description",
    url: new URL("http://localhost/admin/self-description"),
    sendJson(_res, statusCode, payload) {
      writes.push({ statusCode, payload });
    },
  });

  assert.equal(handled, true);
  assert.equal(writes[0].statusCode, 200);
  assert.ok(writes[0].payload.architecture);
  assert.ok(writes[0].payload.modules);
  assert.ok(writes[0].payload.workflows);
});
