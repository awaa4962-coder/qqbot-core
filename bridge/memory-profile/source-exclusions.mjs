export function excludedMemorySource(message, excluded) {
  if (message?.memoryCommand || message?.retracted || message?.deleted || message?.recalled || normalizeSourceMessageIds(message?.memorySourceIds) === null) return true;
  return [message?.messageId, ...sourceMessageParents(message)]
    .some(id => id !== undefined && id !== null && excluded?.has(String(id)));
}

export function normalizeSourceMessageIds(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 32 || value.some(id => !/^-?\d{1,20}$/.test(String(id)) ||
    (typeof id !== "string" && !Number.isSafeInteger(id)))) return null;
  return [...new Set(value.map(String))];
}

export function sourceMessageParents(message) {
  return [message?.replyToMessageId, message?.turnId, ...(normalizeSourceMessageIds(message?.memorySourceIds) || [])]
    .filter(id => id !== undefined && id !== null && id !== "").map(String);
}

export function collectSourceMessageIds(messages, parents) {
  const sources = new Map();
  for (const message of messages) {
    if (!sources.has(message.messageId)) sources.set(message.messageId, []);
    sources.get(message.messageId).push(message);
  }
  const ids = normalizeSourceMessageIds(parents);
  if (!ids) return null;
  const seen = new Set(ids);
  for (let i = 0; i < ids.length; i++) {
    for (const row of sources.get(ids[i]) || []) {
      if (normalizeSourceMessageIds(row.memorySourceIds) === null) return null;
      for (const parent of sourceMessageParents(row)) {
        if (seen.has(parent)) continue;
        if (seen.size >= 32 || !normalizeSourceMessageIds([parent])) return null;
        seen.add(parent); ids.push(parent);
      }
    }
  }
  return ids;
}

// Follow only explicit stored links. Text similarity is not evidence of derivation.
export function expandMemorySourceExclusions(messages, excluded) {
  const inherited = messages.filter(message => (message?.retracted || normalizeSourceMessageIds(message?.memorySourceIds) === null) && message.messageId)
    .map(message => String(message.messageId));
  return createMemorySourceGraph(messages).expand(new Set([...excluded, ...inherited]));
}

export function createMemorySourceGraph(messages) {
  const children = new Map();
  const references = new Set();
  for (const message of messages) {
    const id = message?.messageId;
    if (id !== undefined && id !== null && id !== "") references.add(String(id));
    for (const parent of sourceMessageParents(message)) {
      const key = String(parent);
      references.add(key);
      if (id === undefined || id === null || id === "") continue;
      if (!children.has(key)) children.set(key, []);
      children.get(key).push(String(id));
    }
  }
  function expand(excluded) {
    const result = new Set(excluded);
    const queue = [...result];
    for (let index = 0; index < queue.length; index++) {
      for (const id of children.get(queue[index]) || []) {
        if (result.has(id)) continue;
        result.add(id); queue.push(id);
      }
    }
    return result;
  }
  return { references, expand };
}
