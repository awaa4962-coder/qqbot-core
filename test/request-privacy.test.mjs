import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { redactProviderPayload } from "../bridge/api-providers/request-privacy.mjs";
import { postProviderJson } from "../bridge/api-providers/transport.mjs";

const secret = "sk-synthetic-legacy-credential";
const imageUrl = "https://example.com/image?token=synthetic-image-token";

describe("provider request text privacy", () => {
  it("redacts Chat text and structured tool arguments without changing images, IDs or routing", () => {
    const body = {
      model: secret, tool_choice: "auto",
      messages: [
        { role: "user", content: [{ type: "text", text: "old " + secret }, { type: "image_url", image_url: { url: imageUrl } }] },
        { role: "assistant", content: null, reasoning_content: "password=old-password", tool_calls: [{
          id: "call_unchanged", type: "function", function: { name: "web_search", arguments: JSON.stringify({ query: secret, token: 12345678, nested: { password: "old-password" }, count: 2 }) },
        }] },
      ],
    };
    const clean = redactProviderPayload(body);
    assert.equal(clean.model, secret);
    assert.equal(clean.tool_choice, "auto");
    assert.equal(clean.messages[0].content[1].image_url.url, imageUrl);
    assert.equal(clean.messages[0].content[0].text.includes(secret), false);
    assert.equal(body.messages[0].content[0].text, "old " + secret);
    const call = clean.messages[1].tool_calls[0];
    assert.equal(call.id, "call_unchanged");
    assert.equal(call.function.name, "web_search");
    assert.deepEqual(JSON.parse(call.function.arguments), { query: "[REDACTED]", token: "[REDACTED]", nested: { password: "[REDACTED]" }, count: 2 });
    assert.equal(clean.messages[1].reasoning_content, "password=[REDACTED]");
  });

  it("redacts Responses, Anthropic and Gemini text while preserving native image and signature fields", () => {
    const responses = redactProviderPayload({ instructions: secret, input: [
      { role: "user", content: [{ type: "input_text", text: secret }, { type: "input_image", image_url: imageUrl }] },
      { type: "function_call", call_id: "call_1", arguments: JSON.stringify({ token: "legacy" }) },
      { type: "function_call_output", call_id: "call_1", output: "password=legacy" },
      { type: "reasoning", encrypted_content: secret },
    ] });
    assert.equal(responses.instructions, "[REDACTED]");
    assert.equal(responses.input[0].content[1].image_url, imageUrl);
    assert.deepEqual(JSON.parse(responses.input[1].arguments), { token: "[REDACTED]" });
    assert.equal(responses.input[1].call_id, "call_1");
    assert.equal(responses.input[2].output, "password=[REDACTED]");
    assert.equal(responses.input[3].encrypted_content, secret);
    const anthropic = redactProviderPayload({ system: [{ type: "text", text: secret }], messages: [{ role: "user", content: [
      { type: "text", text: secret }, { type: "image", source: { type: "base64", data: secret } },
      { type: "tool_result", tool_use_id: "tool_1", content: "password=legacy" },
    ] }] });
    assert.equal(anthropic.system[0].text, "[REDACTED]");
    assert.equal(anthropic.messages[0].content[1].source.data, secret);
    assert.equal(anthropic.messages[0].content[2].tool_use_id, "tool_1");
    assert.equal(anthropic.messages[0].content[2].content, "password=[REDACTED]");
    const gemini = redactProviderPayload({ systemInstruction: { parts: [{ text: secret }] }, contents: [{ role: "user", parts: [
      { text: secret }, { inlineData: { mimeType: "image/png", data: secret } },
    ] }] });
    assert.equal(gemini.systemInstruction.parts[0].text, "[REDACTED]");
    assert.equal(gemini.contents[0].parts[0].text, "[REDACTED]");
    assert.equal(gemini.contents[0].parts[1].inlineData.data, secret);
  });

  it("redacts at transport without altering the authentication key", async () => {
    const previous = globalThis.fetch;
    let seen;
    globalThis.fetch = async (_url, options) => {
      seen = options;
      return { ok: true, status: 200, text: async () => "{}" };
    };
    try {
      await postProviderJson({ name: "synthetic", endpoint: "https://example.com/v1/chat/completions", auth: "bearer" }, "test-auth-key", {
        messages: [{ role: "user", content: secret }],
      });
      assert.equal(seen.headers.Authorization, "Bearer test-auth-key");
      assert.equal(JSON.parse(seen.body).messages[0].content, "[REDACTED]");
    } finally {
      globalThis.fetch = previous;
    }
  });
});
