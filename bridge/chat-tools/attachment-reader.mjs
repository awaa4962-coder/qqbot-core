import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { redactSensitiveText } from "../privacy.mjs";

const MAX_BYTES = 10000;
const MAX_READS = 4;
const MAX_MEMOS = 3;
const MAX_RESULT = 1800;
const ARGUMENTS = new Set(["attachment_ref", "query", "start_line", "end_line"]);

export function createAttachmentReader(options = {}) {
  const { references, signal, assertCurrent } = options;
  const memos = new Map();
  const pending = new Map();
  let reads = 0;
  let downloads = 0;
  let invalid = false;

  function invalidate() {
    invalid = true;
    memos.clear();
    pending.clear();
  }

  function check() {
    try {
      if (invalid || signal?.aborted || typeof references?.assertCurrent !== "function") throw new Error();
      signal?.throwIfAborted();
      if (assertCurrent?.() === false || references.assertCurrent() === false) throw new Error();
      signal?.throwIfAborted();
    } catch {
      invalidate();
      throw new Error("attachment_denied");
    }
  }

  // The reference owner enforces expiry using its own clock; do not reinterpret binding timestamps.
  function resolve(ref, expected) {
    check();
    const value = references.resolve(ref);
    check();
    if (value?.status !== "ok" || !value.file || value.descriptor?.attachment_ref !== ref) {
      if (expected || memos.has(ref) || pending.has(ref)) invalidate();
      throw new Error("attachment_denied");
    }
    const identity = createHash("sha256").update(JSON.stringify([value.file, value.descriptor, value.binding])).digest("hex");
    if (expected && expected !== identity) {
      invalidate();
      throw new Error("attachment_denied");
    }
    return { value, identity };
  }

  async function download(ref, resolved) {
    try {
      resolve(ref, resolved.identity);
      const evidence = await abortable(async () => {
        // Lazy loading avoids config access in injected tests; recheck after the import too.
        const fetchEvidence = options.fetchEvidence || (await import("../napcat.mjs")).fetchFileEvidence;
        resolve(ref, resolved.identity);
        return fetchEvidence(resolved.value.file, { signal });
      }, signal);
      resolve(ref, resolved.identity);
      const memo = evidenceMemo(evidence);
      resolve(ref, resolved.identity);
      if (memo.status === "ok") memos.set(ref, { ...memo, identity: resolved.identity });
      return memo;
    } catch (error) {
      if (["CHAT_CANCELLED", "CHAT_TOOL_STOPPED"].includes(error?.code)) invalidate();
      try { resolve(ref, resolved.identity); }
      catch { return { status: "denied", text: "" }; }
      return { status: "unavailable", text: "read_failed" };
    }
  }

  async function memoFor(ref, resolved) {
    const cached = memos.get(ref);
    if (cached) {
      resolve(ref, cached.identity);
      return cached;
    }
    const active = pending.get(ref);
    if (active) {
      if (active.identity !== resolved.identity) { invalidate(); return { status: "denied", text: "" }; }
      return active.promise;
    }
    if (downloads >= MAX_MEMOS) return { status: "denied", text: "download_limit" };
    downloads++;
    const operation = { identity: resolved.identity, promise: download(ref, resolved) };
    pending.set(ref, operation);
    try { return await operation.promise; }
    finally { if (pending.get(ref) === operation) pending.delete(ref); }
  }

  async function read(args) {
    let selection;
    try { selection = validateArguments(args); }
    catch { return failure("invalid_arguments", "head", "invalid_arguments"); }
    if (!selection) return failure("invalid_arguments", "head", "invalid_arguments");
    try { check(); }
    catch { return failure("denied", selection.mode); }
    if (reads >= MAX_READS) return failure("denied", selection.mode, "read_limit");
    reads++;
    let resolved;
    try { resolved = resolve(args.attachment_ref); }
    catch { return failure("denied", selection.mode); }
    const name = safeName(resolved.value.descriptor.name);
    if (reportedTooLarge(resolved.value)) {
      return failure("unavailable", selection.mode, "size_limit", args.attachment_ref, name);
    }
    try {
      const memo = await memoFor(args.attachment_ref, resolved);
      resolve(args.attachment_ref, resolved.identity);
      if (memo.status !== "ok") return failure(memo.status, selection.mode, memo.text,
        memo.status === "denied" ? "" : args.attachment_ref, memo.status === "denied" ? "" : name);
      const result = selectResult(args.attachment_ref, name, memo.text, selection);
      resolve(args.attachment_ref, resolved.identity);
      return result;
    } catch { return failure("denied", selection.mode); }
  }

  signal?.addEventListener("abort", invalidate, { once: true });
  return { read };
}

function validateArguments(args) {
  if (!validArgumentObject(args)) return null;
  const query = Object.hasOwn(args, "query");
  const range = Object.hasOwn(args, "start_line") || Object.hasOwn(args, "end_line");
  // Query and range are mutually exclusive; a range requires both inclusive endpoints.
  if (query && range) return null;
  if (query) return typeof args.query === "string" && args.query.trim() && args.query.length <= 160
    ? { mode: "query", query: args.query.toLowerCase() } : null;
  if (!range) return { mode: "head", start: 1, end: 20 };
  return validRange(args.start_line, args.end_line);
}

function validArgumentObject(args) {
  if (!args || typeof args !== "object" || Array.isArray(args) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(args))) return false;
  const fields = Object.getOwnPropertyDescriptors(args);
  if (Reflect.ownKeys(fields).some(key => !ARGUMENTS.has(key) || !Object.hasOwn(fields[key], "value"))) return false;
  return Object.hasOwn(fields, "attachment_ref") && typeof args.attachment_ref === "string" &&
    /^[a-zA-Z0-9_-]{1,96}$/.test(args.attachment_ref);
}

function validRange(start, end) {
  return Number.isSafeInteger(start) && Number.isSafeInteger(end) && start >= 1 && end >= start && end - start < 40
    ? { mode: "range", start, end } : null;
}

function reportedTooLarge({ file, descriptor }) {
  return [descriptor.bytes, file.bytes, file.size, file.file_size, file.fileSize]
    .some(value => value !== null && value !== undefined && Number(value) > MAX_BYTES);
}

function evidenceMemo(evidence) {
  if (evidence?.status === "unsupported") return { status: "unavailable", text: "unsupported_format" };
  if (evidence?.status === "unavailable" && evidence.reason === "empty") return { status: "ok", text: "" };
  if (evidence?.status !== "ok" || typeof evidence.text !== "string") return { status: "unavailable", text: "read_failed" };
  if (Buffer.byteLength(evidence.text, "utf8") > MAX_BYTES) return { status: "unavailable", text: "size_limit" };
  const text = privateText(evidence.text).replace(/\r\n?/g, "\n");
  if (Buffer.byteLength(text, "utf8") > MAX_BYTES) return { status: "unavailable", text: "size_limit" };
  return { status: "ok", text };
}

function privateText(value) {
  // Canonicalize credential labels without removing line separators used by coverage.
  const normalized = String(value ?? "").normalize("NFKC").replace(/\p{Cf}/gu, "");
  const redacted = redactSensitiveText(redactAuthentication(normalized))
    .replace(/\b(?:https?|ftp|file):\/\/[^\s<>"']+/gi, "[REDACTED]")
    .replace(/\b((?:uid|qq|user_?id|group_?id|message_?id|reply_?to_?message_?id|turn_?id)["']?\s*[:=]\s*["']?)-?\d{1,20}\b/gi, "$1[REDACTED]")
    .replace(/\b\d{5,20}\b/g, "[REDACTED]");
  return redactAbsolutePaths(redacted);
}

function redactAuthentication(text) {
  // Mask complete authentication records and folded fields without changing line coordinates.
  const hide = (record, prefix) => prefix + record.slice(prefix.length).replace(/[^\r\n]+/g, "[REDACTED]");
  return text
    .replace(/(\b(?:proxy[-_]?authorization|authorization)["']?[ \t]*[:=][ \t]*)[^\r\n]*(?:(?:\r\n|\r|\n)[ \t]+[^\r\n]*)*/gi, hide)
    .replace(/(\b(?:Basic|Bearer|Digest)[ \t]+)[^\r\n]+(?:(?:\r\n|\r|\n)[ \t]+[^\r\n]*)*/gi, hide);
}

function redactAbsolutePaths(text) {
  // Text-only filtering, including quoted spaces and JSON escapes; never resolve a path.
  return text
    .replace(/(["'`])(?:[a-z]:[\\/]|\/|\\\\)(?:\\[^\r\n]|(?!\1)[^\r\n\\])*\1/gi, "$1[REDACTED]$1")
    .replace(/(?<![\p{L}\p{N}_])(?:[a-z]:[\\/]|\\\\|\/)[^\s<>"'`()[\]{},;]*/giu, "[REDACTED]");
}

function safeName(value) {
  const raw = typeof value === "string" ? value : "";
  if (/^[a-z][a-z\d+.-]*:/i.test(raw)) return "attachment";
  return privateText(raw.split(/[\\/]/).at(-1) || "attachment")
    .replace(/[\p{Cc}\p{Cf}]+/gu, " ").trim().slice(0, 80).replace(/[\uD800-\uDBFF]$/u, "") || "attachment";
}

function failure(status, selection, text = "", attachment_ref = "", name = "") {
  return { status, attachment_ref, name, text,
    coverage: { sourceComplete: false, totalLines: 0, fromLine: 0, toLine: 0, selection, truncated: true, remaining: null } };
}

function selectResult(ref, name, text, selection) {
  // Coordinates describe the privacy-filtered text, not a PDF/DOCX or an unredacted source.
  const lines = text.trim() ? text.split("\n") : [];
  let start = selection.start - 1;
  let end = Math.min(selection.end, lines.length);
  let hit = -1;
  if (selection.mode === "query") {
    hit = lines.findIndex(line => line.toLowerCase().includes(selection.query));
    // Only the first literal matching line and at most one adjacent line on each side.
    start = hit < 0 ? lines.length : Math.max(0, hit - 1);
    end = hit < 0 ? lines.length : Math.min(lines.length, hit + 2);
  }
  let selected = lines.slice(start, end);
  let partialSource = false;
  if (hit >= 0 && JSON.stringify(selectionResult(ref, name, lines.length, start, selected,
    selected.join("\n"), selection.mode, false)).length > MAX_RESULT) {
    // Oversized context must never crowd the actual match out of a query result.
    start = hit;
    const snippet = querySnippet(ref, name, lines, hit, selection.query);
    selected = [snippet];
    partialSource = snippet.length < lines[hit].length;
  }
  const excerpt = selected.join("\n");
  const build = length => selectionResult(ref, name, lines.length, start, selected,
    excerpt.slice(0, length).replace(/[\uD800-\uDBFF]$/u, ""), selection.mode, length < excerpt.length, partialSource);
  let low = 0;
  let high = excerpt.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (JSON.stringify(build(middle)).length <= MAX_RESULT) low = middle;
    else high = middle - 1;
  }
  return build(low);
}

function querySnippet(ref, name, lines, hit, query) {
  const line = lines[hit];
  const foldedOffset = line.toLowerCase().indexOf(query);
  const begin = sourceOffset(line, foldedOffset);
  const end = sourceOffset(line, foldedOffset + query.length, true);
  for (const context of [32, 16, 8, 4, 0]) {
    const snippet = line.slice(Math.max(0, begin - context), end + context)
      .replace(/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/gu, "");
    const value = selectionResult(ref, name, lines.length, hit, [snippet], snippet, "query", false, snippet.length < line.length);
    if (JSON.stringify(value).length <= MAX_RESULT) return snippet;
  }
  return line.slice(begin, end);
}

function sourceOffset(text, offset, roundUp = false) {
  let folded = 0;
  let source = 0;
  for (const point of text) {
    if (folded >= offset) return source;
    folded += point.toLowerCase().length;
    if (folded > offset) return source + (roundUp ? point.length : 0);
    source += point.length;
  }
  return source;
}

function selectionResult(ref, name, totalLines, start, selected, text, mode, clipped, partialSource = false) {
  const shown = clipped ? (text ? text.split("\n") : []) : selected;
  const partial = shown.length > 0 && (partialSource ||
    (clipped && shown.at(-1).length < selected[shown.length - 1].length));
  // Remaining counts every omitted or partial line, including lines before a range/query hit.
  const remaining = totalLines - shown.length + Number(partial);
  return { status: text.trim() ? "ok" : "empty", attachment_ref: ref, name, text,
    coverage: { sourceComplete: true, totalLines, fromLine: shown.length ? start + 1 : 0,
      toLine: shown.length ? start + shown.length : 0, selection: mode, truncated: clipped || partialSource || remaining > 0, remaining } };
}

async function abortable(run, signal) {
  signal?.throwIfAborted();
  if (!signal) return run();
  let onAbort;
  const cancelled = new Promise((_resolve, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try { return await Promise.race([Promise.resolve().then(run), cancelled]); }
  finally { signal.removeEventListener("abort", onAbort); }
}
