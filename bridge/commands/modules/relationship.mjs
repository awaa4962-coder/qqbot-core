import { getActiveMemoryContext } from "../../memory-profile.mjs";
import { resolveMentionDisplayName } from "../../mentions/index.mjs";
import { computeRelationship } from "../../relationship.mjs";
import { getRelationshipShortComment } from "../../relationship-comment.mjs";
import { buildRelationshipSummary } from "../../relationship-commands.mjs";

export function buildRelationshipCommandReply(cmd, options) {
  const { relation, target, user } = buildRelationshipData(options);
  return buildRelationshipSummary(relation, cmd, {
    nicknames: user?.nicknames || [],
    subjectName: target.isSelf ? "" : target.displayName,
  });
}

export async function buildRelationshipCommandReplyAsync(cmd, options) {
  const { relation, target, user } = buildRelationshipData(options);
  const shortComment = relation ? await getRelationshipShortComment(relation, {
    user,
    groupId: options.groupId,
    now: options.now,
    callMiMo: options.callMiMo,
    callDeepSeek: options.callDeepSeek,
  }) : "";
  return buildRelationshipSummary(relation, cmd, {
    nicknames: user?.nicknames || [],
    subjectName: target.isSelf ? "" : target.displayName,
    shortComment,
  });
}

function buildRelationshipData(options) {
  const target = resolveRelationshipTarget(options);
  const uid = target.uid;
  const user = options.users?.[uid] || null;
  const memoryContext = options.memoryContext || getActiveMemoryContext(uid, options.groupId);
  const relation = user ? computeRelationship(user, {
    currentGroupId: options.groupId,
    currentGroupChats: options.groupChats || [],
    memoryContext,
  }) : null;
  return { relation, target, user };
}

function resolveRelationshipTarget(options = {}) {
  const selfUid = String(options.userId || "");
  const mention = firstMentionedUser(options);
  if (!mention) return { uid: selfUid, isSelf: true, displayName: "" };
  const uid = String(mention.qq || "");
  return {
    uid,
    isSelf: uid === selfUid,
    displayName: resolveMentionDisplayName(uid, {
      ...options,
      mention,
    }),
  };
}

function firstMentionedUser(options) {
  const mentions = Array.isArray(options.mentionedUsers)
    ? options.mentionedUsers
    : [];
  return mentions.find(item => !item.isBot && !item.isAll) || null;
}
