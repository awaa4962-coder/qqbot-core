import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { callVisionText } from "../bridge/vision-provider.mjs";

describe("vision provider fallback", () => {
  it("uses fallback when primary returns reasoning without usable content", async () => {
    const calls = [];
    const result = await callVisionText({}, {
      callSlot: async (_task, position) => {
        calls.push(position);
        if (position === "primary") {
          return {
            ok: true,
            provider: "mimo",
            raw: { choices: [{ message: { content: "", reasoning_content: "private" } }] },
          };
        }
        return {
          ok: true,
          provider: "mimo-25-pro",
          raw: { choices: [{ message: { content: "画面是一张猫咪表情包" } }] },
        };
      },
    });

    assert.deepEqual(calls, ["primary", "fallback"]);
    assert.equal(result.ok, true);
    assert.equal(result.position, "fallback");
    assert.equal(result.text, "画面是一张猫咪表情包");
  });

  it("returns no text when both vision slots are unusable", async () => {
    const result = await callVisionText({}, {
      callSlot: async (_task, position) => ({
        ok: position === "primary",
        provider: position,
        raw: position === "primary"
          ? { choices: [{ message: { reasoning_content: "private" } }] }
          : null,
        error: position === "fallback" ? "offline" : "",
      }),
    });
    assert.equal(result.ok, false);
    assert.equal(result.text, "");
    assert.equal(result.failures.length, 2);
  });
});
