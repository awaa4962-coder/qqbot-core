import { CFG } from "../config.mjs";

export function stripBotMention(text, selfUin = CFG.selfUin, botNames = CFG.botNames) {
  let value = String(text || "")
    .replace(new RegExp("\\[CQ:at,qq=" + escapeRegExp(String(selfUin)) + "\\]", "g"), "")
    .trim();
  for (const name of botNames) {
    value = stripVisibleBotName(value, name);
  }
  return value.trim();
}

export function normalizeCommand(text, options = {}) {
  return prepareCommandText(text, options)
    .replace(/[。.!！?？]+$/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

export function prepareCommandText(text, options = {}) {
  const source = options.requireMention
    ? stripBotMention(text, options.selfUin, options.botNames)
    : String(text || "").trim();
  return source.replace(/^[/\\]+/, "").trim();
}

export function extractRawCommandArg(rawText, options, commandName) {
  const source = options.requireMention
    ? stripBotMention(rawText, options.selfUin, options.botNames)
    : String(rawText || "").trim();
  return source
    .replace(/^[/\\]+/, "")
    .replace(/[。.!！?？]+$/g, "")
    .replace(new RegExp("^" + escapeRegExp(commandName) + "\\s+"), "")
    .trim();
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function stripVisibleBotName(text, name) {
  const cleanName = String(name || "").trim();
  if (!cleanName) return text;
  return text.replace(new RegExp("^@?" + escapeRegExp(cleanName) + "[，,:：\\s]*", "i"), "").trim();
}
