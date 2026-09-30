import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";
import { URL } from "node:url";

const source = fs.readFileSync(new URL("../launcher/QQFriendLauncher/Web/host-client.js", import.meta.url), "utf8");

test("renewed authentication never silently repeats a write or paid probe", async () => {
  const calls = [];
  let token = "synthetic-expired";
  const window = {
    sessionStorage: { getItem: () => token, setItem(_key, value) { token = value; } },
    prompt: () => "synthetic-renewed",
    async fetch(url, options) {
      calls.push({ url, options });
      return { ok: calls.length > 1, status: calls.length > 1 ? 200 : 403,
        text: async () => JSON.stringify(calls.length > 1 ? { jobId: "synthetic-job" } : { error: "forbidden" }) };
    },
  };
  vm.runInNewContext(source, { window });
  const payload = { module: "agent_tools", payload: { action: "probe" } };
  await assert.rejects(window.QQFriendHost.call("startTask", payload), error =>
    error.status === 403 && /未自动重发/.test(error.message));
  assert.equal(calls.length, 1);
  assert.equal(token, "synthetic-renewed");
  await window.QQFriendHost.call("startTask", payload);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].options.method, "POST");
  assert.equal(calls[1].options.headers["X-QQFriend-Admin-Token"], "synthetic-renewed");
  assert.deepEqual(JSON.parse(calls[1].options.body), payload);
});
