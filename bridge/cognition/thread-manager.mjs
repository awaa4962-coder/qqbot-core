import { saveUsers, users } from "../storage.mjs";
import { wallAgeMs } from "../runtime-clock.mjs";
import { currentTopicText } from "../context/relevance.mjs";
import { redactSensitiveText } from "../privacy.mjs";

const GROUP_THREAD_TTL_MS = 90 * 60 * 1000;
const PRIVATE_THREAD_TTL_MS = 6 * 60 * 60 * 1000;
const MAX_TURNS = 8;
const MAX_SCOPES_PER_USER = 8;
const PRIVATE_THREADS = new Map();

const CONTINUATION_RE = /^(?:还是|依旧|仍然|继续|然后|刚才|之前|这个|那个|它|又|没用|不行|好了|可以了|再试|怎么办)/;
const TOPIC_RULES = Object.freeze([
  ["JM 下载", /\bjm\b|jmcomic|漫画|解压|压缩包/i],
  ["机器人回复异常", /不回|没回复|自动回复|答非所问|人机感|回复异常|没动静/],
  ["记忆与上下文", /记忆|上下文|画像|个性化|称呼/],
  ["日报", /日报|群报|小报|总结/],
  ["命令与帮助", /命令|帮助|help|管理员/i],
  ["图片理解", /识图|图片|人物识别|看图/],
  ["梗库", /梗库|玩梗|复读|热梗/],
  ["关系状态", /好感度|熟悉度|关系状态|关系系统/],
  ["代码与故障", /代码|bug|报错|日志|修复|依赖|接口|api/i],
]);

export function recordConversationTurn(event = {}, options = {}) {
  const uid = String(event.uid || event.userId || "");
  const scope = normalizeScope(event.groupId || event.scope);
  const userSummary = compactText(event.userText, 320);
  const assistantSummary = compactText(event.assistantText, 480);
  if (!uid || !userSummary || !assistantSummary) return null;

  const now = Number(event.now || Date.now());
  const userStore = options.userStore || users;
  const thread = resolveWritableThread(uid, scope, now, userStore);
  const turn = buildTurn(event, userSummary, assistantSummary, now);

  upsertTurn(thread, turn);
  thread.topic = resolveTopic(userSummary, thread.topic);
  thread.updatedAt = now;
  thread.expiresAt = now + ttlForScope(scope);
  thread.lastOutcome = turn.outcome;

  persistGroupThread(uid, scope, now, userStore, options);
  return snapshotThread(thread, scope);
}

function resolveWritableThread(uid, scope, now, userStore) {
  if (scope === "private") return getOrCreatePrivateThread(uid, now);
  return getOrCreateGroupThread(uid, scope, now, userStore);
}

function persistGroupThread(uid, scope, now, userStore, options) {
  if (scope === "private" || options.save === false) return;
  pruneGroupThreads(userStore[uid], now);
  (options.saveUsers || saveUsers)();
}

export function getConversationThread(uid, groupId, options = {}) {
  const id = String(uid || "");
  const scope = normalizeScope(groupId);
  const now = Number(options.now || Date.now());
  if (!id) return null;

  const thread = scope === "private"
    ? PRIVATE_THREADS.get(privateKey(id))
    : (options.userStore || users)[id]?.cognition?.threads?.[scope];
  if (!isActiveThread(thread, now)) return null;
  return snapshotThread(thread, scope);
}

export function buildConversationThreadBlock(uid, groupId, options = {}) {
  const thread = getConversationThread(uid, groupId, options);
  return formatConversationThreadBlock(thread, options);
}

export function formatConversationThreadBlock(thread, options = {}) {
  if (!thread?.turns?.length) return "";
  const turns = thread.turns.slice(-(options.limit || 4));
  const lines = [
    "[短期会话线程]",
    "用途：恢复承接词、上一轮处理结果和未说完的话题；当前输入优先，禁止向其他群或用户泄露。",
    "范围=" + thread.scope + "；话题=" + (thread.topic || "连续对话") + "；已发送回合=" + thread.turnCount,
    "以下为同一发言人的历史摘录，可能有省略；助手回复已发送，但建议不代表用户已执行，更不代表问题已解决。",
    "最近回合：",
  ];
  for (const turn of turns) {
    lines.push("- 用户：" + compactText(turn.userSummary, 320));
    lines.push("  夜星：" + compactText(turn.assistantSummary, 480));
  }
  return lines.join("\n");
}

export function formatConversationThreadLayers(thread, options = {}) {
  if (!thread?.turns?.length) return [];
  return thread.turns.slice(-(options.limit || 4)).map(turn => ({
    turn,
    clipped: Boolean(turn.userTruncated || turn.assistantTruncated ||
      normalizedText(turn.userSummary).length > 320 || normalizedText(turn.assistantSummary).length > 480),
    content: formatConversationThreadBlock({ ...thread, turns: [turn], turnCount: 1 }),
  }));
}

export function clearConversationThreads(uid, options = {}) {
  const id = String(uid || "");
  if (!id) return false;
  const userStore = options.userStore || users;
  if (userStore[id]?.cognition) delete userStore[id].cognition;
  PRIVATE_THREADS.delete(privateKey(id));
  if (options.save !== false) (options.saveUsers || saveUsers)();
  return true;
}

export function getCognitionStatus(options = {}) {
  const now = Number(options.now || Date.now());
  const userStore = options.userStore || users;
  let groupThreads = 0;
  let turns = 0;
  for (const user of Object.values(userStore)) {
    for (const thread of Object.values(user?.cognition?.threads || {})) {
      if (!isActiveThread(thread, now)) continue;
      groupThreads++;
      turns += Array.isArray(thread.turns) ? thread.turns.length : 0;
    }
  }
  let privateThreads = 0;
  for (const thread of PRIVATE_THREADS.values()) {
    if (isActiveThread(thread, now)) privateThreads++;
  }
  return {
    enabled: true,
    schemaVersion: 1,
    groupThreads,
    privateThreads,
    completedTurns: turns,
    privatePersistence: false,
  };
}

export function resetCognitionForTest() {
  PRIVATE_THREADS.clear();
}

function getOrCreatePrivateThread(uid, now) {
  const key = privateKey(uid);
  let thread = PRIVATE_THREADS.get(key);
  if (!isActiveThread(thread, now)) {
    thread = createThread("private", now);
    PRIVATE_THREADS.set(key, thread);
  }
  return thread;
}

function getOrCreateGroupThread(uid, scope, now, userStore) {
  const user = userStore[uid] || (userStore[uid] = { uid, nicknames: [], chats: [] });
  if (!user.cognition || typeof user.cognition !== "object") {
    user.cognition = { schemaVersion: 1, threads: {} };
  }
  if (!user.cognition.threads || typeof user.cognition.threads !== "object") {
    user.cognition.threads = {};
  }
  let thread = user.cognition.threads[scope];
  if (!isActiveThread(thread, now)) {
    thread = createThread(scope, now);
    user.cognition.threads[scope] = thread;
  }
  return thread;
}

function createThread(scope, now) {
  return {
    schemaVersion: 1,
    scope,
    topic: "",
    turns: [],
    createdAt: now,
    updatedAt: now,
    expiresAt: now + ttlForScope(scope),
    lastOutcome: "",
  };
}

function buildTurn(event, userSummary, assistantSummary, now) {
  const explicitId = normalizeId(event.messageId || event.turnId);
  return {
    id: explicitId || "turn-" + now,
    messageId: explicitId,
    userSummary,
    assistantSummary,
    userTruncated: normalizedText(event.userText).length > 320,
    assistantTruncated: normalizedText(event.assistantText).length > 480,
    outcome: String(event.outcome || "sent"),
    createdAt: now,
    ...(Array.isArray(event.memorySources) ? { memorySources: event.memorySources.filter(source => /^[a-f0-9]{12}$/.test(source.noteId || "") && Number.isSafeInteger(source.revision))
      .slice(0, 4).map(source => ({ noteId: source.noteId, revision: source.revision })) } : {}),
  };
}

function upsertTurn(thread, turn) {
  const turns = Array.isArray(thread.turns) ? thread.turns : [];
  const index = turn.messageId
    ? turns.findIndex(item => String(item.messageId || item.id) === turn.messageId)
    : -1;
  if (index >= 0) turns[index] = turn;
  else turns.push(turn);
  thread.turns = turns.slice(-MAX_TURNS);
}

function resolveTopic(text, previousTopic) {
  const value = currentTopicText(text).text;
  for (const [label, pattern] of TOPIC_RULES) {
    if (pattern.test(value)) return label;
  }
  if (previousTopic && CONTINUATION_RE.test(value)) return previousTopic;
  return compactText(value.replace(/https?:\/\/\S+/gi, "").replace(/\[CQ:[^\]]+\]/g, ""), 28) || previousTopic || "连续对话";
}

function pruneGroupThreads(user, now) {
  const threads = user?.cognition?.threads;
  if (!threads) return;
  const active = Object.entries(threads)
    .filter(([, thread]) => isActiveThread(thread, now))
    .sort((a, b) => Number(b[1].updatedAt || 0) - Number(a[1].updatedAt || 0))
    .slice(0, MAX_SCOPES_PER_USER);
  user.cognition.threads = Object.fromEntries(active);
}

function snapshotThread(thread, scope) {
  const turns = (thread.turns || []).map(turn => ({ ...turn }));
  return {
    schemaVersion: 1,
    scope,
    topic: redactSensitiveText(thread.topic),
    turnCount: turns.length,
    turns,
    updatedAt: Number(thread.updatedAt || 0),
    expiresAt: Number(thread.expiresAt || 0),
    lastOutcome: thread.lastOutcome || "",
    privacy: scope === "private" ? "volatile-private" : "same-group-only",
  };
}

function isActiveThread(thread, now) {
  if (!thread || !Array.isArray(thread.turns)) return false;
  const updatedAt = Number(thread.updatedAt || 0);
  if (updatedAt) return wallAgeMs(updatedAt, now) < ttlForScope(thread.scope);
  return Number(thread.expiresAt || 0) > now;
}

function ttlForScope(scope) {
  return scope === "private" ? PRIVATE_THREAD_TTL_MS : GROUP_THREAD_TTL_MS;
}

function normalizeScope(value) {
  const scope = String(value || "private");
  return scope === "private" ? "private" : scope;
}

function normalizeId(value) {
  if (value === undefined || value === null || value === "") return "";
  return String(value).slice(0, 80);
}

function privateKey(uid) {
  return String(uid) + ":private";
}

function compactText(value, maxLength) {
  const text = normalizedText(value);
  if (text.length <= maxLength) return text;
  const marker = "…[中间省略]…";
  const headLength = Math.ceil((maxLength - marker.length) * 0.6);
  return text.slice(0, headLength).trimEnd() + marker + text.slice(-(maxLength - marker.length - headLength)).trimStart();
}

function normalizedText(value) {
  return redactSensitiveText(value).replace(/\s+/g, " ").trim();
}
