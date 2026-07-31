// bridge/help.mjs - QQ-friendly capability and administrator help.
import { buildCapabilityHelpText } from "./capabilities/catalog.mjs";
import { adminHelpLines } from "./commands/manifest.mjs";

export function buildHelpText(page = 1) {
  const query = Number(page) === 1 ? "" : String(page);
  return buildCapabilityHelpText(query);
}

export function buildHelpPage1() {
  return buildCapabilityHelpText("");
}

export function buildHelpPage2() {
  return buildCapabilityHelpText("2");
}

export function buildAdminHelpText() {
  return [
    "夜星管理员帮助",
    "",
    "群聊请 @夜星 使用：",
    ...adminHelpLines("base"),
    "",
    "画像：",
    ...adminHelpLines("memory"),
    "",
    "预留：",
    ...adminHelpLines("reserved"),
    "",
    "不会导出关系表，不会暴露敏感凭据。",
  ].join("\n");
}
