// Shared capability catalog for chat help, the local console and command discovery.

import { CFG } from "../config.mjs";
import { COMMAND_DEFINITIONS } from "../commands/manifest.mjs";
import { getStickerSettings } from "../features/stickers/catalog-store.mjs";

export const CAPABILITY_CATEGORIES = Object.freeze([
  { id: "chat", number: 1, name: "聊天与识图", aliases: ["聊天", "识图", "图片", "对话"] },
  { id: "group", number: 2, name: "群聊工具", aliases: ["群聊", "群工具", "日报", "词云", "链接"] },
  { id: "resources", number: 3, name: "JM 与资源", aliases: ["jm", "资源", "下载", "漫画"] },
  { id: "personal", number: 4, name: "关系与个性化", aliases: ["关系", "好感度", "熟悉度", "档案", "个性化", "称呼", "风格"] },
  { id: "memes", number: 5, name: "梗与娱乐", aliases: ["梗", "梗库", "娱乐", "哈基米"] },
  { id: "system", number: 6, name: "状态与版本", aliases: ["状态", "版本", "更新", "隐私", "系统"] },
]);

export const CAPABILITY_DEFINITIONS = Object.freeze([
  capability({
    id: "chat.reply",
    category: "chat",
    name: "聊天回复",
    summary: "结合最近对话和安全画像进行群聊或私聊回复。",
    interaction: "automatic",
    scopes: ["group", "private"],
    examples: ["@夜星 这件事你怎么看"],
    keywords: ["聊天", "对话", "回复", "自动回复"],
  }),
  capability({
    id: "vision.context",
    category: "chat",
    name: "图片与表情包理解",
    summary: "识别图片，并结合回复引用和最近聊天理解语境。",
    interaction: "automatic",
    scopes: ["group", "private"],
    examples: ["@夜星 看看这张图是什么意思"],
    keywords: ["识图", "图片", "表情包", "看图", "视觉"],
  }),
  capability({
    id: "group.summary",
    category: "group",
    name: "每日群报",
    summary: "为已启用的群生成每日摘要；预览和手动发送需要管理员权限。",
    interaction: "automatic",
    scopes: ["group"],
    examples: ["@夜星 日报帮助"],
    keywords: ["日报", "群报", "每日总结", "总结"],
    access: "summary-groups",
  }),
  capability({
    id: "group.wordcloud",
    category: "group",
    name: "群词云",
    summary: "按今天、昨天或最近若干天生成群聊热词图。",
    scopes: ["group"],
    examples: ["@夜星 词云", "@夜星 词云 7天"],
    keywords: ["词云", "热词", "群词云", "wordcloud"],
    access: "feature-groups",
  }),
  capability({
    id: "group.link-preview",
    category: "group",
    name: "链接预览",
    summary: "读取公开网页的标题和摘要，内网地址会被拦截。",
    scopes: ["group"],
    examples: ["@夜星 preview https://example.com"],
    keywords: ["链接", "预览", "网址", "preview"],
    access: "link-preview",
  }),
  capability({
    id: "resources.jm",
    category: "resources",
    name: "JM 下载转发",
    summary: "通过作品编号下载、压缩并转发，临时文件会定时清理。",
    scopes: ["group", "private"],
    examples: ["@夜星 jm 123456", "私聊：jm 123456"],
    keywords: ["jm", "漫画", "本子", "下载"],
    access: "jm",
  }),
  capability({
    id: "resources.transfer",
    category: "resources",
    name: "公开资源转发",
    summary: "从经过安全检查的公开链接下载并转发文件。",
    scopes: ["group"],
    examples: ["@夜星 下载 https://example.com/file.zip"],
    keywords: ["资源", "文件", "下载", "转发"],
    access: "resource-groups",
  }),
  capability({
    id: "personal.relationship",
    category: "personal",
    name: "互动熟悉度",
    summary: "根据已有互动记录展示关系摘要，不代表恋爱含义。",
    scopes: ["group", "private"],
    examples: ["@夜星 好感度"],
    keywords: ["好感度", "关系", "熟悉度", "my-status"],
  }),
  capability({
    id: "personal.profile",
    category: "personal",
    name: "我的档案与隐私",
    summary: "查看安全画像摘要、隐私说明，或清理自己的个人记忆。",
    scopes: ["group", "private"],
    examples: ["@夜星 我的档案", "@夜星 隐私", "@夜星 忘记我"],
    keywords: ["档案", "画像", "隐私", "忘记我", "记忆"],
  }),
  capability({
    id: "personal.style",
    category: "personal",
    name: "称呼与回复风格",
    summary: "保存你的称呼和偏好的回复表达方式。",
    scopes: ["group", "private"],
    examples: ["@夜星 设置称呼 小明", "@夜星 回复风格 帮助"],
    keywords: ["称呼", "名字", "回复风格", "风格", "个性化"],
  }),
  capability({
    id: "memes.knowledge",
    category: "memes",
    name: "梗理解",
    summary: "在合适语境中参考已审核梗义，不需要专门触发。",
    interaction: "automatic",
    scopes: ["group"],
    examples: ["@夜星 梗库", "@夜星 梗库 搜 哈基米"],
    keywords: ["梗", "梗库", "哈基米", "meme"],
    access: "meme-mode",
  }),
  capability({
    id: "memes.stickers",
    category: "memes",
    name: "收藏表情回复与群聊采集",
    summary: "文字回复后可补发匹配表情；白名单群可匿名去重采集候选并按阈值加入 QQ 云收藏。",
    interaction: "automatic",
    scopes: ["group", "private"],
    examples: ["正常聊天时自动生效"],
    keywords: ["表情", "表情包", "收藏表情", "贴图"],
    access: "sticker-mode",
  }),
  capability({
    id: "system.health",
    category: "system",
    name: "在线状态",
    summary: "查看机器人是否在线以及当前版本。",
    scopes: ["group", "private"],
    examples: ["@夜星 状态", "@夜星 版本", "@夜星 ping"],
    keywords: ["状态", "在线", "ping", "测试", "版本"],
  }),
  capability({
    id: "system.changelog",
    category: "system",
    name: "版本更新",
    summary: "查看最新、指定版本或与关键词相关的更新记录。",
    scopes: ["group", "private"],
    examples: ["@夜星 更新", "@夜星 更新列表", "@夜星 更新 jm"],
    keywords: ["更新", "更新日志", "历史更新", "changelog"],
  }),
  capability({
    id: "admin.operations",
    category: "system",
    name: "管理员运行工具",
    summary: "查看运行、画像和日报管理命令，仅管理员可见。",
    permission: "admin",
    scopes: ["group", "private", "console"],
    examples: ["@夜星 管理帮助", "@夜星 runtime"],
    keywords: ["管理帮助", "管理员", "runtime", "运行状态"],
  }),
  capability({
    id: "admin.relationship-export",
    category: "system",
    name: "关系数据导出",
    summary: "仅保留命令入口，当前不会生成或导出关系表。",
    permission: "admin",
    reserved: true,
    scopes: ["group", "private", "console"],
    examples: ["@夜星 export-relationships"],
    keywords: ["关系导出", "export-relationships"],
  }),
]);

const HELP_HEADS = new Set([
  "help",
  "帮助",
  "你能干嘛",
  "你能做什么",
  "你会什么",
  "能做什么",
  "怎么用",
  "能力",
  "功能",
]);

export function buildCapabilityCatalog(options = {}) {
  const cfg = options.cfg || CFG;
  const capabilities = CAPABILITY_DEFINITIONS
    .filter(item => isVisibleToUser(item, options, cfg))
    .map(item => buildCapabilityView(item, options, cfg));
  const categories = CAPABILITY_CATEGORIES.map(category => {
    const members = capabilities.filter(item => item.category === category.id);
    return {
      ...category,
      count: members.length,
      available: members.filter(item => item.status === "available").length,
      limited: members.filter(item => item.status === "limited").length,
      unavailable: members.filter(item => item.status === "unavailable").length,
    };
  });
  return {
    generatedAt: new Date().toISOString(),
    count: capabilities.length,
    categories,
    capabilities,
  };
}

export function parseCapabilityHelpCommand(commandText) {
  const value = normalizeQuery(commandText);
  if (!value) return { matched: false, query: "" };
  if (HELP_HEADS.has(value)) return { matched: true, query: "" };

  const numbered = value.match(/^(?:help|帮助)\s*([1-6])$/);
  if (numbered) return { matched: true, query: numbered[1] };

  const helpQuery = value.match(/^(?:help|帮助)\s+(.+)$/);
  if (helpQuery) return { matched: true, query: helpQuery[1].trim() };

  const usageQuery = value.match(/^(.{1,18}?)(?:怎么用|如何使用|怎么玩)$/);
  if (usageQuery) return { matched: true, query: usageQuery[1].trim() };

  const canQuery = value.match(/^能(.{1,12})吗$/);
  if (canQuery) return { matched: true, query: canQuery[1].trim() };
  return { matched: false, query: "" };
}

export function isCapabilityHelpCommand(commandText) {
  return parseCapabilityHelpCommand(commandText).matched;
}

export function buildCapabilityHelpText(query = "", options = {}) {
  const catalog = buildCapabilityCatalog(options);
  const normalized = normalizeQuery(query);
  if (!normalized) return buildCapabilityHubText(catalog, options);

  const category = findCategory(normalized);
  if (category) return buildCategoryText(category, catalog, options);

  const matches = findCapabilityViews(normalized, catalog.capabilities);
  if (!matches.length) {
    return [
      "没有找到与“" + safeDisplayQuery(query) + "”对应的能力。",
      "",
      "发送“@夜星 帮助”查看完整分类。",
    ].join("\n");
  }
  return buildCapabilityDetailText(matches.slice(0, 3), options);
}

export function buildUnknownCommandSuggestion(commandText, options = {}) {
  const value = normalizeQuery(commandText);
  if (!isSuggestionCandidate(value)) return null;
  const token = value.split(/\s+/)[0];
  const catalog = buildCapabilityCatalog(options);
  const candidates = catalog.capabilities.flatMap(item =>
    item.keywords.map(keyword => ({ item, keyword: normalizeQuery(keyword) }))
  );
  let best = null;
  for (const candidate of candidates) {
    if (!candidate.keyword) continue;
    const distance = levenshtein(token, candidate.keyword);
    const maxLength = Math.max(token.length, candidate.keyword.length);
    const score = maxLength ? 1 - distance / maxLength : 0;
    const allowed = maxLength <= 4 ? distance <= 1 : distance <= 2 && score >= 0.72;
    if (!allowed) continue;
    if (!best || distance < best.distance || (distance === best.distance && score > best.score)) {
      best = { ...candidate, distance, score };
    }
  }
  if (!best) return null;
  const example = formatExample(best.item.examples[0], options);
  return [
    "没有找到“" + safeDisplayQuery(token) + "”。",
    "",
    "你可能想使用：" + best.item.name,
    example ? "示例：" + example : "",
    "",
    "发送“@夜星 帮助 " + best.item.name + "”查看详情。",
  ].filter(Boolean).join("\n");
}

export function commandCapabilityIds() {
  return new Set(COMMAND_DEFINITIONS.map(item => item.id));
}

function capability(input) {
  return Object.freeze({
    interaction: "command",
    permission: "user",
    access: "public",
    ...input,
    examples: Object.freeze([...(input.examples || [])]),
    keywords: Object.freeze([...(input.keywords || [])]),
    scopes: Object.freeze([...(input.scopes || [])]),
  });
}

function buildCapabilityView(item, options, cfg) {
  const resolved = resolveAvailability(item, options, cfg);
  return {
    id: item.id,
    category: item.category,
    name: item.name,
    summary: item.summary,
    interaction: item.interaction,
    permission: item.permission,
    access: item.access,
    scopes: [...item.scopes],
    examples: item.examples.map(example => formatExample(example, options)),
    keywords: [...item.keywords],
    status: resolved.status,
    statusLabel: resolved.label,
    statusDetail: resolved.detail,
  };
}

function resolveAvailability(item, options, cfg) {
  if (item.reserved) return makeAvailability("reserved", "预留", "当前版本尚未启用");
  if (item.id === "chat.reply") {
    return cfg.mimoKey || cfg.dsKey
      ? makeAvailability("available", "可用", "MiMo 主答，DeepSeek 可兜底")
      : makeAvailability("unavailable", "不可用", "聊天模型尚未配置");
  }
  if (item.id === "vision.context") {
    return cfg.mimoKey || cfg.doubaoKey
      ? makeAvailability("available", "可用", "图片只用于当前理解，不保存原图")
      : makeAvailability("unavailable", "不可用", "视觉模型尚未配置");
  }
  if (item.access === "sticker-mode") return stickerAvailability(options, cfg);
  return resolveAccessAvailability(item, options, cfg);
}

function resolveAccessAvailability(item, options, cfg) {
  if (item.access === "link-preview") {
    return cfg.linkPreviewEnabled
      ? makeAvailability("available", "可用", "仅访问经过安全检查的公开链接")
      : makeAvailability("unavailable", "已关闭", "链接预览当前已关闭");
  }
  if (item.access === "meme-mode") {
    const mode = options.memeMode || cfg.memeLearningMode;
    if (mode === "off") return makeAvailability("unavailable", "已关闭", "梗库已关闭");
    if (mode === "shadow") return makeAvailability("limited", "只学习", "当前不会向回复注入梗义");
    return makeAvailability("available", "可用", "仅使用已启用且符合群范围的词条");
  }
  if (item.access === "summary-groups") {
    return whitelistAvailability(cfg.summaryGroupWhitelist, options, "群报", false);
  }
  if (item.access === "feature-groups") {
    return whitelistAvailability(cfg.featureGroupWhitelist, options, "词云", false);
  }
  if (item.access === "resource-groups") {
    return whitelistAvailability(cfg.resourceGroupWhitelist, options, "资源转发", false);
  }
  if (item.access === "jm") return jmAvailability(options, cfg);
  return makeAvailability("available", "可用", item.interaction === "automatic" ? "自动生效" : "命令可用");
}

function stickerAvailability(options, cfg) {
  const settings = options.stickerSettings || getStickerSettings();
  if (!cfg.stickerEnabled || settings.mode === "off") {
    return makeAvailability("unavailable", "已关闭", "收藏表情回复当前已关闭");
  }
  if (settings.mode === "shadow") {
    return makeAvailability("limited", "观察模式", "会选择匹配表情，但不会实际发送");
  }
  if (options.surface === "private" && settings.privateEnabled === false) {
    return makeAvailability("unavailable", "私聊已关闭", "收藏表情不会在私聊中发送");
  }
  if (options.surface === "group" && settings.groupEnabled === false) {
    return makeAvailability("unavailable", "群聊已关闭", "收藏表情不会在群聊中发送");
  }
  const groups = settings.allowedGroups?.length ? settings.allowedGroups : cfg.stickerGroupWhitelist;
  return whitelistAvailability(groups, options, "收藏表情回复", true);
}

function whitelistAvailability(whitelist, options, label, privateAllowed) {
  const values = Array.isArray(whitelist) ? whitelist.map(Number) : [];
  if (options.surface === "group" && options.groupId) {
    return values.includes(Number(options.groupId))
      ? makeAvailability("available", "本群可用", label + "已为当前群启用")
      : makeAvailability("limited", "本群未开放", label + "仅在已配置群使用");
  }
  if (options.surface === "private" && !privateAllowed) {
    return makeAvailability("limited", "仅限群聊", label + "不在私聊中运行");
  }
  if (!values.length) return makeAvailability("unavailable", "未配置", "尚未配置可用群");
  return makeAvailability("available", "已启用", values.length + " 个群已开放");
}

function jmAvailability(options, cfg) {
  if (!cfg.jmPython) return makeAvailability("unavailable", "依赖不可用", "JM Python 运行环境未配置");
  if (options.surface === "group" && options.groupId) {
    return whitelistAvailability(cfg.resourceGroupWhitelist, options, "JM", true);
  }
  if (options.surface === "private" && options.userId) {
    const allowed = (cfg.jmUserWhitelist || []).map(Number).includes(Number(options.userId));
    return allowed
      ? makeAvailability("available", "私聊可用", "当前账号已开放 JM")
      : makeAvailability("limited", "需要白名单", "当前账号未开放私聊 JM");
  }
  const groupCount = (cfg.resourceGroupWhitelist || []).length;
  const userCount = (cfg.jmUserWhitelist || []).length;
  if (!groupCount && !userCount) return makeAvailability("unavailable", "未配置", "尚未配置 JM 白名单");
  return makeAvailability("available", "已启用", groupCount + " 个群、" + userCount + " 个私聊账号已开放");
}

function makeAvailability(status, label, detail) {
  return { status, label, detail };
}

function isVisibleToUser(item, options, cfg) {
  if (item.permission !== "admin") return true;
  if (options.surface === "console") return true;
  const admins = (options.admins || cfg.adminUins || []).map(String);
  return admins.includes(String(options.userId || ""));
}

function buildCapabilityHubText(catalog, options) {
  const lines = ["夜星能力中心", ""];
  for (const category of catalog.categories) {
    lines.push(category.number + "  " + category.name);
  }
  lines.push(
    "",
    "查看分类：" + formatExample("@夜星 帮助 3", options),
    "查具体功能：" + formatExample("@夜星 JM怎么用", options),
  );
  if (options.surface !== "private") lines.push("群聊命令需要 @夜星，私聊可以省略。");
  return lines.join("\n");
}

function buildCategoryText(category, catalog, options) {
  const entries = catalog.capabilities.filter(item => item.category === category.id);
  const lines = [category.number + "/6 " + category.name, ""];
  for (const item of entries) {
    lines.push("• " + item.name + " [" + item.statusLabel + "]");
    lines.push("  " + item.summary);
    if (item.examples[0]) lines.push("  " + item.examples[0]);
  }
  lines.push("", "返回总目录：" + formatExample("@夜星 帮助", options));
  return lines.join("\n");
}

function buildCapabilityDetailText(entries, options) {
  const lines = [];
  for (const item of entries) {
    if (lines.length) lines.push("");
    lines.push(item.name + " [" + item.statusLabel + "]");
    lines.push(item.summary);
    lines.push("状态：" + item.statusDetail);
    if (item.examples.length) {
      lines.push("用法：");
      lines.push(...item.examples.map(example => "  " + example));
    }
  }
  lines.push("", "完整目录：" + formatExample("@夜星 帮助", options));
  return lines.join("\n");
}

function findCategory(query) {
  return CAPABILITY_CATEGORIES.find(category =>
    String(category.number) === query ||
    category.id === query ||
    category.name === query ||
    category.aliases.some(alias => query === normalizeQuery(alias))
  ) || null;
}

function findCapabilityViews(query, capabilities) {
  const compact = query.replace(/\s+/g, "");
  return capabilities
    .map(item => ({ item, score: capabilityMatchScore(compact, item) }))
    .filter(result => result.score > 0)
    .sort((a, b) => b.score - a.score || a.item.name.localeCompare(b.item.name, "zh-CN"))
    .map(result => result.item);
}

function capabilityMatchScore(query, item) {
  const name = normalizeQuery(item.name).replace(/\s+/g, "");
  if (query === name) return 100;
  let score = name.includes(query) || query.includes(name) ? 70 : 0;
  for (const keyword of item.keywords) {
    const value = normalizeQuery(keyword).replace(/\s+/g, "");
    if (query === value) score = Math.max(score, 95);
    else if (value.includes(query) || query.includes(value)) score = Math.max(score, 60);
  }
  return score;
}

function formatExample(example, options) {
  const value = String(example || "");
  if (options.surface !== "private") return value;
  return value
    .replace(/^私聊[：:]\s*/i, "")
    .replace(/^@夜星\s*/i, "");
}

function isSuggestionCandidate(value) {
  if (!value || value.length > 40) return false;
  const token = value.split(/\s+/)[0];
  if (!token || token.length > 12) return false;
  if (!/^[a-z0-9_-]+$/i.test(token)) return false;
  const argument = value.slice(token.length).trim();
  return !argument || /^\d{3,}$/.test(argument) || /^https?:\/\/\S+$/i.test(argument);
}

function normalizeQuery(value) {
  return String(value || "")
    .replace(/^[/\\]+/, "")
    .replace(/[。.!！?？]+$/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function safeDisplayQuery(value) {
  return String(value || "").replace(/[\r\n]/g, " ").slice(0, 24);
}

function levenshtein(left, right) {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i += 1) {
    let diagonal = previous[0];
    previous[0] = i;
    for (let j = 1; j <= right.length; j += 1) {
      const above = previous[j];
      previous[j] = Math.min(
        previous[j] + 1,
        previous[j - 1] + 1,
        diagonal + (left[i - 1] === right[j - 1] ? 0 : 1),
      );
      diagonal = above;
    }
  }
  return previous[right.length];
}
