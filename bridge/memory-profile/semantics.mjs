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
  const validity = item.state === "active" ? "后端核验未过期" : item.state === "expired" ? "已过期" : "未知";
  return "资料类型=" + (definition?.label || "未知") + "；事项状态=" + status + "；记录有效性=" + validity + event;
}

export function noteSemanticQueryScore(item, query) {
  const terms = { todo: /待办|事项|\btodo\b/i, current_state: /当前状态|近况/, event: /事件|经历/, fact: /事实|资料/ };
  const pattern = Object.hasOwn(terms, item.recordType) ? terms[item.recordType] : null;
  // Category queries need not contain the original title; they are not inferred personal facts.
  return pattern?.test(query) ? 1 : 0;
}

export const MEMORY_SEMANTIC_BOUNDARY = "事实说明仍是来源的陈述，未作客观验证；历史事件不等于现在仍然如此。待办/进行中不是完成，已完成只是操作者明确声明，不是机器人执行回执。事项已结束与记录过期是两回事，以后端的记录有效性为准；过期信息不能推成相反状态。问外部系统现在如何时，未取得本轮实时结果就只说最新记录写明什么，不把记录中的已结束说成当前确定不在维护或运行正常，也不暗示执行过检查。用正常聊天的说法回答，不向用户念资料类型、记录有效性或回执等内部术语。";

function semanticError(message, statusCode = 400) { return Object.assign(new Error(message), { statusCode }); }
