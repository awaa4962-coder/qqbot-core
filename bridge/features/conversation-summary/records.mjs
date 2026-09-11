import { CFG } from "../../config.mjs";
import { groupChats } from "../../storage.mjs";
import { loadSummaryCapture, boundedEvidenceText } from "../../group-summary/journal.mjs";
import { dateRange, formatDate } from "../../group-summary/date.mjs";
import { redactSummaryText } from "../../group-summary/formatter.mjs";
import { isSummaryCommandText, isSummaryNoiseText, normalizeEvidenceText } from "../../group-summary/evidence.mjs";
import { summaryPrivacy } from "../../group-summary/state.mjs";
import { isConversationSummaryCommand } from "./command.mjs";

export function selectSummaryRecords(groupId, targets, range, options = {}) {
  const captured = options.records ? { messages: options.records, partial: true } : loadRange(groupId, range, options);
  const privacy = summaryPrivacy(options);
  const scoped = captured.messages.filter(item => sameGroup(item, groupId));
  const records = usableRecords(scoped, range, privacy, { ...options, selfUin: options.selfUin ?? CFG.selfUin });
  const buckets = targets.map((target, index) => {
    const messages = records.filter(item => item.uid === target.uid);
    return { ...target, alias: "P" + (index + 1), name: safeName(target.name || messages.at(-1)?.nickname || "成员" + (index + 1)), count: messages.length, messages };
  });
  const names = buckets.map(item => item.name);
  for (const [index, person] of buckets.entries()) if (names.filter(name => name === person.name).length > 1) person.name += "（第" + (index + 1) + "位）";
  const selected = takeBalanced(buckets, options.targetBudget || 9500);
  const background = takeBackground(records, selected, new Set(targets.map(item => item.uid)), options.backgroundBudget || 2200);
  // OneBot timestamps may have only second precision; preserve capture order within a second.
  const included = [...selected, ...background].sort((a, b) => a.ts - b.ts || a.order - b.order);
  const authors = new Map(buckets.map(item => [item.uid, { alias: item.alias, name: item.name, target: true }]));
  const transcript = included.map((item, index) => {
    if (!authors.has(item.uid)) authors.set(item.uid, { alias: "C" + authors.size, name: safeName(item.nickname || "其他群友"), target: false });
    return { ...item, ...authors.get(item.uid), evidenceId: "M" + (index + 1) };
  });
  return {
    groupId: String(groupId), range, privacyEpoch: privacy.epoch,
    targets: buckets.map(({ uid, name, alias, count }) => ({ uid, name, alias, count })),
    transcript, selected: selected.length, background: background.length,
    sampled: selected.length < buckets.reduce((sum, person) => sum + person.count, 0),
    truncated: included.some(item => item.truncated), partial: captured.partial,
  };
}

function loadRange(groupId, range, options) {
  const messages = [];
  let partial = false;
  const live = (options.groupChats || groupChats)[String(groupId)];
  for (let day = dateRange(formatDate(new Date(range.from))).start; day <= range.to; day += 86400000) {
    const retained = live?.filter(item => item.ts >= day && item.ts < day + 86400000);
    const captured = loadSummaryCapture(formatDate(new Date(day)), groupId, { ...options, legacyMessages: retained });
    messages.push(...captured.messages);
    partial ||= !captured.coverage.complete;
  }
  return { messages, partial };
}

function usableRecords(messages, range, privacy, options) {
  const seen = new Set();
  const repeated = new Map();
  const result = [];
  let order = 0;
  for (const raw of [...messages].sort((a, b) => a.ts - b.ts)) {
    const item = { ...normalizedRecord(raw), order: order++ };
    if (!eligibleRecord(item, raw, range, privacy, options)) continue;
    const id = item.messageId || [item.uid, item.ts, item.text].join(":");
    if (seen.has(id)) continue;
    seen.add(id);
    const key = [item.uid, item.replyToMessageId, normalizeEvidenceText(item.text)].join(":");
    if (item.ts - (repeated.get(key) ?? -Infinity) < 20 * 60000) continue;
    repeated.set(key, item.ts); result.push(item);
  }
  return result;
}

function normalizedRecord(raw) {
  const original = redactSummaryText(raw.text || "");
  return { uid: String(raw.uid ?? raw.user_id ?? ""), nickname: raw.nickname || "", ts: Number(raw.ts),
    messageId: String(raw.messageId || ""), replyToMessageId: String(raw.replyToMessageId || ""),
    text: boundedEvidenceText(original, 600), truncated: raw.truncated === true || original.length > 600 };
}

function eligibleRecord(item, raw, range, privacy, options) {
  if (!item.uid || !Number.isFinite(item.ts) || item.ts < range.from || item.ts > range.to) return false;
  if (item.uid === String(options.selfUin) || raw.role === "assistant") return false;
  if (item.messageId && item.messageId === String(options.excludeMessageId)) return false;
  if (Number(privacy.users[item.uid] || 0) >= Number(raw.receivedAt || item.ts)) return false;
  return !isSummaryCommandText(item.text) && !isConversationSummaryCommand(item.text) && !isSummaryNoiseText(item.text);
}

function takeBalanced(people, budget) {
  const result = [];
  let used = 0;
  for (let offset = 1; offset <= 60; offset++) {
    for (const person of people) {
      const item = person.messages.at(-offset);
      if (!item) continue;
      const cost = JSON.stringify(item.text).length + 200;
      if (used + cost > budget) continue;
      result.push(item); used += cost;
    }
  }
  return result;
}

function takeBackground(records, targets, targetIds, budget) {
  const byId = new Map(records.filter(item => item.messageId).map(item => [item.messageId, item]));
  const wanted = new Set(targets.map(item => item.messageId).filter(Boolean));
  const candidates = [];
  for (const item of targets) {
    let parent = byId.get(item.replyToMessageId);
    for (let depth = 0; parent && depth < 2; depth++) { candidates.push(parent); parent = byId.get(parent.replyToMessageId); }
  }
  candidates.push(...records.filter(item => item.replyToMessageId && wanted.has(item.replyToMessageId)));
  for (const item of targets.filter(entry => entry.text.length < 35 && !entry.replyToMessageId)) {
    const index = records.indexOf(item);
    candidates.push(...records.slice(Math.max(0, index - 1), index + 2).filter(other => Math.abs(other.ts - item.ts) < 90000));
  }
  const result = [];
  const seen = new Set();
  let used = 0;
  for (const item of candidates) {
    if (targetIds.has(item.uid) || seen.has(item)) continue;
    seen.add(item);
    const cost = JSON.stringify(item.text).length + 200;
    if (result.length >= 40 || used + cost > budget) continue;
    result.push(item); used += cost;
  }
  return result;
}

function safeName(value) { return redactSummaryText(value).replace(/[\r\n\t]/g, " ").trim().slice(0, 40) || "群友"; }

function sameGroup(item, groupId) {
  const sourceGroup = item.groupId ?? item.group ?? item.group_id;
  return sourceGroup === undefined || String(sourceGroup) === String(groupId);
}
