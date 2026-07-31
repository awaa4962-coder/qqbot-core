import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import {
  buildMemorySummary,
  buildHumanMemorySummary,
  clearGroupMemoryProfile,
  clearUserMemoryProfile,
  getActiveMemoryContext,
  getMemoryStatus,
  isSensitiveMemoryText,
  memoryProfiles,
  observeMemoryEvent,
} from "../bridge/memory-profile.mjs";

function resetProfiles() {
  memoryProfiles.userProfiles = {};
  memoryProfiles.groupProfiles = {};
  memoryProfiles.userGroupProfiles = {};
}

describe("memory profile", () => {
  beforeEach(resetProfiles);

  it("rejects sensitive text before creating profile evidence", () => {
    assert.equal(isSensitiveMemoryText("api_key=sk-test-secret-value-123456789"), true);
    const result = observeMemoryEvent({
      uid: 1001,
      groupId: 2001,
      nickname: "tester",
      text: "api_key=sk-test-secret-value-123456789",
    });
    assert.equal(result, null);
    assert.deepEqual(getMemoryStatus(), { users: 0, groups: 0, userGroups: 0 });
  });

  it("keeps low confidence profiles inactive until there is enough evidence", () => {
    observeMemoryEvent({ uid: 1001, groupId: 2001, nickname: "tester", text: "hello world" }, { now: 1000 });
    assert.equal(getActiveMemoryContext(1001, 2001, { now: 2000 }).userProfile, null);

    observeMemoryEvent({ uid: 1001, groupId: 2001, nickname: "tester", text: "jm download failed again" }, { now: 3000 });
    const ctx = getActiveMemoryContext(1001, 2001, { now: 4000 });
    assert.ok(ctx.userProfile);
    assert.ok(ctx.userGroupProfile);
    assert.match(buildMemorySummary(1001, 2001, { now: 4000 }), /confidence=/);
    const humanSummary = buildHumanMemorySummary(1001, 2001, { now: 4000 });
    assert.match(humanSummary, /可信度：/);
    assert.doesNotMatch(humanSummary, /preferredTone=|confidence=|commonTopics=/);
  });

  it("expires and clears memory profiles", () => {
    observeMemoryEvent({ uid: 1001, groupId: 2001, nickname: "tester", text: "jm download failed again" }, { now: 1000 });
    observeMemoryEvent({ uid: 1001, groupId: 2001, nickname: "tester", text: "jm download still broken" }, { now: 2000 });
    assert.equal(getMemoryStatus(3000).users, 1);

    const farFuture = 35 * 24 * 60 * 60 * 1000;
    assert.equal(getActiveMemoryContext(1001, 2001, { now: farFuture }).userProfile, null);

    assert.equal(clearUserMemoryProfile(1001), true);
    assert.equal(getMemoryStatus(3000).users, 0);
    clearGroupMemoryProfile(2001);

    observeMemoryEvent({ uid: 1002, groupId: 2002, nickname: "tester2", text: "QQFriend are you there" }, { now: 5000 });
    assert.equal(getMemoryStatus(6000).groups, 1);
    assert.equal(clearGroupMemoryProfile(2002), true);
    assert.equal(getMemoryStatus(6000).groups, 0);
  });

  it("does not treat laughter as permission for more interjections", () => {
    observeMemoryEvent({
      uid: 1001,
      groupId: 2001,
      nickname: "tester",
      text: "哈哈笑死，这个梗太乐了",
    }, { now: 1000 });

    const profile = getActiveMemoryContext(1001, 2001, { now: 2000 }).groupProfile;
    assert.equal(profile.tone, "playful");
    assert.equal(profile.jokeLevel, "high");
    assert.equal(profile.interjectionTolerance, "normal");
  });

  it("changes interjection tolerance only from explicit group intent", () => {
    observeMemoryEvent({
      uid: 1001,
      groupId: 2001,
      nickname: "tester",
      text: "夜星可以多插话，多聊两句",
    }, { now: 1000 });
    assert.equal(
      getActiveMemoryContext(1001, 2001, { now: 2000 }).groupProfile.interjectionTolerance,
      "high"
    );

    observeMemoryEvent({
      uid: 1002,
      groupId: 2001,
      nickname: "tester2",
      text: "别瞎回我，再回我就禁言",
    }, { now: 3000 });
    assert.equal(
      getActiveMemoryContext(1002, 2001, { now: 4000 }).groupProfile.interjectionTolerance,
      "low"
    );
  });

  it("expires explicit tolerance and ignores legacy inferred high values", () => {
    const day = 24 * 60 * 60 * 1000;
    observeMemoryEvent({
      uid: 1001,
      groupId: 2001,
      nickname: "tester",
      text: "欢迎夜星多接话",
    }, { now: 1000 });
    observeMemoryEvent({
      uid: 1002,
      groupId: 2001,
      nickname: "tester2",
      text: "普通消息保持群画像活跃",
    }, { now: 8 * day });
    assert.equal(
      getActiveMemoryContext(1001, 2001, { now: 8 * day + 1 }).groupProfile.interjectionTolerance,
      "normal"
    );

    memoryProfiles.groupProfiles["legacy"] = {
      groupId: "legacy",
      tone: "playful",
      jokeLevel: "high",
      interjectionTolerance: "high",
      updatedAt: 1000,
      expiresAt: 30 * day,
    };
    assert.equal(
      getActiveMemoryContext(1001, "legacy", { now: 2000 }).groupProfile.interjectionTolerance,
      "normal"
    );
  });
});
