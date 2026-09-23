import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { callAnthropicMessages } from "../bridge/api-providers/adapters/anthropic-messages.mjs";
import { callOpenAiResponses } from "../bridge/api-providers/adapters/openai-responses.mjs";
import { redactProviderPayload } from "../bridge/api-providers/request-privacy.mjs";
import { buildOutputPacket } from "../bridge/output-pipeline.mjs";

const secret = "sk-synthetic-protocol-credential";
const opaque = "sk-synthetic-opaque-signature-" + "A+/=".repeat(4096);
const tools = [{ type: "function", function: {
  name: "lookup", description: "Look up a synthetic record",
  parameters: { type: "object", properties: { query: { type: "string" } } },
} }];
const user = { role: "user", content: "Compare the records" };

function provider(protocol) {
  return {
    id: "synthetic-" + protocol, name: "Synthetic protocol test", protocol,
    endpoint: "https://example.com/v1/" + (protocol === "anthropic-messages" ? "messages" : "responses"),
    model: "synthetic-model", auth: "none", capabilities: ["text", "tools", "reasoning"],
  };
}

function mockTransport(t, responses) {
  const bodies = [];
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    assert.equal(options.method, "POST");
    assert.equal(options.redirect, "error");
    const response = responses[bodies.length];
    assert.ok(response, "unexpected transport request");
    bodies.push(JSON.parse(options.body));
    return { ok: true, status: 200, text: async () => JSON.stringify(response) };
  });
  return bodies;
}

function anthropicCall(id, input = { query: id }) {
  return { type: "tool_use", id, name: "lookup", input };
}

function responsesCall(id, args = { query: id }) {
  return { type: "function_call", id: "fc_" + id, call_id: id, name: "lookup", arguments: JSON.stringify(args), status: "completed" };
}

function responseMessage(text, id = "msg_answer") {
  return { type: "message", id, role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] };
}

function toolResult(id, content = "Found " + id) {
  return { role: "tool", tool_call_id: id, content };
}

function assistant(result) {
  assert.equal(result.ok, true);
  return result.raw.choices[0].message;
}

describe("Anthropic tool protocol round trips", () => {
  it("replays signed blocks and parallel results across two rounds without exposing internal state", async t => {
    const native = [
      { type: "thinking", thinking: "private reasoning marker", signature: opaque },
      { type: "redacted_thinking", data: opaque + "redacted" },
      { type: "text", text: "Checking records" },
      anthropicCall("call_a"), anthropicCall("call_b"),
    ];
    const next = [{ type: "thinking", thinking: "", signature: opaque + "next" }, anthropicCall("call_c")];
    const bodies = mockTransport(t, [
      { content: native, stop_reason: "tool_use" },
      { content: next, stop_reason: "tool_use" },
      { content: [{ type: "thinking", thinking: "final private marker", signature: opaque }, { type: "text", text: "Records compared." }], stop_reason: "end_turn" },
    ]);
    const api = provider("anthropic-messages");
    const history = [user];
    const first = await callAnthropicMessages(api, "", { messages: history, tools, toolChoice: "auto" });
    const message = assistant(first);
    assert.deepEqual(message.providerContinuation, { protocol: api.protocol, items: native });
    assert.notEqual(message.providerContinuation.items, native);
    assert.deepEqual(message.tool_calls.map(call => call.id), ["call_a", "call_b"]);
    assert.equal(message.content, "Checking records");
    const packet = buildOutputPacket(first.raw);
    assert.equal(packet.text, "Checking records");
    assert.equal(JSON.stringify(packet).includes("providerContinuation"), false);
    assert.equal(JSON.stringify(packet).includes("private reasoning marker"), false);
    assert.equal(JSON.stringify(packet).includes(opaque), false);
    history.push(redactProviderPayload({ messages: [message] }).messages[0], toolResult("call_a"), { ...toolResult("call_b"), is_error: true });
    const second = await callAnthropicMessages(api, "", { messages: history, tools });
    history.push(assistant(second), toolResult("call_c"));
    const final = await callAnthropicMessages(api, "", {
      messages: history, tools: [], toolChoice: "none",
      extra: { tools: [{ name: "must_not_run" }], tool_choice: { type: "any" } },
    });
    assert.deepEqual(bodies[0].tool_choice, { type: "auto" });
    assert.deepEqual(bodies[1].messages[1], { role: "assistant", content: native });
    assert.deepEqual(bodies[1].messages[2], { role: "user", content: [
      { type: "tool_result", tool_use_id: "call_a", content: "Found call_a" },
      { type: "tool_result", tool_use_id: "call_b", content: "Found call_b", is_error: true },
    ] });
    assert.deepEqual(bodies[2].messages.slice(0, 3), bodies[1].messages);
    assert.deepEqual(bodies[2].messages[3], { role: "assistant", content: next });
    assert.equal(bodies[2].messages[4].content[0].tool_use_id, "call_c");
    assert.equal("tools" in bodies[2], false);
    assert.equal("tool_choice" in bodies[2], false);
    assert.equal(JSON.stringify(bodies).includes("providerContinuation"), false);
    assert.equal(buildOutputPacket(final.raw).text, "Records compared.");
    assert.equal("providerContinuation" in assistant(final), false);
  });

  it("redacts ordinary text, arguments and results but never edits opaque signature/data", async t => {
    const native = [
      { type: "thinking", thinking: "safe signed thinking", signature: opaque },
      { type: "redacted_thinking", data: opaque },
      { type: "text", text: secret }, anthropicCall("call_a", { query: secret, nested: { password: "synthetic" } }),
    ];
    const bodies = mockTransport(t, [{ content: native }, { content: [{ type: "text", text: "Done." }] }]);
    const api = provider("anthropic-messages");
    const first = await callAnthropicMessages(api, "", { messages: [user], tools });
    const message = assistant(first);
    assert.deepEqual(JSON.parse(message.tool_calls[0].function.arguments), { query: "[REDACTED]", nested: { password: "[REDACTED]" } });
    await callAnthropicMessages(api, "", { messages: [user, message, toolResult("call_a", "password=synthetic")], tools: [] });
    const blocks = bodies[1].messages[1].content;
    assert.deepEqual(blocks.slice(0, 2), native.slice(0, 2));
    assert.equal(blocks[2].text, "[REDACTED]");
    assert.equal(blocks[3].input.query, "[REDACTED]");
    assert.equal(bodies[1].messages[2].content[0].content, "password=[REDACTED]");
    assert.equal(native[2].text, secret);
  });

  it("maps explicit none and forced choices when tools are present", async t => {
    const choices = ["none", "required", { type: "function", function: { name: "lookup" } }];
    const bodies = mockTransport(t, choices.map(() => ({ content: [{ type: "text", text: "Done." }] })));
    for (const toolChoice of choices) await callAnthropicMessages(provider("anthropic-messages"), "", { messages: [user], tools, toolChoice });
    assert.deepEqual(bodies.map(body => body.tool_choice), [{ type: "none" }, { type: "any" }, { type: "tool", name: "lookup" }]);
  });

  it("does not insert an empty text block into legacy tool-only assistant messages", async t => {
    const bodies = mockTransport(t, [{ content: [{ type: "text", text: "Done." }] }]);
    await callAnthropicMessages(provider("anthropic-messages"), "", {
      messages: [user, { role: "assistant", content: null, tool_calls: [{ id: "a", function: { name: "lookup", arguments: "{}" } }] }, toolResult("a")], tools: [],
    });
    assert.deepEqual(bodies[0].messages[1].content, [anthropicCall("a", {})]);
  });
});

describe("Responses tool protocol round trips", () => {
  it("replays all ordered reasoning/message/call items using call_id, not item id", async t => {
    const native = [
      { type: "reasoning", id: "rs_1", summary: [{ type: "summary_text", text: "private summary marker" }], encrypted_content: opaque },
      responseMessage("Checking records", "msg_preamble"), responsesCall("call_a"), responsesCall("call_b"),
    ];
    const next = [{ type: "reasoning", id: "rs_2", summary: [], encrypted_content: opaque + "next" }, responsesCall("call_c")];
    const bodies = mockTransport(t, [
      { id: "resp_1", output: native }, { id: "resp_2", output: next },
      { output: [{ type: "reasoning", id: "rs_final", summary: [], encrypted_content: opaque }, responseMessage("Records compared.")] },
    ]);
    const api = provider("openai-responses");
    const history = [user];
    const first = await callOpenAiResponses(api, "", { messages: history, tools, extra: { include: ["message.output_text.logprobs"] } });
    const message = assistant(first);
    assert.deepEqual(message.providerContinuation, { protocol: api.protocol, items: native });
    assert.deepEqual(message.tool_calls.map(call => call.id), ["call_a", "call_b"]);
    const packet = buildOutputPacket(first.raw);
    assert.equal(packet.text, "Checking records");
    for (const privateValue of ["providerContinuation", "private summary marker", opaque, "fc_call_a"]) {
      assert.equal(JSON.stringify(packet).includes(privateValue), false);
    }
    history.push(redactProviderPayload({ messages: [message] }).messages[0], toolResult("call_a"), toolResult("call_b"));
    const second = await callOpenAiResponses(api, "", { messages: history, tools });
    history.push(assistant(second), toolResult("call_c"));
    const final = await callOpenAiResponses(api, "", {
      messages: history, tools: [], toolChoice: "none",
      extra: { tools: [{ type: "function", name: "must_not_run" }], tool_choice: "required" },
    });
    assert.equal(bodies[0].store, false);
    assert.deepEqual(bodies[0].include, ["message.output_text.logprobs", "reasoning.encrypted_content"]);
    assert.deepEqual(bodies[1].input, [user, ...native,
      { type: "function_call_output", call_id: "call_a", output: "Found call_a" },
      { type: "function_call_output", call_id: "call_b", output: "Found call_b" },
    ]);
    assert.deepEqual(bodies[2].input, [...bodies[1].input, ...next,
      { type: "function_call_output", call_id: "call_c", output: "Found call_c" },
    ]);
    assert.equal("tools" in bodies[2], false);
    assert.equal(bodies[2].tool_choice, "none");
    assert.equal(JSON.stringify(bodies).includes("providerContinuation"), false);
    assert.equal(buildOutputPacket(final.raw).text, "Records compared.");
    assert.equal("providerContinuation" in assistant(final), false);
  });

  it("sanitizes native text/summary/refusal and structured arguments but preserves encrypted context", async t => {
    const native = [
      { type: "reasoning", id: "rs_1", summary: [{ type: "summary_text", text: secret }], encrypted_content: opaque,
        content: [{ type: "reasoning_text", text: "password=synthetic" }] },
      responseMessage(secret),
      { ...responseMessage("unused", "msg_refusal"), content: [{ type: "refusal", refusal: secret }] },
      responsesCall("call_a", { query: secret, nested: { token: 123 } }),
    ];
    const bodies = mockTransport(t, [{ output: native }, { output: [responseMessage("Done.")] }]);
    const api = provider("openai-responses");
    const first = await callOpenAiResponses(api, "", { messages: [user], tools });
    await callOpenAiResponses(api, "", { messages: [user, assistant(first), toolResult("call_a", "password=synthetic")], tools: [] });
    const replay = bodies[1].input.slice(1);
    assert.equal(replay[0].encrypted_content, opaque);
    assert.equal(replay[0].summary[0].text, "[REDACTED]");
    assert.equal(replay[0].content[0].text, "password=[REDACTED]");
    assert.equal(replay[1].content[0].text, "[REDACTED]");
    assert.equal(replay[2].content[0].refusal, "[REDACTED]");
    assert.equal(replay[3].id, "fc_call_a");
    assert.equal(replay[3].call_id, "call_a");
    assert.deepEqual(JSON.parse(replay[3].arguments), { query: "[REDACTED]", nested: { token: "[REDACTED]" } });
    assert.equal(replay[4].output, "password=[REDACTED]");
    assert.equal(native[0].summary[0].text, secret);
  });
});

for (const [protocol, call, nativeCall, finalResponse] of [
  ["anthropic-messages", callAnthropicMessages, anthropicCall, { content: [{ type: "text", text: "Done." }] }],
  ["openai-responses", callOpenAiResponses, responsesCall, { output: [responseMessage("Done.")] }],
]) {
  describe(protocol + " continuation guards", () => {
    const response = items => protocol === "anthropic-messages" ? { content: items } : { output: items };
    const historyMessage = items => ({ role: "assistant", content: null, providerContinuation: { protocol, items } });

    it("ignores foreign protocol metadata and retains only normalized history", async t => {
      const bodies = mockTransport(t, [finalResponse]);
      const foreignProtocol = protocol === "anthropic-messages" ? "openai-responses" : "anthropic-messages";
      const foreign = { role: "assistant", content: "Prior answer", providerContinuation: { protocol: foreignProtocol, items: [{ signature: opaque }] } };
      await call(provider(protocol), "", { messages: [user, foreign, user], tools: [] });
      assert.equal(JSON.stringify(bodies[0]).includes(opaque), false);
      assert.equal(JSON.stringify(bodies[0]).includes("Prior answer"), true);
    });

    it("rejects missing, duplicate and orphaned results before transport", async t => {
      const bodies = mockTransport(t, [finalResponse]);
      const message = historyMessage([nativeCall("a"), nativeCall("b")]);
      for (const results of [[], [toolResult("a")], [toolResult("a"), toolResult("a")], [toolResult("a"), toolResult("x")]]) {
        await assert.rejects(call(provider(protocol), "", { messages: [user, message, ...results], tools: [] }), /tool result/);
      }
      await assert.rejects(call(provider(protocol), "", { messages: [user, toolResult("a")], tools: [] }), /tool result/);
      assert.equal(bodies.length, 0);
    });

    it("rejects malformed and oversized continuation without truncating or printing opaque state", async t => {
      const bodies = mockTransport(t, [finalResponse]);
      const invalid = [null, {}, [], [null], [{ type: "unsupported", text: secret }], Array.from({ length: 257 }, () => nativeCall("a"))];
      const large = protocol === "anthropic-messages"
        ? { type: "thinking", thinking: "", signature: opaque.repeat(65) }
        : { type: "reasoning", id: "rs_1", summary: [], encrypted_content: opaque.repeat(65) };
      invalid.push([large, nativeCall("a")]);
      for (const items of invalid) {
        await assert.rejects(call(provider(protocol), "", { messages: [user, historyMessage(items), toolResult("a")], tools: [] }), error => {
          assert.match(error.message, /provider continuation/);
          assert.equal(error.message.includes(secret), false);
          assert.equal(error.message.includes(opaque), false);
          return true;
        });
      }
      assert.equal(bodies.length, 0);
    });

    it("rejects duplicate native call IDs before any tool can execute", async t => {
      mockTransport(t, [response([nativeCall("a"), nativeCall("a")])]);
      await assert.rejects(call(provider(protocol), "", { messages: [user], tools }), /tool call IDs/);
    });

    it("rejects malformed native response shapes before exposing executable calls", async t => {
      const invalidItems = protocol === "anthropic-messages"
        ? [[{ type: "thinking", thinking: "missing signature" }, nativeCall("a")], [nativeCall("a", [])]]
        : [[{ type: "reasoning", id: "rs_1", summary: {}, encrypted_content: opaque }, nativeCall("a")], [{ ...nativeCall("a"), call_id: undefined }]];
      mockTransport(t, invalidItems.map(response));
      for (let index = 0; index < invalidItems.length; index++) {
        await assert.rejects(call(provider(protocol), "", { messages: [user], tools }), /Invalid .*provider continuation/);
      }
    });

    it("rejects a provider attempting an extra action when tools are empty or explicitly disabled", async t => {
      const bodies = mockTransport(t, [response([nativeCall("extra")]), response([nativeCall("extra")])]);
      for (const allowedTools of [[], tools]) {
        await assert.rejects(call(provider(protocol), "", { messages: [user], tools: allowedTools, toolChoice: "none" }), /tools are disabled/);
      }
      assert.equal("tools" in bodies[0], false);
      assert.ok(bodies[1].tools.length);
    });
  });
}

it("rejects sensitive signed thinking and malformed Anthropic tool arguments with generic errors", async t => {
  mockTransport(t, [{ content: [{ type: "thinking", thinking: secret, signature: opaque }, anthropicCall("a")] }]);
  await assert.rejects(callAnthropicMessages(provider("anthropic-messages"), "", { messages: [user], tools }),
    { message: "Sensitive text in signed Anthropic thinking" });
  for (const args of ['{"query":"' + secret, "null", "[]"]) {
    await assert.rejects(callAnthropicMessages(provider("anthropic-messages"), "", {
      messages: [user, { role: "assistant", content: null, tool_calls: [{ id: "a", function: { name: "lookup", arguments: args } }] }, toolResult("a")], tools: [],
    }), { message: "Invalid Anthropic tool arguments" });
  }
});
