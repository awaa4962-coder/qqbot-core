# 夜星桥接器更新日志

## v1.1.0 — 2026-06-18 11:00 — 🔍 四段安全审查 + 全线修复
- 🧹 **模块化重构补完**：修复 7 处缺失 import（model-ds/profiel/reply 多个模块拆分后引用断链）
- 🌊 **日志风暴保护修复**：冷却结束后自动重置，不再是"一次性"保护
- 🛡️ **SSRF 防护**：fetchFileContent 拒绝内网地址（127/10/192.168/172.x），防止文件消息打内网
- 📏 **OOM 防护**：图片下载限制 10MB、HTML 抓取限制 2MB、HTTP 请求体限制 1MB
- 🔒 **CORS 收紧**：从 `*` 全开改为仅允许 localhost，恶意网页无法操控机器人
- 💾 **存档异常可见**：flush 失败不再静默吞错，改为输出日志
- 🔗 **循环依赖打破**：getLatestChangelog 从 startup.mjs 迁至 context.mjs
- 🐛 **profile 画像修复**：补全 miMoContent import，画像生成不再静默降级
- 🔤 **URL 编码防御**：fetchReplyData 参数 encodeURIComponent
- 🗑️ **清理死代码**：移除 .history 遗留字段、删除 crossGroupCtx 未使用导出
- ⚡ **统一 API Key 前缀**：所有 MiMo/DS 调用统一用 `***` 前缀
- 📝 **搜索触发词收紧**：移除"最新""当前""现在怎么样"等日常高频误触发词
- 🖼️ **Vision 思维链过滤**：MiMo 图片理解增加 cleanThinking 检查，防止思维链泄露到群聊
- 🔧 **var→const** + generateProfile 错误日志
- 🏗️ **路径兼容**：config + daily_summary 改用 fileURLToPath 替代硬编码 C: 盘符

## v17 — 2026-06-15 23:40 — 🛡️ Anti-Storm
- 🛡️ **Anti-Storm 防护模块**：防止日志暴增/磁盘写死/事件循环堵塞
- 📝 **异步缓冲日志流**：用 WriteStream 替代 appendFileSync，批量刷盘，不堵事件循环
- 📏 **日志大小上限**：单日日志超过 50MB 自动截断，只记告警摘要
- 🌊 **日志风暴检测**：每秒超过 200 条日志自动冷却 60 秒
- ⏱ **存档防抖**：saveUsers/saveGroupChats 改为 30 秒异步批量写入，不再每条消息都写 ~2MB 文件
- 🚦 **事件限流**：每秒最多处理 20 个事件，超出丢弃并摘要
- 🔥 **重连冷却**：WebSocket 断开后 5 秒内拒绝新连接，防止重连死循环
- 💾 **退出前强制存档**：SIGINT/SIGTERM 时 flush 脏数据
- 🔧 致命异常 1 分钟内超过 10 个自动抑制详情，防止刷屏

## v16 — 2026-06-13 22:17
- 🐛 **修复 MiMo tool_call 泄露**：cleanThinking 新增 `<tool_call>` XML 过滤，防止模型把工具调用文本直接发到群聊
- ⏱ **sendMsg/sendPrivateMsg 加超时**：15s AbortSignal，防止 NapCat 卡住时永久挂起
- 🔍 **新增 Bing CN 搜索兜底**：Tavily 失败或未配置时自动走 cn.bing.com HTML 抓取（免费免 Key，国内可用）
- 🔍 **Tavily 超时降至 12s**：失败自动 fallback 到 Bing
- 📈 **随机插话 token 提升**：150→300，减少模型截断导致 tool_call 泄露

## v15 — 2026-06-12 00:34
- 🟣 **主力模型切换到 MiMo**：聊天从 Minimax M3 换成 Xiaomi MiMo V2 Flash
- 🔑 API Key 统一：移除 `.env_mm` / `.env_mm_vision`，改用 `.env_mimo`
- 👁️ 视觉模型也切 MiMo V2.5（兜底仍为豆包）
- 📝 画像生成改用 MiMo
- 🗑️ 移除所有 Minimax 依赖
- ⚡ 按量付费 ¥1-3/月，替代原来 ¥49/月订阅

## v14 — 2026-06-08
- 🔍 增加 Tavily 联网搜索（cn.bing.com HTML 抓取）
- 🧠 Minimax M3 工具调用支持（最多 3 轮 web_search）
- 📊 5 档加权上下文 + 跨群对话记忆
- 🖼️ M3 原生多模态看图 + 豆包视觉兜底
- 🎲 10% 随机插话
- 📝 日志铁律：只要跑就必须写日志

## v13 — 2026-06-05
- 🏗️ 从 napcat_bridge.js 重构为 napcat_bridge.mjs (ESM)
- 📦 WebSocket 支持：NapCat 直连桥接器
- 👥 用户画像系统：每 20 条 DeepSeek 提炼画像
- 🏷️ 关键词提取 + 用户记忆
- 🌐 群氛围感知

## v12 — 2026-06-01
- 🤖 初始版本上线
- 🔌 NapCat OneBot v11 集成
- 👥 QQ 群白名单 + 好友白名单
- 🔗 B站链接自动预览
- 📱 QQ 小程序卡片解析
- 💬 @ 回复 + 随机插话
