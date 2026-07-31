// bridge/admin-commands.mjs — compatibility facade for the modular command system.
export {
  buildCommandReply,
  buildCommandReplyAsync,
  buildGroupCommandReply,
  buildGroupCommandReplyAsync,
  buildPrivateCommandReply,
  buildPrivateCommandReplyAsync,
  buildRuntimeText,
  isAdminUser,
  isKnownCommand,
  normalizeCommand,
  stripBotMention,
} from "./commands/index.mjs";
