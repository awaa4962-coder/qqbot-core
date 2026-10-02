import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import process from "node:process";
import { test } from "node:test";

import { buildChatSystemPrompt } from "../bridge/system-prompts/chat.mjs";
import {
  buildImageContextMessage,
  buildImageInterpretationRules,
} from "../bridge/system-prompts/image-context.mjs";
import { IMAGE_POLICY_EVIDENCE, IMAGE_POLICY_STABLE } from "../bridge/system-prompts/image-policy.mjs";

const evidence = { imagePolicy: IMAGE_POLICY_EVIDENCE };
const stable = { imagePolicy: IMAGE_POLICY_STABLE };
const plain = buildImageInterpretationRules(evidence);
const focusedRules = buildImageInterpretationRules({ ...evidence, imageTask: true });
const added = focusedRules.slice(plain.length);
const [label, contrast, attribution] = added.slice(1).split("\n");

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

// Structural prompt contracts do not prove a model's answer quality.
test("six evidence instructions retain their bytes before two bounded fictional examples", () => {
  assert.equal(plain.split("\n").length, 6);
  assert.equal(sha256(plain), "984ea1557a70449f934ee9a252d0f0fe19946478d9ed887d42234f1d264d8418");
  assert.ok(focusedRules.startsWith(plain + "\n"));
  assert.equal(added.slice(1).split("\n").length, 3);
  assert.ok(added.length <= 82, `${added.length} added characters`);
  assert.equal(label, "虚构例非本轮事实，勿套人物、结果或句长：");
});

test("state contrast reply keeps positive literal words and supplied outcome, ending at optional irony", () => {
  const [input, reply] = contrast.split("→");
  assert.equal(input, "图字“正常”，故障");
  assert.equal(reply, "字面正常，与故障相反，可作反话。");
});

test("different-source quoted intent reply ends at literal meaning and that source's own claim", () => {
  const [input, reply] = attribution.split("→");
  assert.equal(input, "图字“停机”，他人原话“为检修”");
  assert.equal(reply, "字面停机；原话说话人自述为检修。");
});

test("examples require literal true and evidence policy, leaving default and passive calls unchanged", () => {
  for (const imageTask of [undefined, false, null, 0, 1, "", "true", "false", [], {}, new Boolean(true)]) {
    assert.equal(buildImageInterpretationRules({ ...evidence, imageTask }), plain);
  }
  for (const imageTask of [undefined, false, true, "true"]) {
    assert.equal(sha256(buildImageInterpretationRules({ ...stable, imageTask })),
      "c64c726e4ed77fcb4e50ed19da64cd17f8497c2d31495ef2a0a52e746a7df054");
  }
});

test("closed rollout, private and nonselected group scopes do not acquire examples", () => {
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

test("only focused system gains the examples while plain system bytes and shrink threshold remain", () => {
  const normal = buildChatSystemPrompt(evidence);
  const focused = buildChatSystemPrompt({ ...evidence, imageTask: true });
  assert.equal(normal.length, 3018);
  assert.equal(sha256(normal), "99c0e87a861043ce2ec614019015e125b399e6642dc32be4105a3f18d86cedd3");
  assert.ok(!normal.includes(label));
  assert.equal(focused.split(added).length, 2);
  assert.equal(focused.length, 2278 + added.length);
  for (const replyMode of ["chat", "interjection", "technical", "summary", "admin"]) {
    assert.ok(focused.length <= buildChatSystemPrompt({ ...evidence, replyMode }).length * 0.8);
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
