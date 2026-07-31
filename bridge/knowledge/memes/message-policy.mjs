import { isKnownCommand } from "../../commands/registry.mjs";

const COMMAND_FALLBACK =
  /^(?:[/\\]\s*)?(?:jm\b|preview\b|resource\b|wordcloud\b|summary\b|日报\b|词云\b|资源\b|预览\b|更新\b|梗库\b)/i;
const SERIOUS_CONTEXT =
  /(?:报错|错误|失败|异常|崩溃|不能用|用不了|怎么办|求助|帮我|修复|排查|配置|安装|依赖|接口|API|代码|函数|数据库|日志|测试|命令|版本|服务|进程|网络|超时|密码|隐私|账号|安全)/i;
const PLACEHOLDER_ONLY =
  /^(?:\[?(?:图片|表情|文件|语音|视频|非文本消息|image|file|voice|video)\]?|https?:\/\/\S+)$/i;

export function isMemeLearningExcluded(text, event = {}) {
  const value = normalizeMessageText(text);
  if (!value || PLACEHOLDER_ONLY.test(value)) return true;
  if (containsUrl(value)) return true;
  if (event.isCommand === true) return true;
  return isKnownCommand(value) || COMMAND_FALLBACK.test(value);
}

export function isMemeContextSuppressed(text) {
  const value = normalizeMessageText(text);
  if (!value || isMemeLearningExcluded(value)) return true;
  return SERIOUS_CONTEXT.test(value);
}

export function sanitizeMemeReviewSample(text) {
  return normalizeMessageText(text)
    .replace(/https?:\/\/\S+/gi, "[链接]")
    .replace(/\[CQ:[^\]]+\]/g, "[消息元素]")
    .replace(/\b\d{5,}\b/g, "[号码]")
    .replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g, "[邮箱]")
    .replace(/\b1[3-9]\d{9}\b/g, "[手机号]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 100);
}

export function normalizeMessageText(text) {
  return String(text || "")
    .normalize("NFKC")
    .replace(/^\s*@[\w\u4e00-\u9fff-]{1,30}\s*/u, "")
    .trim();
}

function containsUrl(text) {
  return /(?:https?:\/\/|www\.|[A-Za-z0-9-]+\.(?:com|cn|net|org)\b)/i.test(text);
}
