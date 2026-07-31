// bridge/knowledge/topic-rules.mjs — canonical topic detection rules shared by all modules.
// Used by: group-summary/digest.mjs, memory-profile.mjs, context-retriever.mjs

/** Digest categories — used by group-summary/digest.mjs countTopics() */
export const TOPIC_RULES = [
  ["机器人/模型", /bot|机器人|夜星|mimo|deepseek|ds|模型|思维链|上下文|自动回复|qqfriend|插话|概率|不回|沉默|thinking|reasoning/i],
  ["JM/资源", /jm|漫画|本子|下载|压缩包|解压|密码|文件|资源|图片包/i],
  ["运维/代码", /代码|bug|报错|修复|测试|lint|npm|node|日志|重启|白名单|配置|模块|缓存|临时文件|打包/i],
  ["日常闲聊", /吃|喝|睡|早|晚安|今天|明天|昨天|哈哈|笑死|草|乐/i],
  ["情绪氛围", /急|气|红温|难受|开心|烦|累|牛|厉害|绷|破防/i],
  ["图片/表情", /图片|表情|图|截图|照片|视频/i],
  ["游戏/娱乐", /游戏|开黑|抽卡|角色|剧情|番|音乐|电影/i],
  ["关系/画像", /好感度|关系|熟悉度|画像|记忆/i],
];

/** Memory profile topics — used by memory-profile.mjs detectTopics() */
export const MEMORY_TOPIC_RULES = [
  ["机器人", /bot|qqfriend|夜星|机器人|自动回复|上下文|模型|mimo|deepseek/i],
  ["漫画", /jm|漫画|本子|下载|图片包/i],
  ["运维", /报错|日志|重启|白名单|缓存|临时文件|打包|测试|lint/i],
  ["关系", /好感度|关系|熟悉度|画像|记忆/i],
];

/** Retrieval keywords — used by context-retriever.mjs extractKeywords() */
export const RETRIEVAL_KEYWORD_RULES = [
  ["jm", /jm|漫画|下载|本子|压缩包/i],
  ["上下文", /上下文|记忆|画像|关系|熟悉度/i],
  ["自动回复", /自动回复|插话|概率|不回|沉默/i],
  ["模型", /mimo|deepseek|ds|模型|thinking|reasoning/i],
  ["运维", /日志|重启|报错|白名单|缓存|临时文件|测试|lint/i],
];
