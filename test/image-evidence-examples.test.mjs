import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import process from "node:process";
import { test } from "node:test";

import { buildChatSystemPrompt } from "../bridge/system-prompts/chat.mjs";
import { CORE_IDENTITY, CONTEXT_SAFETY } from "../bridge/system-prompts/identity.mjs";
import {
  buildImageContextMessage,
  buildImageInterpretationRules,
} from "../bridge/system-prompts/image-context.mjs";
import { IMAGE_POLICY_EVIDENCE, IMAGE_POLICY_STABLE } from "../bridge/system-prompts/image-policy.mjs";
import { MEMORY_SEMANTIC_BOUNDARY } from "../bridge/memory-profile/semantics.mjs";

const evidence = { imagePolicy: IMAGE_POLICY_EVIDENCE };
const stable = { imagePolicy: IMAGE_POLICY_STABLE };
const plain = buildImageInterpretationRules(evidence);
const focusedRules = buildImageInterpretationRules({ ...evidence, imageTask: true });
const plainLines = plain.split("\n");
const focusedLines = focusedRules.split("\n");
const questionScope = focusedLines[0];
const taskContract = focusedLines[1];
const answerScale = focusedLines[5];

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

// Structural prompt contracts do not prove a model's answer quality.
test("focused question scope replaces three rules within six lines while plain and boundary bytes remain unchanged", () => {
  assert.equal(plainLines.length, 6);
  assert.equal(sha256(plain), "984ea1557a70449f934ee9a252d0f0fe19946478d9ed887d42234f1d264d8418");
  assert.equal(focusedLines.length, 6);
  for (const index of [2, 3, 4]) assert.equal(focusedLines[index], plainLines[index]);
  for (const index of [0, 1, 5]) assert.notEqual(focusedLines[index], plainLines[index]);
  const added = focusedRules.length - plain.length;
  assert.ok(added <= 82, `${added} added characters`);
  assert.ok(!focusedRules.includes(plain));
  assert.doesNotMatch(focusedRules, /虚构例|图字“|→/);
});

test("literal evaluation and supplied outcome relate without proving an opposite stance or denying praise", () => {
  assert.match(questionScope, /先完成 \[当前输入\] 的问题，不自行增加新问题/);
  assert.match(questionScope, /问词句含义，就解释相关文字、语气方向及与已给情境的吻合或反差/);
  assert.match(taskContract, /图字不证结果，结果不改字面褒贬/);
  assert.match(taskContract, /先说明字面，再与已知事件对照吻合或反差，不改写结果/);
  assert.match(taskContract, /反差可以有反话读法，不能因此断定实际语气或排除其他读法/);
  assert.match(taskContract, /问表达含义而无语境时，只说明字面并保留本次语气未知/);
  assert.match(taskContract, /读字、翻译等客观问题无需讨论语气/);
  assert.match(taskContract, /当前事实、纠正和本轮原话优先/);
  assert.ok(!focusedRules.includes(plainLines[1]));
});

test("actual stance and purpose stay unknown or retain only the explicit source's own claim", () => {
  assert.match(taskContract, /表达与事件的关系不等于人的行为或目的/);
  assert.match(taskContract, /作者明确自述才有可归属的意图资料，其他情况不分析心理/);
  assert.match(focusedRules, /说话人明确说明的意图可以复述为其自述.*与问题有关时不要漏掉/);
  assert.match(focusedRules, /必须归属于提供该原话的说话人或已标注的引用来源/);
  assert.match(focusedRules, /不视为已验证的心理事实.*不把他人自述转成发图者或当前用户的意图/);
  assert.match(focusedRules, /没有该原话时，心理意图是未知，不生成备选动机/);
  assert.match(answerScale, /短问用一两句话答完字面及情境关系就结束/);
  assert.match(answerScale, /未问心理目的时，不补动机备选、心理免责声明或口气类比/);
  assert.match(answerScale, /若相关原话明确自述意图，按其来源保留/);
  assert.match(answerScale, /追问目的而缺原话时才说明无法判断/);
  assert.match(answerScale, /无语境时只限制语气未知，不把常见用途说成本次真实用意/);
  assert.match(answerScale, /不列画面清单/);
  assert.ok(!focusedRules.includes(plainLines[5]));
});

test("question scope requires literal true and evidence policy, leaving default and passive calls unchanged", () => {
  for (const imageTask of [undefined, false, null, 0, 1, "", "true", "false", [], {}, new Boolean(true)]) {
    assert.equal(buildImageInterpretationRules({ ...evidence, imageTask }), plain);
  }
  for (const imageTask of [undefined, false, true, "true"]) {
    assert.equal(sha256(buildImageInterpretationRules({ ...stable, imageTask })),
      "c64c726e4ed77fcb4e50ed19da64cd17f8497c2d31495ef2a0a52e746a7df054");
  }
});

test("closed rollout, private and nonselected group scopes do not acquire question scope", () => {
  const previous = process.env.QQBOT_IMAGE_CONTEXT_ROLLOUT;
  try {
    for (const rollout of ["", "82007"]) {
      process.env.QQBOT_IMAGE_CONTEXT_ROLLOUT = rollout;
      for (const scope of [{ surface: "private" }, { surface: "group", groupId: "82008" }]) {
        for (const imagePolicy of [undefined, "", "unrecognized-policy"]) {
          assert.equal(sha256(buildImageInterpretationRules({ ...scope, imagePolicy, imageTask: true })),
            "c64c726e4ed77fcb4e50ed19da64cd17f8497c2d31495ef2a0a52e746a7df054");
        }
      }
    }
  } finally {
    if (previous === undefined) delete process.env.QQBOT_IMAGE_CONTEXT_ROLLOUT;
    else process.env.QQBOT_IMAGE_CONTEXT_ROLLOUT = previous;
  }
});

test("only focused system substitutes question scope while plain bytes and every mode's shrink threshold remain", () => {
  const normal = buildChatSystemPrompt(evidence);
  const focused = buildChatSystemPrompt({ ...evidence, imageTask: true });
  assert.equal(normal.length, 3068);
  assert.equal(sha256(normal), "14c940f6d56e7958520c97bbecdfcbb917f87d99c97274a468e6d0e08c596f06");
  assert.ok(!normal.includes(taskContract));
  assert.equal(focused.split(focusedRules).length, 2);
  assert.ok(!focused.includes(plain));
  const systemLines = focused.split("\n");
  assert.match(systemLines[0], /^当前任务：答\[当前输入\]所问/);
  assert.match(systemLines[1], /^事实与来源：当前事实\/纠正优先/);
  assert.match(systemLines[1], /分清证据\/原话\/建议\/反馈\/工具结果/);
  assert.ok(focused.indexOf(focusedRules) > focused.indexOf(systemLines[1]));
  assert.ok(focused.indexOf(focusedRules) < focused.indexOf(CORE_IDENTITY));
  for (const text of [CORE_IDENTITY, CONTEXT_SAFETY, MEMORY_SEMANTIC_BOUNDARY]) {
    assert.equal(focused.split(text).length, 2);
  }
  assert.equal(focused.length, 2294 + focusedRules.length - plain.length);
  assert.ok(focused.length <= 2360);
  for (const replyMode of ["chat", "interjection", "technical", "summary", "admin"]) {
    const profile = buildChatSystemPrompt({ ...evidence, replyMode, imageTask: true });
    assert.equal(profile, focused);
    assert.ok(profile.length <= buildChatSystemPrompt({ ...evidence, replyMode }).length * 0.8);
  }
});

test("objective candidate and failed-vision messages keep their bytes with either flag", () => {
  for (const imageTask of [undefined, false, true]) {
    const options = { ...evidence, imageTask };
    assert.equal(sha256(JSON.stringify(buildImageContextMessage("一幅静态画面。", options))),
      "5e57630cb9cf7f07706dd71ded796b075000850d000e3cc65f9c16ced26e149d");
    for (const imagePolicy of [IMAGE_POLICY_EVIDENCE, IMAGE_POLICY_STABLE]) {
      for (const description of [null, "", "   "]) {
        assert.equal(sha256(JSON.stringify(buildImageContextMessage(description,
          { imagePolicy, imageTask, imageCount: 2 }))),
        "d089deaed6b597b183e4d0ad28d2f0b64672a41a9651b1d3b3197c963b36d5d9");
      }
    }
  }
});
