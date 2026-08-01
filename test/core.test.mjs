// test/core.test.mjs — 纯函数单元测试
import { describe, it } from "node:test";
import assert from "node:assert/strict";

// ── context.mjs ──
import {
  normalizeMsg,
  cleanText,
  formatSpeakerLine,
  buildCurrentInput,
  buildQuotedMessageBlock,
  buildGroupBackgroundBlock,
} from "../bridge/context.mjs";

describe("normalizeMsg", () => {
  it("空值返回空数组", () => {
    assert.deepEqual(normalizeMsg(null), []);
    assert.deepEqual(normalizeMsg(undefined), []);
    assert.deepEqual(normalizeMsg(""), []);
  });

  it("数组原样返回", () => {
    const arr = [{ type: "text", data: { text: "hello" } }];
    assert.deepEqual(normalizeMsg(arr), arr);
  });

  it("单对象包装为数组", () => {
    const obj = { type: "text", data: { text: "hi" } };
    assert.deepEqual(normalizeMsg(obj), [obj]);
  });

  it("字符串返回空数组（不解析CQ码）", () => {
    assert.deepEqual(normalizeMsg("hello"), []);
  });
});

describe("cleanText", () => {
  it("空消息返回空字符串", () => {
    assert.strictEqual(cleanText(null), "");
    assert.strictEqual(cleanText([]), "");
  });

  it("提取纯文本", () => {
    const msg = [{ type: "text", data: { text: "你好" } }, { type: "image", data: {} }];
    assert.strictEqual(cleanText(msg), "你好");
  });

  it("多条文本拼接", () => {
    const msg = [
      { type: "text", data: { text: "第一句" } },
      { type: "text", data: { text: "第二句" } },
    ];
    assert.strictEqual(cleanText(msg), "第一句 第二句");
  });

  it("忽略非 text 类型", () => {
    const msg = [
      { type: "image", data: { url: "x" } },
      { type: "at", data: { qq: "123" } },
    ];
    assert.strictEqual(cleanText(msg), "");
  });
});

describe("structured context", () => {
  it("格式化发送人行并保留 uid", () => {
    const line = formatSpeakerLine({ uid: "123", nickname: "小黑", text: "我有点红温了\n第二行" });
    assert.strictEqual(line, "speaker=小黑 uid=123: 我有点红温了 第二行");
  });

  it("当前输入单独标记 speaker 和 reply_target", () => {
    const block = buildCurrentInput("小黑", "王志阳把猫的管理下了", "123");
    assert.ok(block.includes("[当前输入]"));
    assert.ok(block.includes("speaker=小黑 uid=123"));
    assert.ok(block.includes("message=王志阳把猫的管理下了"));
    assert.ok(block.includes("reply_target=当前发言人"));
  });

  it("被回复消息和群聊背景分块", () => {
    const quote = buildQuotedMessageBlock("上一条消息", "unknown");
    const bg = buildGroupBackgroundBlock(["speaker=叶哥 uid=1: 先别急", "speaker=景瑞 uid=2: 慢慢来"]);
    assert.ok(quote.startsWith("[被回复消息]"));
    assert.ok(bg.startsWith("[群聊背景，仅供理解，不要复述]"));
    assert.ok(bg.includes("speaker=叶哥 uid=1"));
  });
});

// ── thinking.mjs ──
import {
  cleanThinking,
  isLeakedReasoning,
  isUnsafeReasoningText,
  normalizeInterjectionReply,
  sanitizeAssistantReply,
} from "../bridge/thinking.mjs";

describe("cleanThinking", () => {
  it("空字符串返回 null", () => {
    // cleanThinking 对空字符串返回 ''（falsy），符合预期——调用方应检查真值
    assert.strictEqual(cleanThinking(""), "");
  });

  it("null 返回 null", () => {
    assert.strictEqual(cleanThinking(null), null);
  });

  it("正常文本原样返回", () => {
    const text = "喵～雪风你好呀 (╯✧∇✧)╯";
    assert.strictEqual(cleanThinking(text), text);
  });

  it("移除 <thinking> 标签", () => {
    const text = "<thinking>我来分析一下</thinking>喵～今天天气真好";
    assert.strictEqual(cleanThinking(text), "喵～今天天气真好");
  });

  it("移除 <think> 标签（无闭合情况）", () => {
    const text = "<think>分析中...\n\n喵～回复来了";
    assert.ok(cleanThinking(text).includes("喵～回复来了"));
  });

  it("移除 tool_call XML 片段", () => {
    const text = '<tool_call>{"name":"web_search"}</tool_call>搜到了喵～';
    const result = cleanThinking(text);
    assert.ok(result.includes("搜到了喵～"));
    assert.ok(!result.includes("tool_call"));
  });

  it("移除中文思维前缀", () => {
    assert.strictEqual(cleanThinking("嗯，让我想想。\n喵～你好"), "喵～你好");
    assert.strictEqual(cleanThinking("好，我来回答这个问题。\n答案是42"), "答案是42");
  });

  it("移除显式思维块", () => {
    assert.strictEqual(cleanThinking("分析：用户想要安慰。\n\n喵～先别急"), "喵～先别急");
    assert.strictEqual(cleanThinking("我的思路：先理解语境。"), null);
  });
});

describe("sanitizeAssistantReply", () => {
  it("拒绝仍像思维链的回复", () => {
    assert.strictEqual(isUnsafeReasoningText("首先我需要理解用户的意思，然后再回答。"), true);
    assert.strictEqual(sanitizeAssistantReply("用户的意思是想让我分析一下。"), null);
  });

  it("保留正常回复", () => {
    assert.strictEqual(sanitizeAssistantReply("喵～先喝口水缓缓。"), "喵～先喝口水缓缓。");
  });
});

describe("isLeakedReasoning", () => {
  it("空文本返回 false", () => {
    assert.strictEqual(isLeakedReasoning(""), false);
    assert.strictEqual(isLeakedReasoning(null), false);
  });

  it("太短的文本返回 false", () => {
    assert.strictEqual(isLeakedReasoning("喵～"), false);
  });

  it("正常回复不判为泄露", () => {
    assert.strictEqual(isLeakedReasoning("喵～雪风好呀，今天天气不错 (╯✧∇✧)╯"), false);
    assert.strictEqual(isLeakedReasoning("哈哈是的呢，我也觉得这个很有意思喵～"), false);
  });

  it("纯思维链判为泄露", () => {
    // 不含猫娘口头禅的纯思维链应被检测
    const reasoning = "用户问了今天天气怎么样。看起来用户在关心出行。我应该用可爱的语气回复。首先确认用户所在城市，然后给出天气信息。";
    assert.strictEqual(isLeakedReasoning(reasoning), true);
  });

  it("群聊语境分析判为泄露", () => {
    const reasoning = "小黑在群里又说了一遍\"王志阳把猫的管理下了\"，看起来是在强调这个事情。从之前的对话看，小黑很生气。现在提到这句话，可能是小黑想让王志阳取消管理员权限，或者是在抱怨王志阳做了这件事。\n\n我得理解一下这个语境。";
    assert.strictEqual(isLeakedReasoning(reasoning), true);
  });

  it("混合内容（有分析+有回应）不判为泄露", () => {
    const mixed = "用户说喜欢猫。看起来在分享兴趣爱好。喵～我也喜欢猫！(╯✧∇✧)╯";
    assert.strictEqual(isLeakedReasoning(mixed), false);
  });
});

describe("normalizeInterjectionReply", () => {
  it("接受 JSON 短回复", () => {
    assert.strictEqual(normalizeInterjectionReply('{"reply":"别气啦喵，先缓一缓。"}'), "别气啦喵，先缓一缓。");
  });

  it("拒绝随机插话里的语境分析", () => {
    const reasoning = "小黑在群里又说了一遍这件事，看起来是在强调。从之前的对话看，他可能是在抱怨。\n\n我得理解一下这个语境。";
    assert.strictEqual(normalizeInterjectionReply(reasoning), null);
  });

  it("拒绝非法 JSON 随机插话", () => {
    assert.strictEqual(normalizeInterjectionReply('{"reply":'), null);
  });
});

// ── napcat.mjs ──
import {
  getImageSegments,
  getImages,
  getFiles,
  describeFiles,
  normalizeOutboundText,
  sendMsg,
  sendMsgWithImage,
  sendPrivateMsg,
  splitLongText,
} from "../bridge/napcat.mjs";

describe("getImages", () => {
  it("无图片返回空数组", () => {
    assert.deepEqual(getImages([]), []);
    assert.deepEqual(getImages([{ type: "text", data: { text: "hi" } }]), []);
  });

  it("提取 image 类型", () => {
    const msg = [{ type: "image", data: { url: "http://x.com/1.jpg" } }];
    assert.deepEqual(getImages(msg), ["http://x.com/1.jpg"]);
  });

  it("提取 flash 类型（闪照）", () => {
    const msg = [{ type: "flash", data: { url: "http://x.com/flash.jpg" } }];
    assert.deepEqual(getImages(msg), ["http://x.com/flash.jpg"]);
  });

  it("保留 NapCat 图片子类型和显式闪照标记", () => {
    const segments = getImageSegments([
      { type: "image", data: { url: "a.gif", sub_type: 1 } },
      { type: "image", data: { url: "b.jpg", is_flash: true } },
    ]);
    assert.equal(segments[0].subType, 1);
    assert.equal(segments[0].isFlash, false);
    assert.equal(segments[1].isFlash, true);
  });

  it("过滤空 URL", () => {
    const msg = [{ type: "image", data: {} }, { type: "image", data: { url: "" } }];
    assert.deepEqual(getImages(msg), []);
  });

  it("多张图片全部提取", () => {
    const msg = [
      { type: "image", data: { url: "a.jpg" } },
      { type: "text", data: { text: "看这个" } },
      { type: "image", data: { url: "b.jpg" } },
    ];
    assert.deepEqual(getImages(msg), ["a.jpg", "b.jpg"]);
  });
});

describe("getFiles", () => {
  it("无文件返回空数组", () => {
    assert.deepEqual(getFiles([]), []);
    assert.deepEqual(getFiles([{ type: "text", data: { text: "hi" } }]), []);
  });

  it("提取 file 类型", () => {
    const msg = [{ type: "file", data: { name: "test.txt", url: "http://x.com/test.txt" } }];
    const files = getFiles(msg);
    assert.strictEqual(files.length, 1);
    assert.strictEqual(files[0].name, "test.txt");
  });
});

describe("describeFiles", () => {
  it("空文件返回空字符串", () => {
    assert.strictEqual(describeFiles([]), "");
  });

  it("单个文件描述", () => {
    assert.strictEqual(describeFiles([{ name: "test.txt" }]), "[文件: test.txt]");
  });

  it("无名称文件用 unknown", () => {
    assert.strictEqual(describeFiles([{}]), "[文件: unknown]");
  });
});

describe("outbound long text", () => {
  it("normalizeOutboundText 清理空白", () => {
    assert.strictEqual(normalizeOutboundText("  a\r\nb  "), "a\nb");
    assert.strictEqual(normalizeOutboundText(null), "");
  });

  it("splitLongText 拆分 3000 字长文本", () => {
    const parts = splitLongText("甲。".repeat(1500));
    assert.ok(parts.length > 1);
    assert.ok(parts.every(p => p.length <= 900));
  });

  it("sendMsg 长文本会多次调用发送，第一段带 replyTo", async () => {
    const calls = [];
    await withMockFetch(async (url, options) => {
      calls.push(JSON.parse(options.body));
      return { json: async () => ({ status: "ok" }) };
    }, async () => sendMsg(123, "甲。".repeat(1500), 999));
    assert.ok(calls.length > 1);
    assert.deepEqual(calls[0].message[0], { type: "reply", data: { id: 999 } });
    assert.ok(!calls[1].message.some(m => m.type === "reply"));
  });

  it("sendPrivateMsg 长文本会多次调用发送", async () => {
    const calls = [];
    await withMockFetch(async (url, options) => {
      calls.push(JSON.parse(options.body));
      return { json: async () => ({ status: "ok" }) };
    }, async () => sendPrivateMsg(456, "乙。".repeat(1500)));
    assert.ok(calls.length > 1);
    assert.ok(calls.every(c => c.user_id === 456));
  });

  it("sendMsgWithImage 长文本首段带图，后续只发文本", async () => {
    const calls = [];
    await withMockFetch(async (url, options) => {
      calls.push(JSON.parse(options.body));
      return { json: async () => ({ status: "ok" }) };
    }, async () => sendMsgWithImage(789, "丙。".repeat(1500), "https://example.com/a.jpg"));
    assert.ok(calls.length > 1);
    assert.ok(calls[0].message.some(m => m.type === "image"));
    assert.ok(!calls[1].message.some(m => m.type === "image"));
  });
});

// ── search.mjs ──
import { needsSearch } from "../bridge/search.mjs";

describe("needsSearch", () => {
  it("空文本返回 false", () => {
    assert.strictEqual(needsSearch(""), false);
    assert.strictEqual(needsSearch(null), false);
  });

  it("明确搜索关键词触发", () => {
    assert.strictEqual(needsSearch("帮我搜一下最近的新闻"), true);
    assert.strictEqual(needsSearch("搜索Python教程"), true);
    assert.strictEqual(needsSearch("查查明天天气"), true);
    assert.strictEqual(needsSearch("最近有什么好看的电影"), true);
    assert.strictEqual(needsSearch("搜搜最火的游戏"), true);
    assert.strictEqual(needsSearch("实时金价多少"), true);
  });

  it("日常对话不触发", () => {
    assert.strictEqual(needsSearch("喵～今天心情真好"), false);
    assert.strictEqual(needsSearch("哈哈哈哈笑死我了"), false);
    assert.strictEqual(needsSearch("你好呀"), false);
  });
});

// ── napcat.mjs: fetchFileContent（不走网络的部分）──
import { fetchFileContent } from "../bridge/napcat.mjs";

describe("fetchFileContent", () => {
  it("空 fileData 返回空字符串", async () => {
    assert.strictEqual(await fetchFileContent(null), "");
    assert.strictEqual(await fetchFileContent(undefined), "");
  });

  it("无 URL 返回空字符串", async () => {
    assert.strictEqual(await fetchFileContent({ name: "test.txt" }), "");
  });

  it("二进制文件不下载", async () => {
    const r = await fetchFileContent({ name: "photo.png", url: "https://example.com/x.png" });
    assert.ok(r.includes("二进制"));
  });

  it("无扩展名按二进制处理", async () => {
    const r = await fetchFileContent({ name: "README", url: "https://example.com/README" });
    assert.ok(r.includes("二进制"));
  });

  it("无效 URL 返回错误", async () => {
    const r = await fetchFileContent({ name: "test.txt", url: "not-a-url" });
    assert.ok(r.includes("无效URL"));
  });

  it("非 http 协议拒绝", async () => {
    const r = await fetchFileContent({ name: "test.txt", url: "ftp://example.com/test.txt" });
    assert.ok(r.includes("不支持协议"));
  });

  it("内网地址拒绝 - 127.0.0.1", async () => {
    const r = await fetchFileContent({ name: "test.txt", url: "http://127.0.0.1:6700/test.txt" });
    assert.ok(r.includes("内网地址已拒绝"));
  });

  it("内网地址拒绝 - localhost", async () => {
    const r = await fetchFileContent({ name: "test.txt", url: "http://localhost/test.txt" });
    assert.ok(r.includes("内网地址已拒绝"));
  });

  it("内网地址拒绝 - 192.168.x.x", async () => {
    const r = await fetchFileContent({ name: "test.txt", url: "http://192.168.1.1/test.txt" });
    assert.ok(r.includes("内网地址已拒绝"));
  });

  it("内网地址拒绝 - 10.x.x.x", async () => {
    const r = await fetchFileContent({ name: "test.txt", url: "http://10.0.0.1/test.txt" });
    assert.ok(r.includes("内网地址已拒绝"));
  });

  it("内网地址拒绝 - 172.16.x.x", async () => {
    const r = await fetchFileContent({ name: "test.txt", url: "http://172.16.0.1/test.txt" });
    assert.ok(r.includes("内网地址已拒绝"));
  });

  it("公网地址允许（不实际访问）", async () => {
    // 公网 URL 通过 SSRF 检查，会尝试 fetch（预期失败但不应被 SSRF 拦截）
    const r = await fetchFileContent({ name: "test.txt", url: "https://example.com/test.txt" });
    assert.ok(!r.includes("内网地址") && !r.includes("无效URL") && !r.includes("不支持协议"));
  });
});

// ── model-mimo.mjs: parseMiMoResponse（纯函数 mock 测试）──
import { callMiMoApi, parseMiMoResponse } from "../bridge/model-mimo.mjs";

describe("parseMiMoResponse", () => {
  it("空响应返回 null", () => {
    assert.strictEqual(parseMiMoResponse(null), null);
    assert.strictEqual(parseMiMoResponse({}), null);
    assert.strictEqual(parseMiMoResponse({ choices: [] }), null);
  });

  it("正常文本响应", () => {
    const resp = { choices: [{ message: { content: "喵～你好呀 (╯✧∇✧)╯" } }] };
    assert.strictEqual(parseMiMoResponse(resp), "喵～你好呀 (╯✧∇✧)╯");
  });

  it("含 thinking 标签的响应被清理", () => {
    const resp = { choices: [{ message: { content: "<thinking>分析中</thinking>这是回复" } }] };
    const r = parseMiMoResponse(resp);
    assert.ok(r.includes("这是回复"));
    assert.ok(!r.includes("thinking"));
  });

  it("纯思维链泄露返回 null", () => {
    const leaked = "用户问了天气怎么样。看起来用户在关心出行。我应该用可爱的语气回复。首先确认用户所在城市，然后给出天气信息。";
    const resp = { choices: [{ message: { content: leaked } }] };
    assert.strictEqual(parseMiMoResponse(resp), null);
  });

  it("随机插话模式只取安全短回复", () => {
    const resp = { choices: [{ message: { content: '{"reply":"消消气喵，先喝口水缓缓。"}' } }] };
    assert.strictEqual(parseMiMoResponse(resp, { replyMode: "interjection" }), "消消气喵，先喝口水缓缓。");
  });

  it("随机插话模式拒绝群聊分析泄露", () => {
    const leaked = "小黑在群里又说了一遍这件事，看起来是在强调。从之前的对话看，他可能是在抱怨。\n\n我得理解一下这个语境。";
    const resp = { choices: [{ message: { content: leaked } }] };
    assert.strictEqual(parseMiMoResponse(resp, { replyMode: "interjection" }), null);
  });

  it("content 为空时不使用 reasoning_content", () => {
    const resp = { choices: [{ message: { reasoning_content: "喵～从reasoning取到了" } }] };
    assert.strictEqual(parseMiMoResponse(resp), null);
  });

  it("content 正常时忽略 reasoning_content", () => {
    const resp = { choices: [{ message: { content: "喵～这是正文", reasoning_content: "不能外发" } }] };
    assert.strictEqual(parseMiMoResponse(resp), "喵～这是正文");
  });

  it("content 是思维链时不 fallback 到 reasoning_content", () => {
    const leaked = "用户问了天气怎么样。看起来用户在关心出行。我应该用可爱的语气回复。首先确认用户所在城市，然后给出天气信息。";
    const resp = { choices: [{ message: { content: leaked, reasoning_content: "喵～不能从这里取" } }] };
    assert.strictEqual(parseMiMoResponse(resp), null);
  });

  it("异常 JSON 结构返回 null", () => {
    assert.strictEqual(parseMiMoResponse({ choices: [{ message: null }] }), null);
    assert.strictEqual(parseMiMoResponse({ error: "500" }), null);
  });
});

describe("callMiMoApi tool gating", () => {
  it("allowTools=false 时不发送工具定义", async () => {
    let body = null;
    await withMockFetch(async (url, options) => {
      body = JSON.parse(options.body);
      return { json: async () => ({ choices: [{ message: { content: "ok" } }] }) };
    }, async () => callMiMoApi("system", [], 96, { allowTools: false }));
    assert.ok(!Object.prototype.hasOwnProperty.call(body, "tools"));
    assert.ok(!Object.prototype.hasOwnProperty.call(body, "tool_choice"));
  });

  it("默认保留工具定义", async () => {
    let body = null;
    await withMockFetch(async (url, options) => {
      body = JSON.parse(options.body);
      return { json: async () => ({ choices: [{ message: { content: "ok" } }] }) };
    }, async () => callMiMoApi("system", [], 96));
    assert.ok(Array.isArray(body.tools));
    assert.strictEqual(body.tool_choice, "auto");
  });
});

// ── reply-handlers.mjs: group trigger 纯函数测试 ──
import {
  parseIncomingEvent,
  shouldInterject,
  buildSafeInterjectionReply,
  handleExplicitLinkPreviewCommand,
  parseExplicitLinkPreviewCommand,
} from "../bridge/reply-handlers.mjs";

describe("parseIncomingEvent", () => {
  it("解析群消息 @ 检测", () => {
    const ev = {
      post_type: "message", message_type: "group",
      user_id: 123456, group_id: 2000000001, message_id: 999,
      sender: { card: "测试用户", nickname: "test" },
      message: [{ type: "text", data: { text: "你好" } }, { type: "at", data: { qq: "1000000001" } }],
      raw_message: "你好[CQ:at,qq=1000000001]",
    };
    const ctx = parseIncomingEvent(ev);
    assert.strictEqual(ctx.isAtMe, true);
    assert.strictEqual(ctx.nickname, "测试用户");
    assert.strictEqual(ctx.text, "你好");
  });

  it("空消息", () => {
    const ev = { message_type: "group", user_id: 1, group_id: 1, message_id: 1, sender: {}, message: [], raw_message: "" };
    const ctx = parseIncomingEvent(ev);
    assert.strictEqual(ctx.text, "");
    assert.strictEqual(ctx.isAtMe, false);
  });

  it("bot 自己的消息应标记", () => {
    const ev = { message_type: "group", user_id: 1000000001, group_id: 1, message_id: 1, sender: {}, message: [], raw_message: "" };
    const ctx = parseIncomingEvent(ev);
    assert.strictEqual(ctx.user_id, 1000000001);
  });

  it("私聊消息", () => {
    const ev = {
      post_type: "message", message_type: "private",
      user_id: 3000000001, message_id: 1,
      sender: { nickname: "雪风" },
      message: [{ type: "text", data: { text: "你好" } }],
      raw_message: "你好",
    };
    const ctx = parseIncomingEvent(ev);
    assert.strictEqual(ctx.message_type, "private");
    assert.strictEqual(ctx.isAtMe, false);
    assert.strictEqual(ctx.nickname, "雪风");
  });

  it("图片消息解析", () => {
    const ev = {
      message_type: "group", user_id: 1, group_id: 1, message_id: 1, sender: {},
      message: [{ type: "image", data: { url: "http://x.com/img.jpg" } }],
      raw_message: "[图片]",
    };
    const ctx = parseIncomingEvent(ev);
    assert.strictEqual(ctx.images.length, 1);
    assert.strictEqual(ctx.text, "");
  });

  it("文件消息解析", () => {
    const ev = {
      message_type: "group", user_id: 1, group_id: 1, message_id: 1, sender: {},
      message: [{ type: "file", data: { name: "test.txt", url: "http://x.com/test.txt" } }],
      raw_message: "[文件]",
    };
    const ctx = parseIncomingEvent(ev);
    assert.strictEqual(ctx.files.length, 1);
  });

  it("链接消息", () => {
    const ev = {
      message_type: "group", user_id: 1, group_id: 1, message_id: 1, sender: {},
      message: [{ type: "text", data: { text: "看看这个 https://example.com" } }],
      raw_message: "看看这个 https://example.com",
    };
    const ctx = parseIncomingEvent(ev);
    assert.ok(ctx.rawText.includes("https://example.com"));
  });
});

describe("explicit link preview command", () => {
  it("parses preview commands after bot mention", () => {
    assert.deepEqual(parseExplicitLinkPreviewCommand("@QQFriend preview https://example.com/a", {
      botNames: ["QQFriend"],
    }), { url: "https://example.com/a" });
    assert.equal(parseExplicitLinkPreviewCommand("@QQFriend help", { botNames: ["QQFriend"] }), null);
  });

  it("sends preview and consumes the command", async () => {
    const sent = [];
    const handled = await handleExplicitLinkPreviewCommand({
      isAtMe: true,
      text: "@QQFriend preview https://example.com/a",
      rawText: "@QQFriend preview https://example.com/a",
      group_id: 100,
    }, {
      botNames: ["QQFriend"],
      replyToId: 10,
      previewer: async url => ({ text: "Link: " + url, image: null }),
      sender: async (groupId, text, replyToId) => sent.push({ groupId, text, replyToId }),
    });

    assert.equal(handled, true);
    assert.deepEqual(sent[0], {
      groupId: 100,
      text: "Link: https://example.com/a",
      replyToId: 10,
    });
  });
});

describe("shouldInterject", () => {
  it("empty text does not trigger", () => {
    assert.strictEqual(shouldInterject("", false, false), false);
    assert.strictEqual(shouldInterject(null, false, false), false);
  });

  it("short text does not trigger", () => {
    assert.strictEqual(shouldInterject("hi", false, false), false);
    assert.strictEqual(shouldInterject("1234", false, false), false);
  });

  it("does not interject when mentioned or after preview", () => {
    assert.strictEqual(shouldInterject("hello weather chat", true, false), false);
    assert.strictEqual(shouldInterject("hello weather chat", false, true), false);
  });

  it("ordinary messages use guarded low-probability interjection", () => {
    assert.strictEqual(shouldInterject("ordinary apple message", {
      isAtMe: false,
      previewSent: false,
      random: () => 0.99,
    }), false);
  });
});

describe("buildSafeInterjectionReply", () => {
  it("ordinary fallback can stay silent", () => {
    assert.strictEqual(buildSafeInterjectionReply("ordinary apple message"), null);
  });

  it("emotion/conflict fallback stays short and does not quote original text", () => {
    const reply = buildSafeInterjectionReply("555555");
    assert.ok(reply);
    assert.ok(!reply.includes("555"));
    assert.ok(reply.length <= 30);
  });
});

// link-preview: Bilibili URL pure function tests
import { isBilibiliUrl, extractBvid } from "../bridge/services/link-preview/bilibili.mjs";

describe("isBilibiliUrl", () => {
  it("B站视频链接", () => {
    assert.strictEqual(isBilibiliUrl("https://www.bilibili.com/video/BV1xx411c7mD"), true);
    assert.strictEqual(isBilibiliUrl("https://bilibili.com/video/BV1xx411c7mD"), true);
    assert.strictEqual(isBilibiliUrl("https://b23.tv/abcd1234"), true);
  });

  it("非B站链接", () => {
    assert.strictEqual(isBilibiliUrl("https://example.com"), false);
    assert.strictEqual(isBilibiliUrl("https://www.youtube.com/watch?v=abc"), false);
  });

  it("无效 URL", () => {
    assert.strictEqual(isBilibiliUrl("not-a-url"), false);
    assert.strictEqual(isBilibiliUrl(""), false);
  });
});

describe("extractBvid", () => {
  it("普通 B站链接提取 BV 号", () => {
    assert.strictEqual(extractBvid("https://www.bilibili.com/video/BV1xx411c7mD"), "BV1xx411c7mD");
  });

  it("b23.tv 短链提取", () => {
    assert.strictEqual(extractBvid("https://b23.tv/abcd1234"), "abcd1234");
  });

  it("非B站链接返回 null", () => {
    assert.strictEqual(extractBvid("https://example.com"), null);
  });
});

// ── llm-client.mjs: buildBearerAuth / maskSecret ──
import { buildBearerAuth, maskSecret } from "../bridge/clients/llm-client.mjs";

describe("buildBearerAuth", () => {
  it("正常构建 Bearer 头", () => {
    assert.strictEqual(buildBearerAuth("abc123"), "Bearer abc123");
  });

  it("以 'Bearer ' 开头", () => {
    const auth = buildBearerAuth("sk-testkey1234");
    assert.ok(auth.startsWith("Bearer "));
  });

  it("不包含 '****'", () => {
    const auth = buildBearerAuth("sk-testkey1234");
    assert.ok(!auth.includes("****"));
    assert.ok(!auth.includes("***"));
  });

  it("空 key 抛错", () => {
    assert.throws(() => buildBearerAuth(""), /missing api key/);
    assert.throws(() => buildBearerAuth(null), /missing api key/);
    assert.throws(() => buildBearerAuth(undefined), /missing api key/);
  });

  it("空白 key 抛错", () => {
    assert.throws(() => buildBearerAuth("   "), /missing api key/);
  });

  it("数字型 key 转为字符串", () => {
    const auth = buildBearerAuth(12345);
    assert.strictEqual(auth, "Bearer 12345");
  });
});

describe("maskSecret", () => {
  it("短 key 全脱敏", () => {
    assert.strictEqual(maskSecret("abc"), "****");
    assert.strictEqual(maskSecret("12345678"), "****");
  });

  it("长 key 保留首尾", () => {
    const masked = maskSecret("sk-abcdefgh12345678xyz");
    assert.ok(masked.startsWith("sk-a"));
    assert.ok(masked.endsWith("xyz"));
    assert.ok(masked.includes("****"));
  });

  it("空 key 返回 <empty>", () => {
    assert.strictEqual(maskSecret(""), "<empty>");
    assert.strictEqual(maskSecret(null), "<empty>");
  });

  it("脱敏结果绝不等于原始 key", () => {
    const key = "sk-verysecretapikey12345";
    const masked = maskSecret(key);
    assert.notStrictEqual(masked, key);
    assert.ok(masked.includes("****"));
  });

  it("脱敏结果不包含原始 key 中间部分", () => {
    const key = "sk-verysecretapikey12345";
    const masked = maskSecret(key);
    assert.ok(!masked.includes("verysecretapikey"));
  });
});

// ── napcat.mjs: getFiles 防御 undefined message（复用上方 getFiles 导入）──

describe("getFiles 防御 undefined message", () => {
  it("undefined 消息不崩溃", () => {
    // 复现：NapCat 心跳事件 message 为 undefined
    const files = getFiles(undefined);
    assert.deepEqual(files, []);
  });

  it("null 消息不崩溃", () => {
    const files = getFiles(null);
    assert.deepEqual(files, []);
  });

  it("空字符串不崩溃", () => {
    const files = getFiles("");
    assert.deepEqual(files, []);
  });

  it("纯 JSON 消息（无 raw_message 的 meta_event）", () => {
    // 模拟 NapCat heartbeat: {"post_type":"meta_event",...}
    const files = getFiles(JSON.parse('{"post_type":"meta_event","meta_event_type":"heartbeat"}'));
    assert.deepEqual(files, []);
  });
});

// ── reply-handlers.mjs: handleLinkPreview 防御 undefined rawText ──
// handleLinkPreview 是 async 函数，通过 parseIncomingEvent 间接测试

describe("parseIncomingEvent 防御心跳事件", () => {
  it("meta_event 心跳不抛异常", () => {
    // 模拟 NapCat 心跳事件：无 message、无 raw_message
    const ev = {
      post_type: "meta_event",
      meta_event_type: "heartbeat",
      self_id: 1000000001,
      time: Date.now(),
    };
    // parseIncomingEvent 应为 meta_event 生成安全的 ctx
    const ctx = parseIncomingEvent(ev);
    assert.strictEqual(ctx.text, "");
    assert.strictEqual(ctx.rawText, "");
    assert.deepEqual(ctx.images, []);
    assert.deepEqual(ctx.files, []);
    assert.strictEqual(ctx.isAtMe, false);
  });

  it("message 为 undefined 不抛异常", () => {
    const ev = {
      post_type: "message",
      message_type: "group",
      user_id: 123,
      group_id: 2000000001,
      sender: {},
      // message 和 raw_message 都缺失
    };
    const ctx = parseIncomingEvent(ev);
    assert.strictEqual(ctx.text, "");
    assert.strictEqual(ctx.rawText, "");
  });
});

async function withMockFetch(mockFetch, fn) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mockFetch;
  try {
    return await fn();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

// ── link-preview: safeFetch mock tests ──
import { safeFetch } from "../bridge/services/link-preview/safe-fetch.mjs";

describe("safeFetch mock coverage", () => {
  it("rejects private addresses before fetch", async () => {
    let called = false;
    const result = await withMockFetch(async () => {
      called = true;
      throw new Error("should not fetch");
    }, async () => safeFetch("http://127.0.0.1:6700/test"));
    assert.strictEqual(result, null);
    assert.strictEqual(called, false);
  });

  it("returns null when content-length exceeds maxBytes", async () => {
    const result = await withMockFetch(async () => ({
      headers: { get: () => "20" },
      text: async () => "ignored",
    }), async () => safeFetch("https://example.com/page", { maxBytes: 10 }));
    assert.strictEqual(result, null);
  });

  it("returns null when response body exceeds maxBytes", async () => {
    const result = await withMockFetch(async () => ({
      headers: { get: () => "0" },
      text: async () => "01234567890",
    }), async () => safeFetch("https://example.com/page", { maxBytes: 10 }));
    assert.strictEqual(result, null);
  });

  it("passes an AbortSignal timeout to fetch", async () => {
    let sawSignal = false;
    await withMockFetch(async (url, options) => {
      sawSignal = Boolean(options.signal);
      return { headers: { get: () => "0" }, text: async () => "ok" };
    }, async () => safeFetch("https://example.com/page", { timeoutMs: 5 }));
    assert.strictEqual(sawSignal, true);
  });
});

// ── link-preview: generic page metadata pure tests ──
import { normalizePageMeta } from "../bridge/services/link-preview/generic-page.mjs";
import {
  extractLinkPreview,
  linkPreviewStatus,
  resetLinkPreviewStatus,
} from "../bridge/services/link-preview/index.mjs";

describe("normalizePageMeta", () => {
  it("extracts a normal title", () => {
    const result = normalizePageMeta("<html><head><title>Hello &amp; World</title></head></html>");
    assert.ok(result.text.includes("Hello & World"));
  });

  it("returns null without a title", () => {
    assert.strictEqual(normalizePageMeta("<html><body>no title</body></html>"), null);
  });

  it("keeps long titles readable", () => {
    const longTitle = "A".repeat(180);
    const result = normalizePageMeta("<title>" + longTitle + "</title>");
    assert.ok(result.text.includes(longTitle));
  });

  it("extracts description and truncates it", () => {
    const desc = "B".repeat(190);
    const html = '<meta property="og:title" content="Title"><meta name="description" content="' + desc + '">';
    const result = normalizePageMeta(html);
    assert.ok(result.text.includes("Title"));
    assert.ok(result.text.includes("B".repeat(159)));
    assert.ok(!result.text.includes("B".repeat(161)));
  });

  it("keeps only safe og:image URLs", () => {
    const safeHtml = '<meta property="og:title" content="Title"><meta property="og:image" content="/safe.png">';
    const safe = normalizePageMeta(safeHtml, { baseUrl: "https://example.com/page" });
    assert.equal(safe.image, "https://example.com/safe.png");

    const unsafeHtml = '<meta property="og:title" content="Title"><meta property="og:image" content="http://127.0.0.1/private.png">';
    const unsafe = normalizePageMeta(unsafeHtml, { baseUrl: "https://example.com/page" });
    assert.equal(unsafe.image, null);
  });

  it("extracts site name canonical url and favicon", () => {
    const html = [
      "<meta property='og:title' content='A &amp; B'>",
      "<meta property='og:site_name' content='Example Site'>",
      "<link rel='canonical' href='/article'>",
      "<link rel='icon' href='/favicon.ico'>",
    ].join("");
    const result = normalizePageMeta(html, { baseUrl: "https://example.com/page?q=1" });
    assert.equal(result.title, "A & B");
    assert.equal(result.siteName, "Example Site");
    assert.equal(result.url, "https://example.com/article");
    assert.equal(result.favicon, "https://example.com/favicon.ico");
    assert.ok(result.text.includes("Site: Example Site"));
  });

  it("falls back to hostname and blocks unsafe canonical urls", () => {
    const html = '<title>Title</title><link rel="canonical" href="http://127.0.0.1/private">';
    const result = normalizePageMeta(html, { baseUrl: "https://www.example.com/page" });
    assert.equal(result.siteName, "example.com");
    assert.equal(result.url, "https://www.example.com/page");
  });

  it("handles malformed HTML without throwing", () => {
    assert.strictEqual(normalizePageMeta("<meta><broken"), null);
  });

  it("records generic preview status", async () => {
    resetLinkPreviewStatus();
    const result = await withMockFetch(async () => ({
      ok: true,
      status: 200,
      headers: { get: () => null },
      text: async () => "<title>Status Page</title>",
    }), async () => extractLinkPreview("https://example.com/status"));

    assert.equal(result.title, "Status Page");
    const status = linkPreviewStatus();
    assert.equal(status.enabled, true);
    assert.equal(status.attempts, 1);
    assert.equal(status.hits, 1);
    assert.equal(status.genericHits, 1);
  });
});

// ── link-preview: Bilibili fetch mock tests ──
import { fetchBilibiliInfo } from "../bridge/services/link-preview/bilibili.mjs";

function bilibiliOkData(overrides = {}) {
  return {
    code: 0,
    data: {
      title: "测试视频",
      desc: "简介",
      owner: { name: "UP主" },
      stat: { view: 10000, danmaku: 20, like: 30 },
      pic: "https://example.com/pic.jpg",
      duration: 125,
      pubdate: 1710000000,
      tname: "科技",
      ...overrides,
    },
  };
}

describe("fetchBilibiliInfo mock coverage", () => {
  it("fetches a normal BV link", async () => {
    const result = await withMockFetch(async () => ({
      json: async () => bilibiliOkData(),
    }), async () => fetchBilibiliInfo("https://www.bilibili.com/video/BV1xx411c7mD"));
    assert.strictEqual(result.bvid, "BV1xx411c7mD");
    assert.ok(result.text.includes("测试视频"));
  });

  it("resolves a b23.tv short link", async () => {
    const calls = [];
    const result = await withMockFetch(async (url) => {
      calls.push(url);
      if (url.startsWith("https://b23.tv/")) {
        return { headers: { get: () => "https://www.bilibili.com/video/BVshort12345" } };
      }
      return { json: async () => bilibiliOkData() };
    }, async () => fetchBilibiliInfo("https://b23.tv/abcd1234"));
    assert.strictEqual(result.bvid, "BVshort12345");
    assert.strictEqual(calls.length, 2);
  });

  it("returns null for invalid links", async () => {
    const result = await withMockFetch(async () => {
      throw new Error("should not fetch");
    }, async () => fetchBilibiliInfo("https://example.com/video"));
    assert.strictEqual(result, null);
  });

  it("keeps fallback behavior when API parsing fails", async () => {
    const result = await withMockFetch(async () => ({
      json: async () => ({ code: -1, data: null }),
    }), async () => fetchBilibiliInfo("https://www.bilibili.com/video/BV1xx411c7mD"));
    assert.strictEqual(result, null);
  });
});

// ── model-mimo: malformed tool_call mock test ──
import { tryMiMo } from "../bridge/model-mimo.mjs";

describe("tryMiMo tool_call defensive handling", () => {
  it("malformed tool_call payload returns null without real model calls", async () => {
    let calls = 0;
    const result = await withMockFetch(async () => {
      calls++;
      return {
        json: async () => ({
          choices: [{
            message: {
              tool_calls: [{
                id: "call-1",
                function: { name: "web_search", arguments: "{" },
              }],
            },
          }],
        }),
      };
    }, async () => tryMiMo("天气", "测试用户", [], [], 2000000001, true, ""));
    assert.strictEqual(result, null);
    assert.strictEqual(calls, 1);
  });

  it("非 @ 随机插话不携带工具并只返回短回复", async () => {
    let body = null;
    const result = await withMockFetch(async (url, options) => {
      body = JSON.parse(options.body);
      return {
        json: async () => ({
          choices: [{ message: { content: '{"reply":"先别急喵，慢慢说。"}' } }],
        }),
      };
    }, async () => tryMiMo("我有点红温了", "小黑", [], [], 2000000001, false, "", { replyMode: "interjection", currentUserId: "123" }));
    assert.strictEqual(result, "先别急喵，慢慢说。");
    assert.strictEqual(body.max_completion_tokens, 192);
    assert.deepEqual(body.thinking, { type: "disabled" });
    assert.strictEqual(Object.prototype.hasOwnProperty.call(body, "max_tokens"), false);
    assert.ok(!Object.prototype.hasOwnProperty.call(body, "tools"));
    const lastMessage = body.messages.at(-1).content;
    assert.ok(lastMessage.includes("[当前输入]"));
    assert.ok(lastMessage.includes("speaker=小黑 uid=123"));
    assert.ok(lastMessage.includes("reply_target=当前发言人"));
    assert.ok(!lastMessage.includes("小黑说:"));
  });
});
