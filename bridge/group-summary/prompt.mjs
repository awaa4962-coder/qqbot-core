import { DEFAULT_SUMMARY_GROUP_NAME } from "./constants.mjs";
import { dateLabel, formatDate } from "./date.mjs";
import { buildSummaryDigest, formatDigestForPrompt } from "./digest.mjs";
import { formatSummaryLines } from "./formatter.mjs";
import { buildSummaryStats } from "./stats.mjs";
import { getSummaryStyle } from "./styles.mjs";

export function buildGroupSummaryPrompt(messages, options = {}) {
  const groupName = options.groupName || DEFAULT_SUMMARY_GROUP_NAME;
  const label = options.label || dateLabel(options.dateText || formatDate());
  const stats = buildSummaryStats(messages);
  const digest = options.digest || buildSummaryDigest(messages);
  const style = getSummaryStyle(options.style);
  return `你叫「夜星」，是群「${groupName}」里的猫娘 AI 助手。

请根据下面的聊天记录，生成一份可以直接发到 QQ 群里的「群聊小报」。

硬性要求：
- 必须以「🌟【${label} 群聊小报】喵～」开头。
- 必须是简体中文。
- 不要说“你分享了一段聊天记录”“请问你想让我做什么”。
- 不要输出思考过程、分析过程、推理过程或任务解释。
- 不要像官方报告，要像群友在发轻松小报。
- 总长度 ${style.length}。
- 本次风格：${style.label}。${style.prompt}
- 统计数据必须写：${stats.messageCount} 条消息，${stats.speakerCount} 位群友发言。
- 活跃之星必须写：${stats.top3}。
- 可以轻微引用群友原话，但不要泄露隐私，不要攻击群友。
- 结尾用一句可爱的收尾。
- 优先参考结构化摘要来判断主题和名场面；聊天记录只作为校验，不要逐条复述。

建议结构：
1. 今日数据
2. 热聊话题
3. 今日名场面
4. 活跃之星
5. 今日氛围

${formatDigestForPrompt(digest)}

聊天记录：
${formatSummaryLines(messages)}`;
}

export function summarySystemPrompt() {
  return "你只输出最终群聊小报正文。不要解释任务，不要提问，不要输出英文，不要输出思考过程。";
}
