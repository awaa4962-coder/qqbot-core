// bridge/commands/manifest.mjs - declarative command metadata shared by registry and help.

export const COMMAND_DEFINITIONS = Object.freeze([
  {
    id: "help-page-1",
    permission: "user",
    aliases: ["help", "帮助", "你能干嘛", "你能做什么", "你会什么", "能做什么", "怎么用", "能力", "功能"],
    helpLine: "  help / 帮助          打开能力中心",
  },
  {
    id: "help-page-2",
    permission: "user",
    aliases: [],
    helpLine: "  帮助 1～6            查看能力分类",
    pattern: /^(?:help|帮助)\s*[1-6]$/,
  },
  {
    id: "ping",
    permission: "user",
    aliases: ["ping", "测试"],
    helpPage: 1,
    helpLine: "  ping        测试在线",
  },
  {
    id: "status",
    permission: "user",
    aliases: ["status", "状态"],
    helpPage: 1,
    helpLine: "  状态        查看运行状态",
  },
  {
    id: "cache-stats",
    permission: "user",
    aliases: ["缓存", "缓存命中", "缓存命中率", "我的缓存", "cache", "cache stats"],
    helpPage: 6,
    helpLine: "  缓存命中    查看自己的缓存率",
  },
  {
    id: "version",
    permission: "user",
    aliases: ["version", "版本"],
    helpPage: 2,
    helpLine: "  version / 版本       查看版本",
  },
  {
    id: "changelog",
    permission: "user",
    aliases: ["更新", "更新日志", "更新列表", "历史更新", "changelog"],
    helpPage: 1,
    helpLine: "  更新        查看更新日志",
  },
  {
    id: "changelog-list",
    permission: "user",
    aliases: [],
    helpPage: 2,
    helpLine: "  更新列表             查看历代版本",
  },
  {
    id: "changelog-version",
    permission: "user",
    aliases: [],
    helpPage: 2,
    helpLine: "  更新 v1.2.3          查看指定版本",
  },
  {
    id: "changelog-search",
    permission: "user",
    aliases: [],
    helpPage: 2,
    helpLine: "  更新 jm              搜索相关更新",
  },
  {
    id: "relationship",
    permission: "user",
    aliases: ["好感度", "关系", "熟悉度", "my-status"],
    helpPage: 1,
    helpLine: "  好感度      查看互动熟悉度",
  },
  {
    id: "relationship-aliases",
    permission: "user",
    aliases: [],
    helpPage: 2,
    helpLine: "  关系 / 熟悉度        同好感度",
  },
  {
    id: "profile",
    permission: "user",
    aliases: ["我的档案", "my-profile"],
    helpPage: 1,
    helpLine: "  我的档案    查看安全画像摘要",
  },
  {
    id: "privacy",
    permission: "user",
    aliases: ["隐私", "privacy"],
    helpPage: 1,
    helpLine: "  隐私        查看隐私说明",
  },
  {
    id: "jm",
    permission: "user",
    aliases: [],
    helpPage: 1,
    helpLine: "  jm <代码>   下载并转发 JM",
    handledBy: "reply",
  },
  {
    id: "link-preview",
    permission: "user",
    aliases: [],
    helpPage: 2,
    helpLine: "  preview <url>          preview a public link",
    handledBy: "reply",
  },
  {
    id: "wordcloud",
    permission: "user",
    aliases: [],
    helpPage: 2,
    helpLine: "  词云 / 词云 7天          生成群聊热词图",
    handledBy: "reply",
  },
  {
    id: "meme-status",
    permission: "user",
    aliases: ["梗库", "梗库 状态", "meme status"],
    helpPage: 2,
    helpLine: "  梗库 / 梗库 搜 关键词      查看自动学习到的梗",
  },
  {
    id: "meme-search",
    permission: "user",
    aliases: [],
    helpPage: 2,
    helpLine: "  梗库 搜 哈基米           搜索梗义和使用场景",
    pattern: /^(梗库|meme)\s+(搜|搜索|search)\s+.+$/,
  },
  {
    id: "set-display-name",
    permission: "user",
    aliases: [],
    helpPage: 2,
    helpLine: "  设置称呼 <名字>      保存你的称呼",
    pattern: /^设置称呼\s+/,
  },
  {
    id: "reply-style",
    permission: "user",
    aliases: ["回复风格"],
    helpPage: 2,
    helpLine: "  回复风格 <偏好>      设置回复风格",
    pattern: /^回复风格(?:\s+|$)/,
  },
  {
    id: "reply-style-help",
    permission: "user",
    aliases: [],
    helpPage: 2,
    helpLine: "  回复风格 帮助        查看风格选项",
  },
  {
    id: "forget-me",
    permission: "user",
    aliases: ["忘记我", "forget me"],
    helpPage: 2,
    helpLine: "  忘记我               清理你的个人记忆",
  },
  {
    id: "admin-help",
    permission: "admin",
    aliases: ["admin help", "管理帮助"],
    adminSection: "base",
    helpLine: "  管理帮助：admin help / 管理帮助",
  },
  {
    id: "runtime",
    permission: "admin",
    aliases: ["runtime", "运行状态"],
    adminSection: "base",
    helpLine: "  查看运行状态：runtime / 运行状态",
  },
  {
    id: "memory-status",
    permission: "admin",
    aliases: ["memory status"],
    adminSection: "memory",
    helpLine: "  查看画像状态：memory status",
  },
  {
    id: "memory-summary",
    permission: "admin",
    aliases: [],
    adminSection: "memory",
    helpLine: "  查看用户画像：memory summary QQ号",
    pattern: /^memory summary \d+$/,
  },
  {
    id: "memory-clear-user",
    permission: "admin",
    aliases: [],
    adminSection: "memory",
    helpLine: "  清理用户画像：memory clear user QQ号",
    pattern: /^memory clear user \d+$/,
  },
  {
    id: "memory-clear-group",
    permission: "admin",
    aliases: ["memory clear group"],
    adminSection: "memory",
    helpLine: "  清理当前群画像：memory clear group",
  },
  {
    id: "export-relationships",
    permission: "admin",
    aliases: ["export-relationships", "export-relationships csv", "export-relationships json", "export-relationships md", "/export-relationships"],
    adminSection: "reserved",
    helpLine: "  关系导出：暂未启用",
    reserved: true,
  },
  {
    id: "export-relationships-format",
    permission: "admin",
    aliases: [],
    adminSection: "reserved",
    helpLine: "  导出格式：预留中，当前不会生成文件",
    reserved: true,
  },
  {
    id: "meme-toggle",
    permission: "admin",
    aliases: [],
    adminSection: "base",
    helpLine: "  梗库反悔：梗库 禁用 关键词 / 梗库 启用 关键词",
    pattern: /^(梗库|meme)\s+(禁用|启用|disable|enable)\s+.+$/,
  },
]);

export function commandAliases(filter = {}) {
  return COMMAND_DEFINITIONS
    .filter(command => matchesFilter(command, filter))
    .flatMap(command => command.aliases || []);
}

export function commandAliasesForId(id) {
  return commandAliases({ id });
}

export function commandPatterns(filter = {}) {
  return COMMAND_DEFINITIONS
    .filter(command => matchesFilter(command, filter))
    .map(command => command.pattern)
    .filter(Boolean);
}

export function helpLinesForPage(page) {
  return COMMAND_DEFINITIONS
    .filter(command => command.permission === "user" && command.helpPage === page && command.helpLine)
    .map(command => command.helpLine);
}

export function adminHelpLines(section) {
  return COMMAND_DEFINITIONS
    .filter(command => command.permission === "admin" && command.adminSection === section && command.helpLine)
    .map(command => command.helpLine);
}

export function commandIds() {
  return COMMAND_DEFINITIONS.map(command => command.id);
}

function matchesFilter(command, filter) {
  if (filter.id && command.id !== filter.id) return false;
  if (filter.permission && command.permission !== filter.permission) return false;
  if (filter.adminSection && command.adminSection !== filter.adminSection) return false;
  if (filter.helpPage && command.helpPage !== filter.helpPage) return false;
  if (filter.reserved !== undefined && Boolean(command.reserved) !== filter.reserved) return false;
  return true;
}
