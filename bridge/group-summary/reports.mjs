import path from "node:path";
import { randomUUID } from "node:crypto";
import { assertSummaryEpoch, readSummaryJson, summaryKey, summaryPrivacy, summaryRoot, withSummaryWriteLock, writeSummaryJson } from "./state.mjs";
import { summaryUserKey } from "./evidence.mjs";
import { readSummaryDelivery } from "./publisher.mjs";

export function reportFile(dateText, groupId, options = {}) {
  return path.join(summaryRoot(options), "reports", summaryKey(dateText, groupId) + ".json");
}

export function readReport(dateText, groupId, options = {}) {
  const record = readSummaryJson(reportFile(dateText, groupId, options), { dateText, groupId, revisions: [] });
  const privacy = summaryPrivacy(options);
  record.revisions = record.revisions.filter(item => !(item.contributors || []).some(uid => Number(privacy.users[uid] || 0) >= item.createdAt));
  return record;
}

export function saveReportRevision(result, options = {}) {
  return withSummaryWriteLock(options, () => {
    assertSummaryEpoch(result.privacyEpoch, options);
    const report = readReport(result.dateText, result.groupId, options);
    if (options.expectedRevisionId && report.revisions.at(-1)?.id !== options.expectedRevisionId) throw new Error("草稿已有新版本，请刷新后再保存");
    const revision = {
      id: randomUUID(), createdAt: Date.now(), kind: options.kind || "generated",
      dateText: result.dateText, groupId: result.groupId, summary: result.summary,
      document: result.document, bundle: result.bundle, provider: result.provider,
      coverage: result.coverage, privacyEpoch: result.privacyEpoch,
      contributors: [...new Set((result.bundle?.discussions || []).flatMap(item => item.messages.map(summaryUserKey)))],
    };
    report.revisions.push(revision);
    report.revisions = retainRevisions(report, options);
    writeSummaryJson(reportFile(result.dateText, result.groupId, options), report);
    return revision;
  });
}

function retainRevisions(report, options) {
  const delivery = readSummaryDelivery(report.dateText, report.groupId, options);
  const pending = ["partial", "unconfirmed"].includes(delivery.status);
  const pinned = pending && report.revisions.find(item => item.id === delivery.revisionId);
  const recent = report.revisions.slice(-10);
  // Recovery requires the exact original body, even after newer drafts exist.
  return pinned && !recent.includes(pinned) ? [pinned, ...recent.slice(-9)] : recent;
}

export function publicRevision(revision) {
  if (!revision) return null;
  return {
    id: revision.id, createdAt: revision.createdAt, kind: revision.kind, summary: revision.summary,
    document: revision.document, provider: revision.provider, coverage: revision.coverage,
    evidence: (revision.bundle?.discussions || []).flatMap(discussion => discussion.messages.map(item => ({
      id: item.evidenceId, discussionId: discussion.id, actorId: item.actorId,
      nickname: item.nickname, text: item.text, ts: item.ts,
    }))),
  };
}
