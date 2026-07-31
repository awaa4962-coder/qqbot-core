import { runMemeDecay } from "./learner.mjs";

export {
  clearMemeCandidates,
  applyMemeUpdateBatch,
  deleteMeme,
  findMemeByNameOrAlias,
  flushMemeStoreSync,
  getMemeCandidate,
  getMemeStore,
  getMemeStorePath,
  getMemeHistory,
  removeMemeCandidate,
  resetMemeStoreForTest,
  restoreMemeHistory,
  rollbackLastMemeUpdate,
  saveMemeStore,
  setMemeEnabled,
  setMemeMode,
  setMemeStatus,
  setMemeStorePath,
  upsertMeme,
  upsertMemeCandidate,
} from "./store.mjs";

export {
  observeMemeUsage,
  runMemeDecay,
} from "./learner.mjs";

export {
  buildMemeContextBlock,
  buildMemeSearchReply,
  buildMemeStatusReply,
  buildMemeToggleReply,
  matchMemes,
} from "./matcher.mjs";

export {
  isMemeTrendUpdateDue,
  researchMemeTerm,
  runMemeTrendUpdate,
  scheduleMemeTrendUpdates,
  stopMemeTrendUpdates,
} from "./trend-updater.mjs";

export function initializeMemeKnowledge() {
  return runMemeDecay();
}
