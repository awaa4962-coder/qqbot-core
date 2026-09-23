import { redactSensitiveText } from "../privacy.mjs";
import { normalizeMemoryDependencies } from "./memory-dependencies.mjs";
import { registerContextGroups } from "./pruning.mjs";

const MAX_LAYERS = 128;
const MAX_SOURCES = 128;
const MODE_LIMITS = Object.freeze({
  "group-at": { maxChars: 6500, maxMessages: 14, maxMessageChars: 2200 },
  private: { maxChars: 5200, maxMessages: 12, maxMessageChars: 1800 },
  "private-file": { maxChars: 14000, maxMessages: 16, maxMessageChars: 11000 },
  interjection: { maxChars: 1200, maxMessages: 3, maxMessageChars: 700 },
});

export function estimateContextBudget(messages, currentInput = "") {
  const currentChars = String(currentInput || "").length;
  return { messageCount: Array.isArray(messages) ? messages.length : 0,
    chars: (messages || []).reduce((total, item) => total + String(item?.content || "").length, currentChars),
    currentInputChars: currentChars };
}

export function enforceContextBudget(messages, currentInput = "", options = {}) {
  const limits = resolveContextLimits(options.mode, options);
  const currentChars = String(currentInput || "").length;
  if (currentChars > limits.maxChars) throw budgetError("context_current_input_limit");
  const layers = normalizeLayers(messages);
  const groups = contextGroups(layers);
  const selected = selectGroups(groups, limits, currentChars);
  const accepted = selected.layers.sort((a, b) => a.index - b.index);
  const bounded = accepted.map(({ role, content }) => ({ role, content }));
  registerContextGroups(bounded, accepted);
  return { messages: bounded, memorySources: selected.memorySources,
    sources: accepted.flatMap(item => item.sources),
    budget: { ...estimateContextBudget(bounded, currentInput), maxChars: limits.maxChars, maxMessages: limits.maxMessages,
      originalMessageCount: layers.length, prunedMessageCount: layers.length - bounded.length,
      truncatedMessageCount: accepted.filter(item => item.truncated).length,
      originalGroupCount: groups.length, selectedGroupCount: selected.groups, prunedGroupCount: groups.length - selected.groups,
      selectedSourceCount: selected.sourceCount, rejectedSourceGroups: selected.rejectedSourceGroups,
      rejectedDependencyGroups: selected.rejectedDependencyGroups } };
}

function normalizeLayers(messages) {
  if (!Array.isArray(messages)) return [];
  if (messages.length > MAX_LAYERS) throw budgetError("context_layer_limit");
  return messages.map(normalizeLayer);
}

function normalizeLayer(item, index) {
    assertHistoryLayer(item);
    const sources = sourceReferences(item);
    const group = item?.contextGroup;
    if (group !== undefined && (typeof group !== "string" || !group || group.length > 160)) throw budgetError("context_group_invalid");
    return { index, group: group ?? Symbol(index), role: item?.role || "user",
      priority: Number.isFinite(item?.contextPriority) ? item.contextPriority : 50,
      content: redactSensitiveText(item?.content).trim(),
      atomic: isAtomic(item, sources, group),
      sources, memorySources: layerDependencies(item, sources) };
}

function assertHistoryLayer(item) {
  // Native tool transcripts stay intact in chat-tools/session, never text-projected here.
  if (hasProtocolPayload(item)) throw budgetError("context_protocol_transcript");
  if (item?.content !== undefined && item.content !== null && typeof item.content !== "string") throw budgetError("context_nontext_layer");
}

function sourceReferences(item) { return Array.isArray(item?.contextSources) ? item.contextSources.map(source => ({ ...source })) : []; }
function isAtomic(item, sources, group) { return item?.contextAtomic === true || sources.length > 0 || group !== undefined; }

function hasProtocolPayload(item) {
  return item?.role === "tool" || ["tool_calls", "tool_call_id", "providerContinuation", "reasoning_content"].some(key => item?.[key] !== undefined);
}

function contextGroups(layers) {
  const map = new Map();
  for (const layer of layers) {
    if (!map.has(layer.group)) map.set(layer.group, { layers: [], priority: layer.priority, latest: layer.index });
    const group = map.get(layer.group);
    group.layers.push(layer); group.priority = Math.max(group.priority, layer.priority); group.latest = Math.max(group.latest, layer.index);
  }
  return [...map.values()].sort((a, b) => b.priority - a.priority || b.latest - a.latest);
}

function selectGroups(groups, limits, currentChars) {
  const result = { layers: [], memorySources: [], groups: 0, sourceCount: 0, rejectedSourceGroups: 0, rejectedDependencyGroups: 0 };
  let remaining = limits.maxChars - currentChars;
  for (const group of groups) {
    if (result.layers.length + group.layers.length > limits.maxMessages) continue;
    const sources = group.layers.reduce((count, layer) => count + layer.sources.length, 0);
    if (result.sourceCount + sources > MAX_SOURCES) { result.rejectedSourceGroups++; continue; }
    const dependencies = groupDependencies(group, result.memorySources);
    if (!dependencies) { result.rejectedDependencyGroups++; continue; }
    const accepted = fitGroup(group, limits, remaining);
    if (!accepted) continue;
    result.layers.push(...accepted);
    result.memorySources = dependencies; result.sourceCount += sources; result.groups++;
    remaining -= accepted.reduce((count, layer) => count + layer.content.length, 0);
  }
  return result;
}

function groupDependencies(group, previous) {
  if (group.layers.some(layer => layer.memorySources === null)) return null;
  return normalizeMemoryDependencies([...previous, ...group.layers.flatMap(layer => layer.memorySources)]);
}

function fitGroup(group, limits, remaining) {
  if (group.layers.some(layer => !layer.content)) return null;
  if (group.layers.length === 1 && !group.layers[0].atomic) {
    const layer = group.layers[0];
    const content = clipUnframedText(layer.content, Math.min(limits.maxMessageChars, remaining));
    return content ? [{ ...layer, content, truncated: content.length < layer.content.length }] : null;
  }
  if (group.layers.some(layer => layer.content.length > limits.maxMessageChars)) return null;
  return group.layers.reduce((total, layer) => total + layer.content.length, 0) <= remaining ? group.layers : null;
}

function layerDependencies(item, sources) {
  const inherited = item?.contextMemorySources === undefined ? [] : item.contextMemorySources;
  if (!Array.isArray(inherited)) return null;
  return normalizeMemoryDependencies([...inherited, ...sources.filter(source => source.kind === "note")]);
}

export function resolveContextLimits(mode = "group-at", overrides = {}) {
  const base = MODE_LIMITS[mode] || MODE_LIMITS["group-at"];
  return { maxChars: positiveInt(overrides.maxChars, base.maxChars),
    maxMessages: Math.min(MAX_LAYERS, positiveInt(overrides.maxMessages, base.maxMessages)),
    maxMessageChars: positiveInt(overrides.maxMessageChars, base.maxMessageChars) };
}

function clipUnframedText(content, maxLength) {
  if (maxLength <= 0) return "";
  if (content.length <= maxLength) return content;
  if (maxLength < 40) return content.slice(0, maxLength);
  const firstBreak = content.indexOf("\n");
  const header = firstBreak > 0 ? content.slice(0, Math.min(firstBreak, 80)) : "";
  if (!header || header.length + 8 >= maxLength) return content.slice(0, maxLength - 1).trimEnd() + "…";
  return header + "\n…\n" + content.slice(-(maxLength - header.length - 5)).trimStart();
}

function positiveInt(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}
function budgetError(code) { return Object.assign(new Error(code), { code }); }
