export function excludedMemorySource(message, excluded) {
  return [message?.messageId, message?.replyToMessageId, message?.turnId]
    .some(id => id !== undefined && id !== null && excluded?.has(String(id)));
}

// Follow only explicit stored links. Text similarity is not evidence of derivation.
export function expandMemorySourceExclusions(messages, excluded) {
  const result = new Set(excluded);
  const children = new Map();
  for (const message of messages) {
    const id = message?.messageId;
    if (id === undefined || id === null || id === "") continue;
    for (const parent of [message.replyToMessageId, message.turnId]) {
      if (parent === undefined || parent === null || parent === "") continue;
      const key = String(parent);
      if (!children.has(key)) children.set(key, []);
      children.get(key).push(String(id));
    }
  }
  const queue = [...result];
  for (let index = 0; index < queue.length; index++) {
    for (const id of children.get(queue[index]) || []) {
      if (result.has(id)) continue;
      result.add(id); queue.push(id);
    }
  }
  return result;
}
