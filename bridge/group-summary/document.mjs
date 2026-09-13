import { redactSummaryText } from "./formatter.mjs";
import { getSummaryStyle } from "./styles.mjs";

const failed = reason => ({ ok: false, document: null, reason });
const validText = (value, max) => typeof value === "string" && value.trim().length > 0 && value.length <= max;
const validReferences = (ids, valid) => Array.isArray(ids) && ids.length > 0 && ids.length <= 24 && ids.every(id => valid.has(id));

export function parseSummaryDocumentResult(text, bundle, options = {}) {
  let raw;
  try { raw = JSON.parse(String(text).trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "")); }
  catch { return failed("invalid_json"); }
  if (!Array.isArray(raw?.topics) || !raw.topics.length || raw.topics.length > getSummaryStyle(options.style).maxTopics) return failed("invalid_topic_count");
  const parsed = raw.topics.map(item => parseTopic(item, bundle));
  const invalid = parsed.find(item => !item.ok);
  if (invalid) return invalid;
  const topics = parsed.map(item => item.topic);
  return finishDocument(raw, topics, options);
}

function finishDocument(raw, topics, options) {
  if (new Set(topics.map(item => item.id)).size !== topics.length) return failed("duplicate_topic");
  if (options.onlyDiscussionId && (topics.length !== 1 || topics[0].id !== options.onlyDiscussionId)) return failed("rewrite_scope_mismatch");
  const references = new Set(topics.flatMap(item => item.evidenceIds));
  if (raw.headline && (!validText(raw.headline, 160) || !validReferences(raw.headlineEvidenceIds, references))) return failed("invalid_headline_evidence");
  return { ok: true, reason: "", document: {
    headline: redactSummaryText(raw.headline || ""), headlineEvidenceIds: raw.headline ? [...new Set(raw.headlineEvidenceIds)] : [], topics,
  } };
}

function parseTopic(item, bundle) {
  if (!item || typeof item !== "object") return failed("invalid_topic");
  const available = new Map(bundle.discussions.map(entry => [entry.id, entry]));
  if (!available.has(item.id) || !validDeclaredSources(item.sourceDiscussionIds, available)) return failed("invalid_source_discussions");
  const owners = new Map(bundle.discussions.flatMap(entry => entry.messages.map(message => [message.evidenceId, entry.id])));
  if (!validReferences(item.evidenceIds, owners)) return failed("invalid_topic_evidence");
  // Source membership comes from trusted evidence, not a second model-maintained index.
  const sources = [...new Set(item.evidenceIds.map(id => owners.get(id)))];
  if (!sources.includes(item.id)) return failed("topic_anchor_mismatch");
  if (!["resolved", "open", "chat"].includes(item.status)) return failed("invalid_topic_status");
  if (!validText(item.title, 60) || !validText(item.body, 800)) return failed("invalid_topic_text");
  return { ok: true, topic: {
    id: item.id, sourceDiscussionIds: sources, title: redactSummaryText(item.title), body: redactSummaryText(item.body),
    status: item.status, evidenceIds: [...new Set(item.evidenceIds)],
  } };
}

function validDeclaredSources(sources, available) {
  return sources === undefined || (Array.isArray(sources) && sources.length > 0 && sources.length <= 24 && sources.every(id => available.has(id)));
}

export function parseSummaryDocument(text, bundle, options = {}) {
  return parseSummaryDocumentResult(text, bundle, options).document;
}
