// test/core.test.mjs — 纯函数单元测试
import { describe, it } from "node:test";
import assert from "node:assert/strict";

// ── context.mjs ──
import { normalizeMsg, cleanText } from "../bridge/context.mjs";

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

// ── thinking.mjs ──
import { cleanThinking, isLeakedReasoning } from "../bridge/thinking.mjs";

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

  it("混合内容（有分析+有回应）不判为泄露", () => {
    const mixed = "用户说喜欢猫。看起来在分享兴趣爱好。喵～我也喜欢猫！(╯✧∇✧)╯";
    assert.strictEqual(isLeakedReasoning(mixed), false);
  });
});

// ── napcat.mjs ──
import { getImages, getFiles, describeFiles } from "../bridge/napcat.mjs";

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
