const membership = new WeakMap();

// Object-local metadata cannot leak into provider JSON or merge separate conversation requests.
export function registerContextGroups(messages, layers) {
  const groups = new Map();
  layers.forEach((layer, index) => {
    if (!groups.has(layer.group)) groups.set(layer.group, { messages: [], sources: [], priority: layer.priority, order: layer.index });
    const group = groups.get(layer.group);
    group.messages.push(messages[index]);
    group.sources.push(...layer.sources);
    group.priority = Math.max(group.priority, layer.priority);
    group.order = Math.min(group.order, layer.index);
  });
  for (const group of groups.values()) for (const message of group.messages) membership.set(message, group);
}

export function registeredContextSources(messages) {
  const groups = [...new Set(messages.map(message => membership.get(message)).filter(Boolean))];
  return groups.flatMap(group => group.sources);
}

export function fitContextMessageGroups(request, maxChars, measure) {
  const original = request.messages || [];
  const present = new Set(original);
  const groups = [...new Set(original.map(message => membership.get(message)).filter(Boolean))];
  for (const group of groups) {
    if (!group.messages.every(message => present.has(message))) throw stopped("context_group_incomplete");
  }
  let messages = original;
  const removed = [];
  const removable = groups.filter(group => group.priority < 90).sort((a, b) => a.priority - b.priority || a.order - b.order);
  while (measure({ ...request, messages }).chars > maxChars && removable.length) {
    const group = removable.shift();
    const omit = new Set(group.messages);
    messages = messages.filter(message => !omit.has(message));
    removed.push(group);
  }
  if (measure({ ...request, messages }).chars > maxChars) throw stopped("tool_context_budget");
  return { messages, removed };
}

function stopped(reason) { return Object.assign(new Error(reason), { code: "CHAT_TOOL_STOPPED" }); }
