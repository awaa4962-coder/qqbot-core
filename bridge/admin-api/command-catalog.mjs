// bridge/admin-api/command-catalog.mjs - readonly command metadata for the launcher.

import { COMMAND_DEFINITIONS } from "../commands/manifest.mjs";

export function buildCommandCatalog() {
  return {
    count: COMMAND_DEFINITIONS.length,
    commands: COMMAND_DEFINITIONS.map(command => ({
      id: command.id,
      permission: command.permission,
      aliases: command.aliases || [],
      helpPage: command.helpPage || null,
      adminSection: command.adminSection || null,
      helpLine: command.retired ? "已停用，仅返回退役说明" : command.helpLine || "",
      retired: Boolean(command.retired),
      reserved: Boolean(command.reserved),
      handledBy: command.handledBy || "commands",
      hasPattern: Boolean(command.pattern),
      pattern: command.pattern ? String(command.pattern) : "",
    })),
  };
}
