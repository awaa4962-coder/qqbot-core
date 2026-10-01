const membership = new WeakMap();

export function hasRegisteredContextGroup(message) {
  return membership.has(message);
}

// Object-local metadata cannot leak into provider JSON or merge separate conversation requests.
export function registerContextGroups(messages, layers) {
  const groups = new Map();
  layers.forEach((layer, index) => {
    if (!groups.has(layer.group)) groups.set(layer.group, { messages: [], sources: [], readingLayers: new Map(), memorySources: [], expiresAt: null, priority: layer.priority, order: layer.index });
    const group = groups.get(layer.group);
    group.messages.push(messages[index]);
    group.sources.push(...layer.sources);
    group.readingLayers.set(messages[index], { priority: layer.priority, content: messages[index].content,
      sources: layer.sources.filter(source => source.kind === "quote").map(source => ({
        kind: "quote", userId: source.userId, messageId: source.messageId, verified: source.verified === true, clipped: source.clipped === true,
      })) });
    group.memorySources.push(...layer.memorySources);
    if (layer.memoryExpiresAt !== null) group.expiresAt = Math.min(group.expiresAt ?? Infinity, layer.memoryExpiresAt);
    group.priority = Math.max(group.priority, layer.priority);
    group.order = Math.min(group.order, layer.index);
  });
  for (const group of groups.values()) for (const message of group.messages) membership.set(message, group);
}

export function registeredContextSources(messages) {
  const groups = [...new Set(messages.map(message => membership.get(message)).filter(Boolean))];
  return groups.flatMap(group => group.sources);
}

// Only actual, retained high-priority quote layers qualify; text labels cannot forge this registry.
export function registeredQuoteReading(messages = []) {
  const present = new Set(messages);
  const quotes = [];
  let chars = 0;
  for (const message of messages) {
    const group = membership.get(message);
    const layer = group?.readingLayers.get(message);
    if (!layer || layer.priority < 90 || message.role !== "user" || typeof message.content !== "string" ||
      ["tool_calls", "tool_call_id", "providerContinuation", "reasoning_content"].some(key => message[key] !== undefined) ||
      message.content !== layer.content || !group.messages.every(item => present.has(item)) ||
      !layer.sources.length || quotes.length >= 2) continue;
    const sources = layer.sources.map(source => ({ speakerUid: readingIdentifier(source.userId),
      messageId: readingIdentifier(source.messageId, true), sourceVerified: source.verified,
      excerptTruncated: source.clipped }));
    const quote = { role: "quoted_utterance", sources, providedFrame: layer.content };
    const size = JSON.stringify(quote).length;
    if (chars + size > 2000) continue;
    chars += size;
    quotes.push(quote);
  }
  return quotes;
}

function readingIdentifier(value, signed = false) {
  if (typeof value !== "string" && !(typeof value === "number" && Number.isSafeInteger(value))) return null;
  const text = String(value);
  return (signed ? /^(?:0|-?[1-9]\d{0,19})$/ : /^[1-9]\d{0,19}$/).test(text) ? text : null;
}

export function registeredContextMemorySources(messages) {
  const groups = [...new Set(messages.map(message => membership.get(message)).filter(Boolean))];
  return groups.flatMap(group => group.memorySources);
}

export function registeredContextExpiry(messages) {
  const groups = [...new Set(messages.map(message => membership.get(message)).filter(Boolean))];
  return groups.reduce((expiry, group) => group.expiresAt === null ? expiry : Math.min(expiry ?? Infinity, group.expiresAt), null);
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
