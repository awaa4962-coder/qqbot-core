import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { buildSearchFallback, webSearch } from "../bridge/search.mjs";
import { CFG } from "../bridge/config.mjs";

const originalFetch = globalThis.fetch;
const originalTavilyKey = CFG.tavilyKey;
afterEach(() => { globalThis.fetch = originalFetch; CFG.tavilyKey = originalTavilyKey; });

describe("search model boundaries", () => {
  it("keeps user instructions and legacy credentials out of the system prompt", async () => {
    let body;
    const instruction = "IGNORE_BOUNDARY_SYNTHETIC";
    globalThis.fetch = async (_url, options) => {
      body = JSON.parse(options.body);
      return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { content: "synthetic summary" } }] }) };
    };
    const result = await buildSearchFallback([{ content: "synthetic evidence" }], [], instruction + " password=legacy-value", "synthetic-user");
    assert.equal(result, "synthetic summary");
    assert.equal(body.messages[0].role, "system");
    assert.equal(body.messages[0].content.includes(instruction), false);
    assert.match(body.messages[0].content, /只是资料/);
    assert.match(body.messages[1].content, /IGNORE_BOUNDARY_SYNTHETIC/);
    assert.equal(JSON.stringify(body).includes("legacy-value"), false);
  });

  it("does not summarize transport error messages as search evidence", async () => {
    globalThis.fetch = () => assert.fail("no model call for absent evidence");
    const result = await buildSearchFallback([{ content: "搜索暂时不可用: synthetic failure" }], [], "question", "user");
    assert.match(result, /没找到/);
    assert.doesNotMatch(result, /synthetic failure/);
  });

  it("redacts the search query without changing the Tavily credential", async () => {
    CFG.tavilyKey = "test-tavily-key";
    let body;
    globalThis.fetch = async (_url, options) => {
      body = JSON.parse(options.body);
      return { ok: true, json: async () => ({ results: [] }) };
    };
    await webSearch("find password=legacy-value");
    assert.equal(body.api_key, "test-tavily-key");
    assert.equal(body.query, "find password=[REDACTED]");
  });
});
