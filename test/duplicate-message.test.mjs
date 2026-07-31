import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import {
  normalizeDuplicateText,
  observeGroupDuplicate,
  resetDuplicateMessageState,
} from "../bridge/duplicate-message.mjs";

describe("duplicate group message guard", () => {
  beforeEach(() => {
    resetDuplicateMessageState();
  });

  it("normalizes repeated text variants into one duplicate key", () => {
    assert.equal(normalizeDuplicateText(" 芭比Q了！！！ "), "芭比q了");
    assert.equal(normalizeDuplicateText("[CQ:at,qq=1] 芭 比 Q 了"), "芭比q了");
  });

  it("marks the third repeated group text as duplicate", () => {
    assert.equal(observeGroupDuplicate({ groupId: 1, uid: 11, text: "启动" }, { now: 1 }).duplicate, false);
    assert.equal(observeGroupDuplicate({ groupId: 1, uid: 12, text: "启动！" }, { now: 2 }).duplicate, false);
    const third = observeGroupDuplicate({ groupId: 1, uid: 13, text: "启动！！！" }, { now: 3 });

    assert.equal(third.duplicate, true);
    assert.equal(third.reason, "group_repeat");
    assert.equal(third.previousCount, 2);
  });

  it("marks fast same-user repeats as duplicate", () => {
    assert.equal(observeGroupDuplicate({ groupId: 1, uid: 11, text: "复读一下" }, { now: 1000 }).duplicate, false);
    const repeated = observeGroupDuplicate({ groupId: 1, uid: 11, text: "复读一下" }, { now: 2000 });

    assert.equal(repeated.duplicate, true);
    assert.equal(repeated.reason, "same_user_repeat");
  });

  it("keeps bot mentions and media out of the duplicate guard", () => {
    observeGroupDuplicate({ groupId: 1, uid: 11, text: "help" }, { now: 1 });
    assert.equal(observeGroupDuplicate({ groupId: 1, uid: 11, text: "help" }, { now: 2 }).duplicate, false);

    observeGroupDuplicate({ groupId: 1, uid: 11, text: "夜星 help", isAtMe: true }, { now: 3 });
    assert.equal(observeGroupDuplicate({ groupId: 1, uid: 11, text: "夜星 help", isAtMe: true }, { now: 4 }).duplicate, false);

    observeGroupDuplicate({ groupId: 1, uid: 11, text: "同图", hasImages: true }, { now: 5 });
    assert.equal(observeGroupDuplicate({ groupId: 1, uid: 11, text: "同图", hasImages: true }, { now: 6 }).duplicate, false);
  });
});
