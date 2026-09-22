import { readMemeArchive, retiredMemeResult } from "../knowledge/memes/archive.mjs";

export function buildMemeKnowledgeSnapshot(options = {}) {
  return readMemeArchive(options);
}

export async function applyMemeKnowledgeAction() {
  return retiredMemeResult();
}
