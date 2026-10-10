import { types } from "node:util";
import { containsSensitiveText } from "../privacy.mjs";

// Preparation is a proposal, never permission to commit or send. Only the parent's runtime enables it.
export function autonomousPreparationAllowed(message, domain, args) {
  if (typeof message !== "string" || !message.trim() || message.length > 8192) return false;
  const text = message.normalize("NFKC").replace(/\p{Cf}/gu, "");
  const cancellationRef = reminderCancellationRef(args);
  if (cancellationRef && domain !== "reminder") return false;
  if (/(?:只是|仅|只).{0,12}(?:解释|引用|分析|资料|示例|翻译)|(?:不执行|不要执行|禁止执行)/u.test(text) ||
      /\b(?:only|just)\b.{0,32}\b(?:explain|quote|analy[sz]e|translate|example|data)\b/i.test(text) ||
      (!cancellationRef && /(?:^|[，,。；;\n!?！？])\s*(?:算了|不要了|不用了|取消(?:吧)?|停止)(?:\s|[，,。；;!?！？]|$)/u.test(text)) ||
      (!cancellationRef && /(?:^|[,;\n.!?])\s*(?:never mind|cancel(?: it)?|stop)(?:\s|[,.!?;]|$)/i.test(text))) return false;
  if (cancellationRef) return reminderCancellationAllowed(text, cancellationRef);
  const subjects = {
    personal: "记住|记忆|记录|记下|保存|储存|存储|修改|更新|纠正|删除|移除|忘掉|叫我|称呼|名字|风格|偏好|草稿|提案",
    reminder: "提醒|闹钟|定时|执行|创建|设置|草稿|提案",
    draft: "总结|日报|回顾|草稿|汇总|整理|提案",
  };
  if (!Object.hasOwn(subjects, domain)) return false;
  const subject = "(?:" + subjects[domain] + ")";
  return !new RegExp("(?:不要|不用|别|勿|无需|禁止|取消|停止|不必|不需要|不允许).{0,24}" + subject +
    "|" + subject + ".{0,12}(?:算了|取消|停止|不要|不必|不需要|不用)", "u").test(text) &&
    !/\b(?:don't|do not|never|no need to|cancel|stop)\b.{0,48}\b(?:save|store|remember|record|update|delete|name|style|remind(?:ers?)?|schedule|summarize|summary|draft|recap|proposal)\b/i.test(text);
}

function reminderCancellationRef(args) {
  if (!args || types.isProxy(args)) return "";
  const ref = Object.getOwnPropertyDescriptor(args, "ref")?.value;
  return Object.getOwnPropertyDescriptor(args, "action")?.value === "cancel" &&
    typeof ref === "string" && /^rem_[a-f0-9]{32}$/.test(ref) ? ref : "";
}

function reminderCancellationAllowed(text, ref) {
  // Cancel is an operation on a backend-owned reminder, not a positive command-word gate.
  const mentionedRefs = text.match(/\brem_[a-f0-9]{32}\b/g) || [];
  if (mentionedRefs.some(value => value !== ref)) return false;
  return !/^["'“‘「『`]|^(?:取消(?:吧)?|停止|不要了|不用了|cancel|stop)[\s，,。.!！?？;；]*$/iu.test(text.trim()) &&
    !/(?:不要|不用|别|勿|无需|禁止|不必|不需要|不允许|不想|不).{0,24}(?:取消|撤(?:掉|销|除)?|停止|关闭|删(?:掉|除)?|准备|执行|创建|设置|新提醒|新闹钟|草稿|提案)|算了|(?:取消|撤(?:掉|销|除)?|停止|关闭|删除).{0,12}(?:不要|不必|不需要|不用)|(?:取消|停止).{0,24}(?:准备|创建|设置|草稿|提案|新提醒)/u.test(text) &&
    !/\b(?:don't|do not|never|no need to|not)\b.{0,48}\b(?:cancel|remove|delete|stop|disable|dismiss|revoke|prepare|execute|create|schedule|draft|proposal|new reminders?)\b|\bnever mind\b|\b(?:cancel|stop)\b.{0,48}\b(?:prepare|create|draft|proposal|new reminder)\b/i.test(text);
}

// Check normalized strings before any proposal can reach the durable CF ledger; canonical schemas still apply.
export function autonomousPreparationArgumentsSafe(args) {
  if (!args || types.isProxy(args) || ![Object.prototype, null].includes(Object.getPrototypeOf(args))) return false;
  return Reflect.ownKeys(args).every(key => {
    const field = Object.getOwnPropertyDescriptor(args, key);
    if (typeof key !== "string" || !field.enumerable || !Object.hasOwn(field, "value")) return false;
    const value = field.value;
    if (typeof value !== "string") return typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value));
    const text = value.normalize("NFKC").replace(/\p{Cf}/gu, "");
    return !containsSensitiveText(text) &&
      !/\b(?:basic|bearer|digest|negotiate|ntlm|authorization)\s+\S+|\b(?:sk|ghp|github_pat)[-_][a-z0-9]{8,}|\bAKIA[0-9A-Z]{16}\b|\bxox[baprs]-[a-z0-9-]{8,}|https?:\/\/[^\s/]+:[^\s/]+@/i.test(text);
  });
}
