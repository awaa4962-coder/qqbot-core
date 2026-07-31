// bridge/context.mjs - compatibility facade for split context modules.
export {
  getLatestChangelog,
} from "./context/changelog.mjs";
export {
  buildCurrentInput,
  buildGroupBackgroundBlock,
  buildQuotedMessageBlock,
  cleanText,
  fmtMsg,
  formatSpeakerLine,
  normalizeMsg,
  safeContextText,
  speakerLabel,
} from "./context/messages.mjs";
export {
  crossGroupCtx,
  recentGroupChat,
  recentHistory,
  recentHistoryWeighted,
} from "./context/history.mjs";
