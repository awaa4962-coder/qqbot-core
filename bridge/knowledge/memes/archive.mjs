import fs from "node:fs";
import { CFG } from "../../config.mjs";
import { redactSensitiveText } from "../../privacy.mjs";

export const MEME_RETIRED_MESSAGE = "自动梗库已停用，不再学习、联网更新或向回复注入梗义。旧词条仅保留只读归档；识图、表情和 JM 下载不受影响。";
const MAX_BYTES = 8 * 1024 * 1024;
const MAX_ENTRIES = 2000;

export function retiredMemeResult() {
  return { ok: false, retired: true, code: "feature_retired", error: MEME_RETIRED_MESSAGE };
}

// Read the original private file without seeding, migration, cleanup or writes.
export function readMemeArchive(options = {}) {
  const filename = options.filename || CFG.memeKnowledgeFile;
  let fd;
  try {
    if (fs.lstatSync(filename).isSymbolicLink()) throw new Error("unsafe archive");
    fd = fs.openSync(filename, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_BYTES) throw new Error("invalid archive size");
    const source = JSON.parse(fs.readFileSync(fd, "utf8"));
    if (!source || !Array.isArray(source.entries)) throw new Error("unknown archive shape");
    const entries = source.entries.slice(0, MAX_ENTRIES).filter(item => item && typeof item === "object").map(publicEntry);
    return archiveSnapshot({ available: true, entries, count: source.entries.length,
      truncated: source.entries.length > MAX_ENTRIES, updatedAt: new Date(stat.mtimeMs).toISOString() });
  } catch (error) {
    return archiveSnapshot({ available: false, readError: error.code !== "ENOENT" });
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function archiveSnapshot(value) {
  return { retired: true, readonly: true, mode: "off", enabled: false, autoUpdate: false,
    message: MEME_RETIRED_MESSAGE, entries: [], count: 0, available: false, readError: false,
    editableFields: [], ...value };
}

function publicEntry(source) {
  return {
    name: clean(source.name, 80), aliases: list(source.aliases, 20, 80),
    meaning: clean(source.meaning, 1200), usage: clean(source.usage, 1200),
    examples: list(source.examples, 8, 220), manualProtected: Boolean(source.manualFields?.length),
    groupCount: Array.isArray(source.scope?.groupIds) ? source.scope.groupIds.length : 0,
    sourceCount: Array.isArray(source.sources) ? source.sources.length : 0,
  };
}

function clean(value, limit) { return redactSensitiveText(String(value || "")).slice(0, limit); }
function list(value, count, length) { return Array.isArray(value) ? value.slice(0, count).map(item => clean(item, length)) : []; }
