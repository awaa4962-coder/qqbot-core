import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { buildReplyState, isMessageEvent } from "../bridge/reply.mjs";

describe("group reply state", () => {
  it("uses replied message as context but replies to current trigger message", async () => {
    const ctx = {
      message_id: 222,
      replyData: { id: 111 },
    };
    const state = await buildReplyState(ctx, async value => {
      assert.equal(value.replyData.id, 111);
      return "quoted context";
    });

    assert.equal(state.replyText, "quoted context");
    assert.equal(state.replyToId, 222);
  });

  it("rate limiting only applies to message events", () => {
    assert.equal(isMessageEvent({ message_type: "group" }), true);
    assert.equal(isMessageEvent({ message_type: "private" }), true);
    assert.equal(isMessageEvent({ post_type: "meta_event", message_type: undefined }), false);
    assert.equal(isMessageEvent({ post_type: "notice" }), false);
  });
});
