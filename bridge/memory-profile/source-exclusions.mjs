export function excludedMemorySource(message, excluded) {
  return [message?.messageId, message?.replyToMessageId, message?.turnId]
    .some(id => id !== undefined && id !== null && excluded?.has(String(id)));
}

// Follow only explicit stored links. Text similarity is not evidence of derivation.
export function expandMemorySourceExclusions(messages, excluded) {
  return createMemorySourceGraph(messages).expand(excluded);
}

export function createMemorySourceGraph(messages) {
  const children = new Map();
  const references = new Set();
  for (const message of messages) {
    const id = message?.messageId;
    if (id === undefined || id === null || id === "") continue;
    references.add(String(id));
    for (const parent of [message.replyToMessageId, message.turnId]) {
      if (parent === undefined || parent === null || parent === "") continue;
      const key = String(parent);
      references.add(key);
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
