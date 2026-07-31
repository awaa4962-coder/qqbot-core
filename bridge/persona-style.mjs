// bridge/persona-style.mjs - bounded, context-aware catgirl expression.

export const PERSONA_CUES = Object.freeze({
  NONE: "none",
  SOFT: "soft",
  HISS: "hiss",
});

export const PERSONA_PROBABILITIES = Object.freeze({
  normalSoft: 0.36,
  interjectionSoft: 0.42,
  playfulHiss: 0.24,
  playfulSoftEnd: 0.76,
  provokedHiss: 0.48,
  provokedSoftEnd: 0.8,
  seriousSoft: 0.15,
});

const SERIOUS_RE = /(?:自杀|自残|想死|活不下去|抑郁|崩溃|急救|报警|住院|去世|葬礼|重病|求助|救命)/i;
const PROVOKED_RE = /(?:笨猫|傻猫|蠢猫|废物|垃圾|闭嘴|滚开|揍你|打你|欺负你|抓住你|坏猫|凶你|咬你)/i;
const PLAYFUL_RE = /(?:猫娘|小猫|猫猫|喵|摸摸|摸头|撸猫|rua|捏脸|抓尾巴|尾巴|耳朵|抱抱|贴贴|哈气)/i;

export function classifyPersonaMoment(text) {
  const value = String(text || "").trim();
  if (!value) return "normal";
  if (SERIOUS_RE.test(value)) return "serious";
  if (PROVOKED_RE.test(value)) return "provoked";
  if (PLAYFUL_RE.test(value)) return "playful";
  return "normal";
}

export function selectPersonaCue(text, options = {}, random = Math.random) {
  const roll = normalizeRoll(random());
  const moment = classifyPersonaMoment(text);

  if (moment === "serious") {
    return roll < PERSONA_PROBABILITIES.seriousSoft ? PERSONA_CUES.SOFT : PERSONA_CUES.NONE;
  }
  if (moment === "provoked") {
    if (roll < PERSONA_PROBABILITIES.provokedHiss) return PERSONA_CUES.HISS;
    return roll < PERSONA_PROBABILITIES.provokedSoftEnd ? PERSONA_CUES.SOFT : PERSONA_CUES.NONE;
  }
  if (moment === "playful") {
    if (roll < PERSONA_PROBABILITIES.playfulHiss) return PERSONA_CUES.HISS;
    return roll < PERSONA_PROBABILITIES.playfulSoftEnd ? PERSONA_CUES.SOFT : PERSONA_CUES.NONE;
  }

  const softChance = options.replyMode === "interjection"
    ? PERSONA_PROBABILITIES.interjectionSoft
    : PERSONA_PROBABILITIES.normalSoft;
  return roll < softChance ? PERSONA_CUES.SOFT : PERSONA_CUES.NONE;
}

export function buildPersonaInstruction(cue) {
  if (cue === PERSONA_CUES.HISS) {
    return "本轮猫娘表现：若当前语义确实是在逗弄、挑衅或碰耳朵尾巴，可以自然地短促哈气一次，例如“哈——！”或“哈气”，然后立刻回应具体内容；不要辱骂，不要连续哈气，不要只发动作。若语境不合适，改用轻猫娘语气。";
  }
  if (cue === PERSONA_CUES.SOFT) {
    return "本轮猫娘表现：在不影响答案的前提下，自然加入一处猫娘细节，可从句尾“喵”、耳朵或尾巴的小动作、简短颜文字中任选一种；最多一处，不要堆叠。";
  }
  return "本轮猫娘表现：不必刻意添加口癖或动作，保持夜星自然的说话方式。";
}

function normalizeRoll(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 1;
  return Math.min(1, Math.max(0, number));
}
