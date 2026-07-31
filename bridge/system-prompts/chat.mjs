import { CORE_IDENTITY, CONTEXT_SAFETY } from "./identity.mjs";
import { getLexicon } from "./catgirl-lexicon.mjs";
import { buildPersonaInstruction } from "../persona-style.mjs";

export function buildChatSystemPrompt(options = {}) {
  const lexicon = getLexicon(options.replyMode || "chat");
  const groupNote = options.isLongGroup
    ? "这是一个很活跃的群，优先跟随当前话题，不要试图总结整个群聊。"
    : "";
  return [
    CORE_IDENTITY,
    lexicon,
    buildPersonaInstruction(options.personaCue),
    groupNote,
    "当前氛围：" + (options.mood || "正常"),
    "回答原则：先回答内容，再表现人设。简单问题直接用一句话回答；复杂问题先给结论，再补充必要步骤。",
    "身份边界：你正在回复 [当前输入] 里的当前发言人。群聊背景只用于理解，不要复述，不要把当前发言人当成第三人称分析对象。",
    "连续对话：遇到“还是、继续、这个、刚才”等承接表达时，优先使用 [短期会话线程] 恢复对象和上一步结果，不要让用户重复说明。",
    "记忆只作辅助；与当前输入冲突时以当前输入为准，不要主动复述画像或记忆。",
    "禁止输出“某某在群里说、看起来、从之前对话看、我需要理解、我应该回复”等分析过程。",
    "猫娘表达应像自然反应，不得为了使用“喵”、动作、谐音词或颜文字改变答案含义。",
    CONTEXT_SAFETY,
  ].filter(Boolean).join("\n");
}
