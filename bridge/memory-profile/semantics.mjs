const recorded = [{ id: "recorded", label: "已记录" }];
const types = [
  { id: "unclassified", label: "未分类说明", statuses: recorded },
  { id: "fact", label: "事实说明", statuses: recorded },
  { id: "event", label: "历史事件", statuses: recorded },
  { id: "todo", label: "待办事项", statuses: [
    { id: "pending", label: "待办" }, { id: "in_progress", label: "进行中" },
    { id: "done", label: "已完成" }, { id: "cancelled", label: "已取消" },
  ] },
  { id: "current_state", label: "当前状态", statuses: [
    { id: "current", label: "当前有效" }, { id: "ended", label: "已结束" },
  ] },
];
for (const type of types) {
  for (const status of type.statuses) Object.freeze(status);
  Object.freeze(type.statuses); Object.freeze(type);
}
export const MEMORY_SEMANTICS = Object.freeze({ recordTypes: Object.freeze(types) });

export function projectNoteSemantics(item = {}) {
  return { recordType: item.recordType ?? "unclassified", status: item.status ?? "recorded", eventAt: item.eventAt ?? null };
}

export function buildNoteSemantics(payload, previous, now) {
  const old = projectNoteSemantics(previous || {});
  const recordType = payload.recordType === undefined ? old.recordType : payload.recordType;
  const definition = types.find(type => type.id === recordType);
  if (!definition) throw semanticError("请选择有效的记忆类型。");
  const status = payload.status === undefined ? (previous && recordType === old.recordType ? old.status : definition.statuses[0].id) : payload.status;
  const eventAt = payload.eventAt === undefined ? recordType === "event" ? old.eventAt : null : payload.eventAt;
  const result = { recordType, status, eventAt };
  if (!validNoteSemantics(result)) throw semanticError("记忆类型、事项状态或事件时间不匹配。");
  if (eventAt !== null && eventAt > now) throw semanticError("历史事件的发生时间不能在未来；尚未发生的计划请记为待办。");
  return result;
}

export function validNoteSemantics(item) {
  if ([item.recordType, item.status, item.eventAt].every(value => value === undefined)) return true;
  const type = types.find(entry => entry.id === item.recordType);
  if (!type || !type.statuses.some(status => status.id === item.status)) return false;
  const at = item.eventAt;
  if (at === null || at === undefined) return true;
  return type.id === "event" && Number.isSafeInteger(at) && at > 0 && at < 253_402_272_000_000;
}

export function assertNoteTransition(previous, payload, now) {
  if (!previous || !["todo", "current_state"].includes(previous.recordType)) throw semanticError("只有待办和当前状态可以更新事项状态。");
  if (previous.expiresAt <= now) throw semanticError("记录已过期，请先纠正并确认有效期，再更新状态。", 409);
  if (payload.status === undefined) throw semanticError("请选择要更新的事项状态。");
  if (payload.status === previous.status) throw semanticError("事项已经是这个状态，请刷新核对。", 409);
  if (["recordType", "eventAt", "title", "text", "ttlDays"].some(key => payload[key] !== undefined)) {
    throw semanticError("状态更新不能同时修改正文、类型或有效期。");
  }
}

export function noteSemanticText(item) {
  const value = projectNoteSemantics(item);
  const definition = types.find(type => type.id === value.recordType);
  const status = definition?.statuses.find(entry => entry.id === value.status)?.label || "未知";
  const event = value.recordType === "event" ? "；发生时间=" + (value.eventAt === null ? "未提供，不以记录时间代替" : new Date(value.eventAt).toISOString()) : "";
  const validity = item.state === "active" ? "后端核验未过期（仅此条）" : item.state === "expired" ? "已过期" : "未知";
  return "资料类型=" + (definition?.label || "未知") + "；事项状态=" + status + "；记录有效性=" + validity + event;
}

export function noteSemanticQueryScore(item, query) {
  const terms = { todo: /待办|事项|\btodo\b/i, current_state: /当前状态|近况/, event: /事件|经历/, fact: /事实|资料/ };
  const pattern = Object.hasOwn(terms, item.recordType) ? terms[item.recordType] : null;
  // Category queries need not contain the original title; they are not inferred personal facts.
  return pattern?.test(query) ? 1 : 0;
}

export const MEMORY_SEMANTIC_BOUNDARY = "事实说明是来源陈述，未客观验证；历史事件不等于现在。待办/进行中不是完成，已完成仅是操作者声明，不是机器人执行回执。事项结束与记录过期不同，以后端有效性为准；过期不推相反状态。当前候选非全范围，也不自动对应‘那条’；未过期仅属该条，不能用剩余条目替代缺失目标。未提供不等于已删除；无查询/删除执行回执不称查过/已删，有明确回执仅按其对象、范围确认。外部现状无本轮实时结果仅述最新记录，不暗示检查或确定停运/正常；未知不当已证。自然回答，不念内部标签。";

function semanticError(message, statusCode = 400) { return Object.assign(new Error(message), { statusCode }); }
