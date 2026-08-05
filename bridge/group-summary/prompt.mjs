import { DEFAULT_SUMMARY_GROUP_NAME } from "./constants.mjs";
import { dateLabel, formatDate } from "./date.mjs";
import { buildSummaryDigest, formatDigestForPrompt } from "./digest.mjs";
import { prepareSummaryEvidence } from "./evidence.mjs";
import { formatSummaryLines } from "./formatter.mjs";
import { buildSummaryStats } from "./stats.mjs";
import { getSummaryStyle } from "./styles.mjs";

export function buildGroupSummaryPrompt(messages, options = {}) {
  const groupName = options.groupName || DEFAULT_SUMMARY_GROUP_NAME;
  const label = options.label || dateLabel(options.dateText || formatDate());
  const evidence = options.evidence || prepareSummaryEvidence(messages, options);
  const stats = buildSummaryStats(messages, { ...options, evidence });
  const digest = options.digest || buildSummaryDigest(messages, { ...options, evidence });
  const style = getSummaryStyle(options.style);
  const evidenceLines = formatSummaryLines(evidence.messages, { evidenceIds: true }) ||
    "[没有可用于语义分析的有效消息]";

  return `你正在为群「${groupName}」编辑一份可核对的群聊分析日报。

目标不是逐条复述聊天或编写热闹小作文，而是让群友直观看到：今天发生了什么、讨论得出什么结果、哪些问题仍未解决。

事实优先级：
1. 系统统计事实只负责数量，数字不得自行重算或改写。
2. 净化后的证据记录是人物归属、语义、先后顺序和讨论结果的唯一来源。
3. 关键词和时段仅用于定位线索，不能单独证明观点、因果或结论。

分析约束：
- 将同一时间段围绕同一件事的消息合并为一个讨论，最多选择 ${style.maxTopics} 个有信息价值的讨论。
- 每项讨论回答“经过、结果、状态”。状态只能是“已确认”“待继续”或“闲聊无结论”。
- 只有后续消息明确确认时才能写“解决、决定、完成、共识”；孤立的“结案、搞定、结束”等收尾口头语不能证明现实结果。
- 涉及治安、医疗、法律或他人行为的个人叙述必须写成“某群友自述/称”，不得改写成已经核实的客观事实。
- 不把玩笑、反讽、口头禅、复读或表情接龙当成真实立场或重要成果。
- 不把一个人的意见写成“大家认为”；没有足够参与者时使用具体昵称或“有群友”。
- 不根据图片数量猜测图片内容；只有证据文字明确描述时才能概括画面。
- 机器人消息、命令、纯符号和短时间复读已从证据记录中排除，不得重新当作活跃贡献或核心话题。
- 全部使用中性转述，不使用引号逐字复述群友原话。
- 粗口、侮辱和攻击性玩笑只能中性概括为“表达不满/发生争执”等，不得原样复述或写成正式结论。
- 不输出 QQ 号、IP、端口、链接、密钥、联系方式或其他可识别信息；占位符不得还原。
- 不评价群友人格，不使用“话痨之王、肝帝、大师”等主观标签。
- 过滤数量、证据编号和复读处理属于内部质量信息，最终日报不得提及。

输出格式：
【${label} 群聊日报】
今日主线：用一句话概括最重要的实际变化；没有明确主线就如实说明。

关键讨论
1. 主题（大致时段）
   经过：只写证据支持的过程。
   结果：写已确认结果；没有就写“未形成明确结论”。
   状态：已确认 / 待继续 / 闲聊无结论

值得注意：只有确有异常、分歧、决定或待办时才使用这个标题，否则整段省略；标题中不得出现“可选栏目”字样。
参与概况：${stats.messageCount} 条消息，${stats.speakerCount} 位群友发言；参与较多者：${stats.top3}。

呈现要求：
- 简体中文，总长度 ${style.length}。
- 本次模式：${style.label}。${style.prompt}
- 使用适合 QQ 纯文本阅读的短段落，不使用 Markdown 粗体、表格、代码围栏或 emoji 栏目图标。
- 夜星人设只允许在最后一句有轻微自然表现；不得影响事实分析，也不强制加“喵”。
- 只输出最终日报正文，不输出证据编号、分析过程、任务解释或免责声明。

${formatDigestForPrompt(digest)}

净化后的证据记录：
${evidenceLines}`;
}

export function summarySystemPrompt() {
  return "你是严谨的中文群聊记录编辑。先在内部核对事实、人物和时间顺序，只输出中性转述的最终日报。禁止逐字引用、粗口、攻击性称呼、分析过程、私有推理、任务解释和未经证据支持的结论。";
}
