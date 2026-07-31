import test from "node:test";
import assert from "node:assert/strict";
import { URL } from "node:url";

import {
  buildModuleCatalog,
  handleAdminApiRequest,
} from "../bridge/admin-api/index.mjs";
import { moduleIds } from "../bridge/modules/manifest.mjs";

test("module manifest declares core business modules", () => {
  const ids = moduleIds();
  for (const id of ["commands", "jm", "group-summary", "relationship", "memory", "resource-transfer", "output-safety"]) {
    assert.ok(ids.includes(id), id);
  }
});

test("module catalog is safe and includes health metadata", () => {
  const catalog = buildModuleCatalog({
    cfg: {
      botNames: ["夜星"],
      adminUins: ["1000000010"],
      resourceGroupWhitelist: [1000000002],
      summaryGroupWhitelist: [1000000009],
      legacyProfileRefreshEnabled: false,
      resourceMaxBytes: 500 * 1024 * 1024,
      jmTimeoutMs: 1000,
      jmDomains: ["example.test"],
      jmPython: "python",
      jmZipPassword: "FS",
      jmSevenZipPath: "C:/7z.exe",
    },
    longGroups: ["2000000003"],
  });

  assert.equal(catalog.count, catalog.modules.length);
  const jm = catalog.modules.find(module => module.id === "jm");
  assert.ok(jm);
  assert.equal(jm.riskLevel, "high");
  assert.ok(jm.healthChecks.length >= 1);
  assert.equal(JSON.stringify(catalog).includes("FS"), false);
  assert.equal(JSON.stringify(catalog).includes("C:/7z.exe"), false);
});

test("admin modules route returns module catalog", async () => {
  const writes = [];
  const req = {
    method: "GET",
    url: "/admin/modules",
    socket: { remoteAddress: "127.0.0.1" },
    headers: {},
  };

  const handled = await handleAdminApiRequest(req, {}, {
    pathname: "/admin/modules",
    url: new URL("http://localhost/admin/modules"),
    sendJson(_res, statusCode, payload) {
      writes.push({ statusCode, payload });
    },
  });

  assert.equal(handled, true);
  assert.equal(writes[0].statusCode, 200);
  assert.ok(writes[0].payload.modules.some(module => module.id === "memory"));
});
