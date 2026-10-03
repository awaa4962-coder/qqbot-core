import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { test } from "node:test";
import { P5_MODEL_PROBES } from "../scripts/p5-quality-fixtures.mjs";

Object.assign(process.env, {
  NODE_ENV: "test",
  QQBOT_CONFIG_ROOT: path.join(os.tmpdir(), "qqfriend-quote-presence-" + process.pid),
  QQBOT_SELF_UIN: "90150",
});
const {
  buildCurrentInput, buildHistoricalSourceFrame, buildQuotedMessageBlock,
  buildUnavailableQuoteBlock, fmtMsg, safeContextExcerpt,
} = await import("../bridge/context/messages.mjs");
const sameName = P5_MODEL_PROBES.find(probe => probe.id === "same-name-quote");

test("current input records a quote request, not a body-presence fact", () => {
  const current = buildCurrentInput("Same", "What did they mean?", "60150", { hasQuote: true });
  assert.match(current, /^quoted_message=存在引用请求；正文是否提供以本轮引用帧为准。$/m);
  assert.doesNotMatch(current, /quoted_text=|若本轮缺少引用正文|看不到正文|已读/);
  assert.match(current, /reply_target=当前发言人$/);
  assert.doesNotMatch(buildCurrentInput("Same", "No quote", "60150"), /quoted_message=/);
});

test("the actual synthetic same-name case supplies peer text without denying its visibility", () => {
  const current = buildCurrentInput(sameName.speaker.name, sameName.input, sameName.speaker.userId, { hasQuote: true });
  const quote = buildQuotedMessageBlock(sameName.quote.text, sameName.quote.speaker, sameName.quote.source);
  assert.match(current, /uid=60150/);
  assert.match(quote, /uid=60151/);
  assert.match(quote, /^quoted_text=available$/m);
  assert.ok(quote.includes("message=" + sameName.quote.text));
  assert.match(quote, /本帧已提供引用正文/);
  assert.doesNotMatch(quote, /quoted_text=(?:empty|missing)|本帧没有可读|看不到正文/);
  assert.match(quote, /不是\[当前输入\]的新发言；仍回复当前发言人/);
});

test("verified provenance confirms same-group origin only, not truth or execution", () => {
  const quote = buildQuotedMessageBlock("I tried the cable.", "Same", {
    state: "verified", userId: "60151", messageId: "-70151", at: 1800000000000,
  });
  assert.match(quote, /OneBot已核验同群引用 message_id=-70151 time=2027-01-15T08:00:00.000Z/);
  assert.match(quote, /仅确认出处，不代表说法属实或操作已执行/);
  assert.match(quote, /^quoted_text=available$/m);
});

test("available unverified text is never promoted to verified provenance", () => {
  const quote = buildQuotedMessageBlock("Original statement.", "Same", {
    userId: "opaque-author", messageId: "opaque-message", at: "1800000000000",
  });
  assert.match(quote, /source=未核验摘录 message_id=unknown time=unknown/);
  assert.match(quote, /出处未核验，不代表说法属实或操作已执行/);
  assert.match(quote, /^quoted_text=available$/m);
  assert.doesNotMatch(quote, /OneBot已核验|仅确认出处|opaque-/);
});

test("empty and whitespace-only bodies are empty, not read text", () => {
  for (const body of ["", " \n\t "]) {
    const quote = buildQuotedMessageBlock(body, "Same", sameName.quote.source);
    assert.match(quote, /^quoted_text=empty$/m);
    assert.match(quote, /^message=$/m);
    assert.match(quote, /不能声称已读原话/);
    assert.doesNotMatch(quote, /quoted_text=available|本帧已提供引用正文/);
  }
});

test("absent or non-text bodies are missing and are not serialized into quoted text", () => {
  for (const body of [undefined, null, false, 12, { text: "OBJECT_BODY_SENTINEL" }]) {
    const quote = buildQuotedMessageBlock(body, "Same");
    assert.match(quote, /^quoted_text=missing$/m);
    assert.match(quote, /^message=$/m);
    assert.match(quote, /不能声称已读原话/);
    assert.doesNotMatch(quote, /OBJECT_BODY_SENTINEL|quoted_text=available|本帧已提供引用正文/);
  }
});

test("backend-labelled image-only placeholders are not original body text", () => {
  for (const body of ["[引用消息仅包含图片]", " [图片1张] ", "[图片12张]"]) {
    const quote = buildQuotedMessageBlock(body, "Same", { ...sameName.quote.source, hasReadableText: false });
    assert.match(quote, /^quoted_text=empty$/m);
    assert.match(quote, /^quoted_metadata=\[/m);
    assert.match(quote, /^message=$/m);
    assert.match(quote, /不能声称已读原话/);
    assert.doesNotMatch(quote, /quoted_text=available|本帧已提供引用正文/);
  }
  const withText = buildQuotedMessageBlock("The screen is black. [图片1张]", "Same");
  assert.match(withText, /^quoted_text=available$/m);
  assert.match(withText, /^message=The screen is black\. \[图片1张\]$/m);
});

test("literal image marker text never manufactures an attachment or loses readable words", () => {
  for (const body of ["[图片1张]", "[引用消息仅包含图片]"]) {
    for (const source of [{}, { hasReadableText: true }, { hasReadableText: "false" }]) {
      const quote = buildQuotedMessageBlock(body, "Same", source);
      assert.match(quote, /^quoted_text=available$/m);
      assert.ok(quote.includes("message=" + body));
      assert.doesNotMatch(quote, /quoted_metadata=/);
    }
  }
});

test("unavailable privacy evidence rejects even a supplied body and keeps missing-source boundaries", () => {
  const unavailable = buildUnavailableQuoteBlock();
  const quote = buildQuotedMessageBlock("REJECTED_BODY_SENTINEL", "Rejected speaker", {
    state: "unavailable", reason: "PRIVATE_REASON_SENTINEL", userId: "60151",
  });
  assert.equal(quote, unavailable);
  assert.match(quote, /^quoted_text=missing$/m);
  assert.match(quote, /不能拿附近发言顶替/);
  assert.match(quote, /不提内部校验或隐私状态/);
  assert.doesNotMatch(quote, /REJECTED_BODY_SENTINEL|PRIVATE_REASON_SENTINEL|Rejected speaker|60151|已核验/);
});

test("an unknown quote parent or unprovided image parent is distinct from supplied quote text", () => {
  const quote = buildQuotedMessageBlock(sameName.quote.text, sameName.quote.speaker, sameName.quote.source);
  assert.match(quote, /replyToMessageId=unknown turnId=unknown/);
  assert.match(quote, /^quoted_text=available$/m);
  assert.match(quote, /父消息未知不表示本条正文不可见/);
  const image = buildHistoricalSourceFrame({ uid: "60151", messageId: "70152", replyToMessageId: "70153",
    text: "Image caption.", ts: 1800000000000 }, "[本轮所选图片的原消息]", { parentProvided: false });
  assert.match(image.content, /replyToMessageId=本轮未提供/);
  assert.match(image.content, /^message=Image caption\.$/m);
});

test("an available excerpt retains the truncation marker and final correction", () => {
  const body = "Original conclusion. " + "details ".repeat(80) + "Still not repaired.";
  const quote = buildQuotedMessageBlock(body, "Same", { maxTextChars: 100 });
  assert.match(quote, /^quoted_text=available$/m);
  assert.ok(quote.includes("message=" + safeContextExcerpt(body, 100)));
  assert.match(quote, /已截短/);
  assert.match(quote, /Still not repaired\./);
  assert.doesNotMatch(quote, /正文完整|quoted_text=missing/);
  const omitted = buildQuotedMessageBlock(body, "Same", { maxTextChars: -1 });
  assert.match(omitted, /^quoted_text=missing$/m);
  assert.match(omitted, /^message=$/m);
});

test("UID determines historical role while equal display names do not merge speaker identities", () => {
  assert.equal(fmtMsg({ nickname: "Same", uid: "90150", text: "Bot statement." }).role, "assistant");
  assert.equal(fmtMsg({ nickname: "Same", uid: "60151", text: "Peer statement." }).role, "user");
  const ownQuote = buildQuotedMessageBlock("My earlier statement.", "Same", { userId: "60150" });
  assert.match(ownQuote, /speaker=Same uid=60150/);
  assert.match(ownQuote, /不是\[当前输入\]的新发言/);
  assert.doesNotMatch(ownQuote, /不同的人|两人的经历|不是当前发言人的原话/);
});

test("quote text and attribution still use existing redaction and identifier helpers", () => {
  const quote = buildQuotedMessageBlock("api_key=SYNTHETIC_SECRET; cable failed", "Same", {
    userId: "invalid-user", messageId: "invalid-message",
  });
  assert.match(quote, /^quoted_text=available$/m);
  assert.match(quote, /api_key=\[REDACTED\]/);
  assert.match(quote, /cable failed/);
  assert.doesNotMatch(quote, /SYNTHETIC_SECRET|invalid-user|invalid-message|已核验/);
});
