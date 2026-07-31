import { isGroupSummaryCommand } from "../group-summary/commands.mjs";
import {
  isRelationshipCommand,
  isRelationshipExportCommand,
} from "../relationship-commands.mjs";
import { isVersionQueryCommand } from "../version.mjs";
import { isCapabilityHelpCommand } from "../capabilities/catalog.mjs";
import { commandAliases, commandAliasesForId, commandPatterns } from "./manifest.mjs";
import { normalizeCommand } from "./normalize.mjs";

export const NORMAL_COMMANDS = new Set(commandAliases({ permission: "user" }));

export const ADMIN_COMMANDS = new Set(commandAliases({ permission: "admin" }));

const HELP_PAGE_1_COMMANDS = new Set(commandAliasesForId("help-page-1"));
const HELP_PAGE_2_COMMANDS = new Set(commandAliasesForId("help-page-2"));
const MEMORY_COMMANDS = new Set(commandAliases({ permission: "admin", adminSection: "memory" }));
const MEMORY_PATTERNS = commandPatterns({ permission: "admin", adminSection: "memory" });
const MEME_COMMANDS = new Set(commandAliasesForId("meme-status"));
const MEME_PATTERNS = commandPatterns({ id: "meme-search" });
const MEME_ADMIN_PATTERNS = commandPatterns({ id: "meme-toggle" });
const PREFERENCE_PATTERNS = commandPatterns({ permission: "user" });

export function isKnownCommand(commandText) {
  const cmd = normalizeCommand(commandText);
  return NORMAL_COMMANDS.has(cmd) ||
    ADMIN_COMMANDS.has(cmd) ||
    isCapabilityHelpCommand(cmd) ||
    isMemoryCommand(cmd) ||
    isGroupSummaryCommand(cmd) ||
    isPreferenceCommand(cmd) ||
    isMemeCommand(cmd) ||
    isMemeAdminCommand(cmd) ||
    isVersionQueryCommand(cmd) ||
    isRelationshipCommand(cmd) ||
    isRelationshipExportCommand(cmd);
}

export function isHelpPage1Command(cmd) {
  return HELP_PAGE_1_COMMANDS.has(cmd);
}

export function isHelpPage2Command(cmd) {
  return HELP_PAGE_2_COMMANDS.has(cmd) || /^(?:help|帮助)\s*[1-6]$/.test(cmd);
}

export function isMemoryCommand(cmd) {
  return MEMORY_COMMANDS.has(cmd) ||
    MEMORY_PATTERNS.some(pattern => pattern.test(cmd));
}

export function isMemeCommand(cmd) {
  return MEME_COMMANDS.has(cmd) ||
    MEME_PATTERNS.some(pattern => pattern.test(cmd));
}

export function isMemeAdminCommand(cmd) {
  return MEME_ADMIN_PATTERNS.some(pattern => pattern.test(cmd));
}

export function isPreferenceCommand(cmd) {
  return cmd === "我的档案" ||
    cmd === "my-profile" ||
    cmd === "隐私" ||
    cmd === "privacy" ||
    cmd === "忘记我" ||
    cmd === "forget me" ||
    cmd === "回复风格" ||
    PREFERENCE_PATTERNS.some(pattern => pattern.test(cmd));
}
