import test from "node:test";
import assert from "node:assert/strict";
import { URL } from "node:url";

import {
  buildWorkflowDescription,
  handleAdminApiRequest,
} from "../bridge/admin-api/index.mjs";

test("workflow catalog exposes safe Chinese workflow metadata", () => {
  const catalog = buildWorkflowDescription();
  assert.equal(catalog.count, catalog.workflows.length);
  assert.ok(catalog.workflows.some(workflow => workflow.id === "start-all"));
  assert.ok(catalog.workflows.some(workflow => workflow.name === "发布前检查"));
  assert.equal(JSON.stringify(catalog).includes("�"), false);
});

test("admin workflows route returns workflow catalog", async () => {
  const writes = [];
  const req = {
    method: "GET",
    url: "/admin/workflows",
    socket: { remoteAddress: "127.0.0.1" },
    headers: {},
  };

  const handled = await handleAdminApiRequest(req, {}, {
    pathname: "/admin/workflows",
    url: new URL("http://localhost/admin/workflows"),
    sendJson(_res, statusCode, payload) {
      writes.push({ statusCode, payload });
    },
  });

  assert.equal(handled, true);
  assert.equal(writes[0].statusCode, 200);
  assert.ok(writes[0].payload.workflows.some(workflow => workflow.id === "refresh-self-description"));
});
