import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  PERSONA_CUES,
  buildPersonaInstruction,
  classifyPersonaMoment,
  selectPersonaCue,
} from "../bridge/persona-style.mjs";
import { buildChatSystemPrompt } from "../bridge/system-prompts/chat.mjs";
import { buildInterjectionSystemPrompt } from "../bridge/system-prompts/interjection.mjs";

describe("catgirl persona style", () => {
  it("classifies playful, provoked and serious moments", () => {
    assert.equal(classifyPersonaMoment("给我摸摸尾巴"), "playful");
    assert.equal(classifyPersonaMoment("你这只笨猫"), "provoked");
    assert.equal(classifyPersonaMoment("我崩溃了，需要求助"), "serious");
    assert.equal(classifyPersonaMoment("这个接口怎么调用"), "normal");
  });

  it("selects deterministic bounded cues from probability rolls", () => {
    assert.equal(selectPersonaCue("普通聊天", {}, () => 0.1), PERSONA_CUES.SOFT);
    assert.equal(selectPersonaCue("普通聊天", {}, () => 0.9), PERSONA_CUES.NONE);
    assert.equal(selectPersonaCue("摸摸猫猫", {}, () => 0.1), PERSONA_CUES.HISS);
    assert.equal(selectPersonaCue("你这只笨猫", {}, () => 0.4), PERSONA_CUES.HISS);
    assert.equal(selectPersonaCue("我需要急救", {}, () => 0.1), PERSONA_CUES.SOFT);
    assert.equal(selectPersonaCue("我需要急救", {}, () => 0.3), PERSONA_CUES.NONE);
  });

  it("keeps hissing contextual and limited", () => {
    const instruction = buildPersonaInstruction(PERSONA_CUES.HISS);
    assert.match(instruction, /哈气一次/);
    assert.match(instruction, /不要连续哈气/);
    assert.match(instruction, /回应具体内容/);
  });

  it("injects the selected cue into chat and interjection prompts", () => {
    const chat = buildChatSystemPrompt({ personaCue: PERSONA_CUES.SOFT });
    const interjection = buildInterjectionSystemPrompt({ personaCue: PERSONA_CUES.HISS });
    assert.match(chat, /自然加入一处猫娘细节/);
    assert.match(interjection, /哈气一次/);
    assert.match(interjection, /每次最多一种/);
  });
});
