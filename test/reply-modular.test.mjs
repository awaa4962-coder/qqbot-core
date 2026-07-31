import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import {
  buildReplyState,
  isMessageEvent,
  maybeGenerateProfile,
  processEvent,
  shouldGenerateProfile,
} from "../bridge/reply.mjs";
import { aiReply } from "../bridge/reply-ai.mjs";
import { handleGroupMessage } from "../bridge/reply-group.mjs";
import { handlePrivateMessage } from "../bridge/reply-private.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

describe("reply module boundaries", () => {
  it("keeps the compatibility exports available from reply.mjs", () => {
    assert.equal(typeof processEvent, "function");
    assert.equal(typeof isMessageEvent, "function");
    assert.equal(typeof buildReplyState, "function");
    assert.equal(typeof shouldGenerateProfile, "function");
    assert.equal(typeof maybeGenerateProfile, "function");
    assert.equal(typeof aiReply, "function");
    assert.equal(typeof handleGroupMessage, "function");
    assert.equal(typeof handlePrivateMessage, "function");
  });

  it("keeps reply.mjs as a thin router instead of a feature hub", () => {
    const source = fs.readFileSync(path.join(ROOT, "bridge", "reply.mjs"), "utf8");
    assert.doesNotMatch(source, /model-mimo|model-ds|model-router|jm-provider|resource-transfer/);
    assert.match(source, /reply-group\.mjs/);
    assert.match(source, /reply-private\.mjs/);
    assert.match(source, /reply-ai\.mjs/);
  });
});
