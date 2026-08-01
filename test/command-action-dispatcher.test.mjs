import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  dispatchGroupCommand,
  matchSpecialGroupAction,
} from "../bridge/commands/action-dispatcher.mjs";
import { prepareCommandText } from "../bridge/commands/normalize.mjs";

describe("unified group command actions", () => {
  it("strips the bot mention once while preserving command arguments", () => {
    assert.equal(
      prepareCommandText("@QQFriend /download https://example.com/CasePath", {
        requireMention: true,
        botNames: ["QQFriend"],
      }),
      "download https://example.com/CasePath",
    );
  });

  it("classifies specialized commands from the prepared command text", () => {
    assert.equal(matchSpecialGroupAction("jm 123456")?.id, "jm");
    assert.equal(matchSpecialGroupAction("download https://example.com/a")?.id, "resource-transfer");
    assert.equal(matchSpecialGroupAction("preview https://example.com/a")?.id, "link-preview");
    assert.equal(matchSpecialGroupAction("wordcloud 7d")?.id, "wordcloud");
    assert.equal(matchSpecialGroupAction("help"), null);
  });

  it("dispatches catalog commands through the same mention-gated entry", async () => {
    const sent = [];
    const recorded = [];
    const handled = await dispatchGroupCommand({
      isAtMe: true,
      text: "@QQFriend ping",
      rawText: "@QQFriend ping",
      user_id: 42,
      group_id: 100,
      message_id: 7,
      mentions: [],
      mentionedUsers: [],
    }, {
      botNames: ["QQFriend"],
      sender: async (...args) => sent.push(args),
      recordCommand: (...args) => recorded.push(args),
    });

    assert.equal(handled, true);
    assert.deepEqual(sent[0], [100, "pong", 7]);
    assert.equal(recorded.length, 1);

    assert.equal(await dispatchGroupCommand({
      isAtMe: false,
      text: "ping",
      user_id: 42,
      group_id: 100,
    }), false);
  });
});
