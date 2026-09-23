import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { after, test } from "node:test";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "qqfriend-source-frames-"));
Object.assign(process.env, { QQBOT_CONFIG_ROOT: root, QQBOT_DATA_DIR: path.join(root, "data"),
  QQBOT_LOG_DIR: path.join(root, "logs"), NODE_ENV: "test" });
const { CFG } = await import("../bridge/config.mjs");
const { buildHistoricalSourceFrame } = await import("../bridge/context/messages.mjs");
const { selectionSource } = await import("../bridge/context/conversation-selection.mjs");
const { assignContextGroups } = await import("../bridge/context/source-groups.mjs");
const { buildInterjectionBackgroundBlock, buildLayeredReplyContext } = await import("../bridge/context-retriever.mjs");
const { buildReplyContextPacket } = await import("../bridge/context/assemble.mjs");
const { memoryNotesSnapshot, applyMemoryNoteAction } = await import("../bridge/memory-profile/notes.mjs");
const { users, groupChats } = await import("../bridge/storage.mjs");

after(() => {
  const temp = path.resolve(os.tmpdir()) + path.sep;
  assert.ok(path.resolve(root).startsWith(temp));
  fs.rmSync(root, { recursive: true, force: true });
});

test("historical frame keeps author, timestamp, safe ids and a marked excerpt together", () => {
  const frame = buildHistoricalSourceFrame({
    nickname: "同名",
    uid: "not-a-numeric-user-id",
    messageId: "opaque-message-id",
    replyToMessageId: "opaque-parent-id",
    turnId: "opaque-turn-id",
    ts: 1700000000000,
    text: "修复结论。" + "细节".repeat(80),
  }, "[群聊背景，仅供理解，不要复述]", { maxTextChars: 48, parentProvided: false });

  assert.match(frame.content, /speaker=同名$/m);
  assert.match(frame.content, /message_id=unknown/);
  assert.match(frame.content, /replyToMessageId=本轮未提供/);
  assert.match(frame.content, /turnId=unknown/);
  assert.match(frame.content, /message=.*已截短/);
  assert.doesNotMatch(frame.content, /opaque-|not-a-numeric/);
  assert.equal(frame.clipped, true);
});

test("missing legacy metadata is explicit unknown and does not fabricate reply linkage", () => {
  const frame = buildHistoricalSourceFrame({ nickname: "unknown", text: "旧记录" }, "[历史原话]");
  assert.match(frame.content, /message_id=unknown time=unknown replyToMessageId=unknown turnId=unknown/);
  assert.match(frame.content, /原存档文本完整性=未知（仅存档文字）/);
  assert.equal(frame.completeness, "unknown");
  assert.equal(frame.clipped, false);
});

test("archive completeness uses reliable raw stored-text length and excerpt clipping stays separate", () => {
  const completeText = "a  b";
  const complete = buildHistoricalSourceFrame({ text: completeText, textTruncated: false, textChars: completeText.length }, "[原话]");
  assert.equal(complete.completeness, "complete");
  assert.equal(complete.clipped, false);
  assert.match(complete.content, /原存档文本完整性=完整/);
  const completeSource = selectionSource({ text: completeText, textTruncated: false, textChars: completeText.length }, "memory", "recent", 0, true);
  assert.equal(completeSource.completeness, "complete");
  assert.equal(completeSource.clipped, true);

  const truncated = buildHistoricalSourceFrame({ text: "存档文字".repeat(8), textTruncated: true, textChars: 501 }, "[原话]", { maxTextChars: 20 });
  assert.equal(truncated.completeness, "truncated");
  assert.equal(truncated.clipped, true);
  assert.match(truncated.content, /原存档文本完整性=已截短/);
  assert.match(truncated.content, /message=.*已截短/);
  const truncatedSource = selectionSource({ text: "存档文字", textTruncated: true, textChars: 501 }, "memory", "recent");
  assert.equal(truncatedSource.completeness, "truncated");
  assert.equal(truncatedSource.clipped, true);

  for (const metadata of [
    {},
    { textTruncated: false, textChars: 5 },
    { textTruncated: true, textChars: 4 },
    { textTruncated: "true", textChars: 500 },
  ]) {
    const unknown = buildHistoricalSourceFrame({ text: "a  b", ...metadata }, "[原话]");
    assert.equal(unknown.completeness, "unknown");
    assert.match(unknown.content, /原存档文本完整性=未知/);
  }
});

test("signed OneBot message ids render while signed author ids remain unknown", () => {
  const frame = buildHistoricalSourceFrame({ uid: "-70331", messageId: "-70332", replyToMessageId: "-70333",
    turnId: "-70334", text: "负数消息标识" }, "[历史原话]", { parentProvided: true });
  assert.match(frame.content, /speaker=unknown/);
  assert.match(frame.content, /message_id=-70332/);
  assert.match(frame.content, /replyToMessageId=-70333/);
  assert.match(frame.content, /turnId=-70334/);
});

test("source metadata tracks the real original and cross-layer reply components", () => {
  const child = { ...selectionSource({ messageId: 22, uid: 2, replyToMessageId: 11, turnId: 99, ts: 1700000000000 }, "group", "reply_chain", 1, true) };
  const parent = { ...selectionSource({ messageId: 11, uid: 1, ts: 1699999999000 }, "quote", "reply_chain") };
  assert.deepEqual(
    { messageId: child.messageId, userId: child.userId, replyToMessageId: child.replyToMessageId, turnId: child.turnId, at: child.at, clipped: child.clipped, completeness: child.completeness },
    { messageId: "22", userId: "2", replyToMessageId: "11", turnId: "99", at: 1700000000000, clipped: true, completeness: "unknown" },
  );

  const layers = [
    { contextSources: [parent] },
    { contextSources: [child] },
    { contextSources: [{ ...selectionSource({ messageId: 22, uid: 2 }, "memory", "recent") }] },
    { contextSources: [{ ...selectionSource({ messageId: 33, uid: 2, turnId: 99 }, "memory", "legacy") }] },
  ];
  const grouped = assignContextGroups(layers);
  assert.equal(grouped[0].contextGroup, grouped[1].contextGroup);
  assert.equal(grouped[1].contextGroup, grouped[2].contextGroup);
  assert.equal(grouped[3].contextGroup, undefined);

  const explicit = assignContextGroups([
    { contextGroup: "caller-group-1", contextSources: [parent] },
    { contextSources: [child] },
  ]);
  assert.equal(explicit[0].contextGroup, "caller-group-1");
  assert.equal(explicit[1].contextGroup, "caller-group-1");
});

test("a note ID cannot supply a reply parent, while an original user frame can", () => {
  const reply = buildHistoricalSourceFrame({ messageId: "70402", replyToMessageId: "70401", text: "后续原话" }, "[群聊背景]", { parentProvided: false });
  const child = { content: reply.content, contextSources: [{ kind: "group", messageId: "70402", replyToMessageId: "70401" }] };
  const note = { content: "[明确记忆] 仅有摘要", contextSources: [{ kind: "note", messageId: "70401" }] };
  const withoutParent = assignContextGroups([note, child]);
  assert.match(withoutParent[1].content, /replyToMessageId=本轮未提供/);
  assert.equal(withoutParent[1].contextGroup, undefined);

  const original = buildHistoricalSourceFrame({ messageId: "70401", text: "父消息原话" }, "[用户历史]");
  const withParent = assignContextGroups([{ content: original.content, contextOriginalFrame: true,
    contextSources: [{ kind: "memory", messageId: "70401" }] }, child]);
  assert.match(withParent[1].content, /replyToMessageId=70401/);
  assert.equal(withParent[0].contextGroup, withParent[1].contextGroup);

  const summary = assignContextGroups([{ content: "[话题摘要] source=message_id=70401 time=unknown", contextSources: [{ kind: "memory", messageId: "70401" }] }, child]);
  assert.match(summary[1].content, /replyToMessageId=本轮未提供/);
});

test("quote, personal recall and group history share one request-local atomic group", () => {
  const uid = "70201";
  const groupId = "70202";
  users[uid] = { chats: [{ group: groupId, nickname: "同名", uid, messageId: "70204", replyToMessageId: "70203",
    text: "显示器线试试", ts: Date.now() }] };
  groupChats[groupId] = [
    { group: groupId, uid: "70203", nickname: "同名", messageId: "70203", text: "黑屏怎么排查", role: "member", ts: Date.now() - 1000 },
    { group: groupId, uid, nickname: "同名", messageId: "70204", replyToMessageId: "70203", text: "显示器线试试", role: "member", ts: Date.now() },
  ];

  const result = buildLayeredReplyContext({
    uid, groupId, userName: "同名", userMsg: "后来呢", replyText: "黑屏怎么排查",
    replyToMessageId: "70203", replyUserId: uid, replySpeaker: "同名",
    quoteEvidence: { state: "verified", messageId: "70203", userId: uid, at: Date.now() },
  });
  const related = result.history.filter(layer => layer.contextGroup);
  assert.ok(related.some(layer => layer.contextSources?.[0]?.kind === "quote"));
  assert.ok(related.some(layer => layer.contextSources?.[0]?.messageId === "70204"));
  assert.ok(related.some(layer => layer.content.includes("replyToMessageId=70203")));
  assert.equal(new Set(related.map(layer => layer.contextGroup)).size, 1);
  assert.ok(result.history.every(layer => layer.contextAtomic === true));
  assert.ok(related.every(layer => typeof layer.contextGroup === "string" && layer.contextGroup.length <= 160));
});

test("interjection emits separate atomic frames with matching source metadata", () => {
  const groupId = "70302";
  const now = Date.now();
  groupChats[groupId] = [
    { group: groupId, uid: "70311", nickname: "同名", messageId: "70321", text: "前因原话", role: "member", ts: now - 2000 },
    { group: groupId, uid: "70312", nickname: "同名", messageId: "70322", replyToMessageId: "70321", turnId: "70320",
      text: "后续原话", role: "member", ts: now - 1000 },
    { group: groupId, uid: "70313", nickname: "当前用户", messageId: "70323", text: "当前输入", role: "member", ts: now },
  ];
  const result = buildLayeredReplyContext({ uid: "70313", groupId, userMsg: "接着呢", currentMessageId: "70323",
    isPassiveInterjection: true, now });
  const frames = result.history.filter(layer => layer.contextSources?.some(source => source.kind === "group"));
  assert.deepEqual(frames.map(layer => layer.contextSources[0].messageId), ["70321", "70322"]);
  assert.deepEqual(frames.map(layer => layer.contextSources[0].userId), ["70311", "70312"]);
  assert.equal(frames[1].contextSources[0].replyToMessageId, "70321");
  assert.equal(frames[1].contextSources[0].turnId, "70320");
  assert.equal(frames[0].contextGroup, frames[1].contextGroup);
  assert.ok(frames.every(layer => layer.contextAtomic && layer.content.includes("speaker=同名")));
  assert.ok(!result.history.some(layer => layer.content.includes("当前输入")));
  assert.match(buildInterjectionBackgroundBlock(groupId, { uid: "70313", userMsg: "接着呢", currentMessageId: "70323", now }), /前因原话/);
});

test("actual packet does not label a note's source command as supplied parent text", () => {
  const uid = "70501";
  const groupId = "70502";
  const scope = { userId: uid, groupId };
  CFG.groupWhitelist = [Number(groupId)];
  CFG.friendWhitelist = [Number(uid)];
  applyMemoryNoteAction({ ...scope, revision: memoryNotesSnapshot(scope).revision, action: "create",
    title: "项目进展", text: "已经完成初版" }, { origin: "user_command", messageId: 70511 });
  const now = Date.now();
  groupChats[groupId] = [
    { group: groupId, uid, messageId: "70511", text: "记住项目进展", memoryCommand: true, ts: now - 1000 },
    { group: groupId, uid: "70503", messageId: "70512", replyToMessageId: "70511", text: "项目进展怎么样", ts: now },
  ];
  const packet = buildReplyContextPacket({ uid, groupId, userMsg: "项目进展怎么样", userName: "测试者", currentMessageId: "70513" });
  const child = packet.messages.find(item => item.content.includes("source=message_id=70512"));
  assert.ok(child);
  assert.match(child.content, /replyToMessageId=本轮未提供/);
  assert.equal(packet.messages.some(item => item.content.includes("source=message_id=70511")), false);
  assert.ok(packet.retrieval.sources.some(source => source.kind === "note" && source.messageId === "70511"));
});

test("actual packet reports clipped excerpts for legacy history and image anchors", () => {
  const uid = "70601";
  const groupId = "70602";
  users[uid] = { uid, chats: [{ group: groupId, uid, messageId: "70611", text: "z".repeat(700), ts: Date.now() }] };
  const legacy = buildReplyContextPacket({ uid, groupId, userMsg: "hello", userName: "测试者" });
  const legacyFrame = legacy.messages.find(item => item.content.includes("source=message_id=70611"));
  assert.ok(legacyFrame);
  assert.match(legacyFrame.content, /已截短/);
  assert.equal(legacy.retrieval.sources.find(source => source.messageId === "70611").clipped, true);

  const at = Date.now();
  groupChats[groupId] = [{ group: groupId, uid, messageId: "70612", text: "x".repeat(450),
    textTruncated: false, textChars: 450, imageUrls: ["synthetic-image"], ts: at }];
  const image = buildReplyContextPacket({ uid, groupId, userMsg: "看看这图", userName: "测试者",
    imageAnchor: { messageId: "70612", userId: uid, at } });
  const imageFrame = image.messages.find(item => item.content.includes("本轮所选图片的原消息"));
  assert.ok(imageFrame);
  assert.equal((imageFrame.content.match(/x/g) || []).length, 400);
  const imageSource = image.retrieval.sources.find(source => source.kind === "image" && source.messageId === "70612");
  assert.equal(imageSource.completeness, "complete");
  assert.equal(imageSource.clipped, true);
});
