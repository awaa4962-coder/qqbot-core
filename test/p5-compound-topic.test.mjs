import assert from "node:assert/strict";
import test from "node:test";
import { currentTopicText, normalizeConversationText } from "../bridge/context/relevance.mjs";
import { selectConversationThread } from "../bridge/context/conversation-selection.mjs";
const previous = { turns: [{ userSummary: "下载失败", assistantSummary: "旧下载建议" }] };
for (const input of ["以后叫我小夏；先不聊下载了，17加25是多少？", "请称呼我小夏。换个话题，今天怎么安排？",
  "今后叫我小夏，另外问一下，图片怎么保存？"]) {
  test("current self-address clause permits following explicit topic change: " + input.slice(0, 12), () => {
    assert.equal(currentTopicText(input).switched, true);
    assert.equal(selectConversationThread(previous, { userMsg: input }), null);
    assert.ok(!currentTopicText(input).text.includes("下载了"));
  });
}
for (const input of ["他说：“以后叫我小夏；先不聊下载了，17加25是多少？”", "他说，以后叫我小夏；先不聊下载了，17加25是多少？",
  "`以后叫我小夏；先不聊下载了，17加25是多少？`", "“以后叫我小夏；先不聊下载了，17加25是多少？”",
  "以后叫我小夏；他说先不聊下载了", "以后叫我小夏；继续帮我处理下载失败", "以后叫我小夏；别把换个话题当切换",
  "我以前说过先不聊下载了，现在继续下载", "以后叫我小夏", "先不聊下载是什么意思？"]) {
  test("reported, quoted or absent directives do not switch: " + input.slice(0, 12), () => {
    assert.equal(currentTopicText(input).switched, false);
  });
}
test("non-switching self-address input keeps its complete retrieval text", () => {
  const input = "以后叫我小夏；继续帮我处理下载失败";
  assert.deepEqual(currentTopicText(input), { text: normalizeConversationText(input), switched: false });
});
