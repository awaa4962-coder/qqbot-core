import { buildAdminHelpText } from "../../help.mjs";
import {
  buildHumanMemorySummary,
  clearGroupMemoryProfile,
  clearUserMemoryProfile,
  getMemoryStatus,
} from "../../memory-profile.mjs";
import { buildMemeToggleReply } from "../../knowledge/memes/index.mjs";
import { isRelationshipExportCommand } from "../../relationship-commands.mjs";
import { extractRawCommandArg } from "../normalize.mjs";
import { buildRuntimeText } from "../runtime.mjs";
import { ADMIN_COMMANDS, isMemoryCommand, isMemeAdminCommand } from "../registry.mjs";
import { requireAdmin } from "../permissions.mjs";

export function buildAdminCommandReply(cmd, options) {
  if (!ADMIN_COMMANDS.has(cmd) && !isRelationshipExportCommand(cmd) && !isMemoryCommand(cmd) && !isMemeAdminCommand(cmd)) return null;
  const permissionError = requireAdmin(options.userId, options.admins);
  if (permissionError) return permissionError;
  if (cmd === "admin help" || cmd === "管理帮助") return buildAdminHelpText();
  if (cmd === "runtime" || cmd === "运行状态") return buildRuntimeText(options.runtime);
  if (isMemeAdminCommand(cmd)) return buildMemeAdminCommandReply(cmd, options);
  if (isMemoryCommand(cmd)) return buildMemoryCommandReply(cmd, options);
  return "关系导出功能仍是预留项，当前不会导出关系表。";
}

function buildMemeAdminCommandReply(cmd, options) {
  const match = cmd.match(/^(梗库|meme)\s+(禁用|启用|disable|enable)\s+(.+)$/);
  if (!match) return null;
  const action = match[2] === "启用" || match[2] === "enable" ? "enable" : "disable";
  const query = extractRawCommandArg(options.rawCommandText, options, match[1] + " " + match[2]);
  return buildMemeToggleReply(action, query || match[3]);
}

function buildMemoryCommandReply(cmd, options) {
  if (cmd === "memory status") {
    const status = getMemoryStatus();
    return [
      "记忆画像状态",
      "用户画像：" + status.users + " 个",
      "群画像：" + status.groups + " 个",
      "群内互动画像：" + status.userGroups + " 个",
      "说明：画像有过期时间和置信度，只作为上下文参考。",
    ].join("\n");
  }
  if (cmd === "memory clear group") {
    if (!options.groupId) return "请在群聊里执行 memory clear group。";
    clearGroupMemoryProfile(options.groupId);
    return "已清理当前群画像。";
  }
  const clearUser = cmd.match(/^memory clear user (\d+)$/);
  if (clearUser) {
    clearUserMemoryProfile(clearUser[1]);
    return "已清理用户 " + clearUser[1] + " 的画像。";
  }
  const summary = cmd.match(/^memory summary (\d+)$/);
  if (summary) {
    const text = buildHumanMemorySummary(summary[1], options.groupId);
    return text ? "用户 " + summary[1] + " 画像摘要：\n" + text : "这个用户暂无可用画像。";
  }
  return null;
}
