// Synthetic examples only. Never populate this catalog from production messages.
export const REPLAY_CASES = Object.freeze([
  {
    id: "continuation", name: "短句承接", input: "还是不行，下一步呢？",
    turns: [{ userSummary: "下载好了，但解压提示密码错误。", assistantSummary: "先确认密码使用大写 FS。" }],
    expectations: ["接着排查解压问题", "不再重复只让用户输入大写密码", "给一个具体下一步"],
  },
  {
    id: "speaker", name: "多人聊天对象", input: "小林，你试过他说的办法了吗？",
    background: ["speaker=小林 uid=12: 我更新驱动以后还是黑屏。", "speaker=阿南 uid=13: 可以试试换条显示器线。"],
    expectations: ["知道提问对象是小林", "不能冒充小林报告测试结果", "不要替任何人编造经历"],
  },
  {
    id: "nickname", name: "称呼纠正", input: "以后叫我小夏，别再叫小林了。",
    turns: [{ userSummary: "我之前叫小林。", assistantSummary: "好的，小林。" }],
    expectations: ["采用当前的新称呼", "不坚持旧画像", "简短自然地回应"],
  },
  {
    id: "meme-context", name: "表情结合语境", input: "这图就是我现在的心情。",
    quote: "刚说今天不用加班，五分钟后又临时开会。",
    image: "卡通人物面无表情，配字：好，真是太好了。",
    expectations: ["理解图文与加班语境的反差", "不当成真心称赞", "不猜具体人物姓名"],
  },
  {
    id: "unknown-meme", name: "未知梗不编造", input: "你知道蓝色螺丝煮月亮是什么梗吗？",
    expectations: ["承认缺乏可靠出处", "可以询问出现的语境", "不编造流行平台、作者或起源"],
  },
  {
    id: "sarcasm", name: "反讽理解", input: "可真太靠谱了。",
    quote: "约好八点到，现在九点半人还没影。",
    expectations: ["结合引用理解不满", "不把靠谱当成表扬", "避免说教和情绪分析长文"],
  },
  {
    id: "topic-switch", name: "切换话题", input: "先不聊下载了，17 加 25 等于多少？",
    turns: [{ userSummary: "压缩包下载卡住了。", assistantSummary: "可以稍后再试。" }],
    expectations: ["直接回答 42", "不继续讨论下载", "不为了人设改变答案"],
  },
  {
    id: "vision-missing", name: "识图失败边界", input: "这是谁？", image: "",
    expectations: ["知道图片识别未成功", "不声称认出人物", "必要时请求更清楚的图片"],
  },
  {
    id: "synonym-recall", name: "同义表达召回", input: "这个 archive 还是打不开，之前说缺什么？",
    memoryRows: [
      { group: "synthetic", messageId: "9101", text: "解压工具提示分卷缺失，应该先下载完整分卷。", ts: 1000 },
      { group: "synthetic", messageId: "9102", text: "今天晚饭准备吃面。", ts: 2000 },
      { group: "other", messageId: "9103", text: "另一个群的 archive 私有信息。", ts: 3000 },
    ],
    expectedSources: ["9101"], excludedSources: ["9102", "9103"],
    expectations: ["召回分卷缺失的信息", "不混入晚饭或其他群的记录", "说明下一步核对分卷是否齐全"],
  },
  {
    id: "quoted-topic", name: "引用链与旁支话题", input: "他换完之后好了吗？", quote: "换条显示器线试试。", replyToMessageId: "9202",
    groupRows: [
      { uid: "12", messageId: "9201", text: "更新驱动之后还是黑屏。", ts: 1000 },
      { uid: "13", messageId: "9202", replyToMessageId: "9201", text: "换条显示器线试试。", ts: 2000 },
      { uid: "14", messageId: "9203", text: "今晚火锅加点土豆。", ts: 3000 },
      { uid: "12", messageId: "9204", replyToMessageId: "9202", text: "线换了，还是黑屏。", ts: 4000 },
    ],
    expectedSources: ["9201", "9204"], excludedSources: ["9203"],
    expectations: ["依据后续反馈回答还没好", "知道是小组成员的经历，不能冒充自己", "不把火锅话题混进来"],
  },
  {
    id: "thread-reset", name: "旧任务退出", input: "先不聊下载了，换个话题，17加25是多少？",
    turns: [{ userSummary: "压缩包下载失败了。", assistantSummary: "检查网络后再尝试。" }],
    excludedContext: "检查网络后再尝试",
    expectations: ["直接回答 42", "上下文不注入旧下载任务", "不重复上一轮排查建议"],
  },
]);
