import test from "node:test";
import assert from "node:assert/strict";
import { createDefaultApiConfig } from "../bridge/api-providers/store.mjs";
import { readApiProviderHealth } from "../bridge/api-providers/health.mjs";

test("model health shares configured primary and fallback state without claiming connectivity", () => {
  const config = createDefaultApiConfig();
  const readSecret = provider => provider.id === "deepseek" ? "synthetic-only-secret" : "";
  const snapshot = readApiProviderHealth({ config, readSecret });
  assert.equal(snapshot.configurationOnly, true);
  assert.equal(snapshot.tasks.group_chat.primary.ready, false);
  assert.equal(snapshot.tasks.group_chat.fallback.ready, true);
  assert.equal(snapshot.tasks.group_chat.ready, true);
  assert.equal(snapshot.tasks.vision.ready, false);
  assert.ok(snapshot.issues.includes("group_chat:primary_credentials_missing"));
  assert.equal(JSON.stringify(snapshot).includes("synthetic-only-secret"), false);
  assert.equal(JSON.stringify(snapshot).includes("https://"), false);
});

test("model health handles disabled providers and missing vision capabilities", () => {
  const config = createDefaultApiConfig();
  config.providers.mimo.capabilities = ["text"];
  config.providers.deepseek.enabled = false;
  const state = readApiProviderHealth({ config, readSecret: () => "synthetic" });
  assert.equal(state.tasks.vision.primary.reason, "not_multimodal");
  assert.equal(state.tasks.private_chat.primary.reason, "unavailable");
});

test("configuration errors in readiness never disclose exception text or secret paths", () => {
  const config = createDefaultApiConfig();
  const snapshot = readApiProviderHealth({ config, readSecret() { throw new Error("secret-file-path"); } });
  assert.equal(snapshot.tasks.group_chat.ready, false);
  assert.equal(JSON.stringify(snapshot).includes("secret-file-path"), false);
});

test("configuration readiness rejects an unsafe endpoint without making requests", () => {
  const config = createDefaultApiConfig();
  config.providers.mimo.endpoint = "http://127.0.0.1:1234/chat/completions";
  config.providers.mimo.allowLocal = false;
  const snapshot = readApiProviderHealth({ config, readSecret: () => "synthetic" });
  assert.equal(snapshot.tasks.group_chat.primary.ready, false);
});
