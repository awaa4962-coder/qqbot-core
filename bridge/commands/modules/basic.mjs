import {
  buildCapabilityHelpText,
  isCapabilityHelpCommand,
  parseCapabilityHelpCommand,
} from "../../capabilities/catalog.mjs";
import {
  buildPrivacyText,
  buildSelfProfileText,
  buildStyleHelpText,
  buildStylePreview,
  buildStyleRecommendation,
  forgetUserData,
  resetUserStylePreference,
  setUserDisplayName,
  setUserStylePreference,
} from "../../user-preferences.mjs";
import { VERSION, buildVersionQueryText, detectVersionLang, isVersionQueryCommand } from "../../version.mjs";
import { buildMemeSearchReply, buildMemeStatusReply, getMemeStore } from "../../knowledge/memes/index.mjs";
import { extractRawCommandArg } from "../normalize.mjs";
import { isMemeCommand, isPreferenceCommand } from "../registry.mjs";

export function buildUserCommandReply(cmd, options) {
  if (isCapabilityHelpCommand(cmd)) {
    const parsed = parseCapabilityHelpCommand(cmd);
    return buildCapabilityHelpText(parsed.query, {
      ...options,
      surface: options.groupId ? "group" : "private",
      memeMode: getMemeStore().mode,
    });
  }
  if (cmd === "status" || cmd === "状态") return "夜星在线，桥接器运行正常。";
  if (cmd === "ping" || cmd === "测试") return "pong";
  if (isMemeCommand(cmd)) return buildMemeCommandReply(cmd, options);
  if (isPreferenceCommand(cmd)) return buildPreferenceCommandReply(cmd, options);
  if (isVersionQueryCommand(cmd)) return buildVersionQueryText(cmd, detectVersionLang(cmd), options.version || VERSION);
  return null;
}

function buildMemeCommandReply(cmd, options) {
  if (cmd === "梗库" || cmd === "梗库 状态" || cmd === "meme status") return buildMemeStatusReply();
  const match = cmd.match(/^(梗库|meme)\s+(搜|搜索|search)\s+(.+)$/);
  if (!match) return null;
  return buildMemeSearchReply(extractRawCommandArg(options.rawCommandText, options, match[1] + " " + match[2]));
}

function buildPreferenceCommandReply(cmd, options) {
  const uid = String(options.userId || "");
  const groupId = options.groupId || 0;
  const commonOptions = {
    users: options.users,
    groupChats: options.groupChats,
    skipSave: options.skipSave === true,
    now: options.now,
  };
  const simpleReply = buildSimplePreferenceReply(cmd, uid, groupId, commonOptions);
  if (simpleReply) return simpleReply;
  return buildStyleCommandReply(cmd, uid, groupId, commonOptions, options);
}

function buildSimplePreferenceReply(cmd, uid, groupId, commonOptions) {
  if (cmd === "我的档案" || cmd === "my-profile") return buildSelfProfileText(uid, groupId, commonOptions);
  if (cmd === "隐私" || cmd === "privacy") return buildPrivacyText();
  if (cmd === "忘记我" || cmd === "forget me") return forgetUserData(uid, commonOptions).text;
  if (/^设置称呼\s+/.test(cmd)) return null;
  return "";
}

function buildStyleCommandReply(cmd, uid, groupId, commonOptions, options) {
  if (/^设置称呼\s+/.test(cmd)) {
    return setUserDisplayName(uid, extractRawCommandArg(options.rawCommandText, options, "设置称呼"), commonOptions).text;
  }
  if (cmd === "回复风格") return buildStylePreview(uid, commonOptions);
  if (cmd === "回复风格 帮助") return buildStyleHelpText();
  if (cmd === "回复风格 推荐") return buildStyleRecommendation(uid, groupId, commonOptions);
  if (cmd === "回复风格 预览") return buildStylePreview(uid, commonOptions);
  if (cmd === "回复风格 重置") return resetUserStylePreference(uid, commonOptions);
  if (cmd.startsWith("回复风格 ")) {
    return setUserStylePreference(uid, cmd.replace(/^回复风格\s+/, ""), commonOptions).text;
  }
  return null;
}
