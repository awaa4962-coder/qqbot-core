export function replyWindow(seed, candidates = [], options = {}) {
  const getMessage = options.getMessage || (item => item);
  const maxAncestors = options.maxAncestors || 4;
  const maxReplies = options.maxReplies || 4;
  const byId = new Map();
  for (const item of candidates) {
    const id = identifier(getMessage(item)?.messageId);
    if (id && !byId.has(id)) byId.set(id, item);
  }
  const ancestors = collectAncestors(seed, byId, getMessage, maxAncestors);
  const replies = collectDirectReplies(candidates, ancestors, getMessage, maxReplies);
  return [...ancestors, ...replies];
}

function collectAncestors(seed, byId, getMessage, limit) {
  const ancestors = [];
  const seen = new Set();
  let current = seed;
  while (current && ancestors.length < limit && !seen.has(current)) {
    ancestors.push(current);
    seen.add(current);
    current = byId.get(identifier(getMessage(current)?.replyToMessageId));
  }
  return ancestors;
}

function collectDirectReplies(candidates, ancestors, getMessage, limit) {
  const ancestorIds = new Set(ancestors.map(item => identifier(getMessage(item)?.messageId)).filter(Boolean));
  const replies = [];
  const replySeen = new Set(ancestors);
  for (let index = candidates.length - 1; index >= 0 && replies.length < limit; index--) {
    const item = candidates[index];
    const parentId = identifier(getMessage(item)?.replyToMessageId);
    if (replySeen.has(item) || !ancestorIds.has(parentId)) continue;
    replySeen.add(item);
    replies.push(item);
  }
  return replies;
}

export function assignContextGroups(layers = []) {
  const groupedLayers = layers.map(layer => {
    const copy = { ...layer };
    if (typeof copy.contextGroup !== "string" || !copy.contextGroup || copy.contextGroup.length > 160) delete copy.contextGroup;
    return copy;
  });
  const parents = layers.map((_, index) => index);
  const sourceLayers = new Map();
  const parentLayers = new Map();
  const explicitGroups = new Map();
  const root = index => {
    while (parents[index] !== index) {
      parents[index] = parents[parents[index]];
      index = parents[index];
    }
    return index;
  };
  const join = (left, right) => {
    const leftRoot = root(left);
    const rightRoot = root(right);
    if (leftRoot !== rightRoot) parents[rightRoot] = leftRoot;
  };

  linkExplicitGroups(layers, explicitGroups, join);
  indexSources(layers, sourceLayers, parentLayers);
  linkSourceMessages(layers, sourceLayers, parentLayers, join);
  markProvidedParents(groupedLayers, parentLayers);
  applyComponentGroups(layers, groupedLayers, root);
  return groupedLayers;
}

function linkExplicitGroups(layers, groups, join) {
  layers.forEach((layer, index) => {
    const group = typeof layer.contextGroup === "string" ? layer.contextGroup : "";
    if (!group) return;
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group).push(index);
  });
  for (const indexes of groups.values()) joinIndexes(indexes, join);
}

export function providesParentText(layer, source) {
  if (source?.kind === "group" || source?.kind === "quote") return true;
  return source?.kind === "memory" && layer.contextOriginalFrame === true;
}

function indexSources(layers, sourceLayers, parentLayers) {
  layers.forEach((layer, index) => {
    for (const source of layer.contextSources || []) {
      const id = identifier(source?.messageId);
      if (!id) continue;
      if (!sourceLayers.has(id)) sourceLayers.set(id, []);
      sourceLayers.get(id).push(index);
      if (providesParentText(layer, source)) {
        if (!parentLayers.has(id)) parentLayers.set(id, []);
        parentLayers.get(id).push(index);
      }
    }
  });
}

function joinIndexes(indexes, join) {
  for (let index = 1; index < indexes.length; index++) join(indexes[0], indexes[index]);
}

function linkSourceMessages(layers, sourceLayers, parentLayers, join) {
  for (const indexes of sourceLayers.values()) joinIndexes(indexes, join);
  layers.forEach((layer, index) => {
    for (const source of layer.contextSources || []) {
      for (const linked of parentLayers.get(identifier(source?.replyToMessageId)) || []) join(index, linked);
    }
  });
}

function markProvidedParents(layers, parentLayers) {
  const availableIds = new Set(parentLayers.keys());
  for (const layer of layers) {
    for (const source of layer.contextSources || []) {
      const parentId = identifier(source?.replyToMessageId);
      if (/^-?\d{1,20}$/.test(parentId) && availableIds.has(parentId)) {
        layer.content = String(layer.content || "").replace("replyToMessageId=本轮未提供", "replyToMessageId=" + parentId);
      }
    }
  }
}

function applyComponentGroups(layers, groupedLayers, root) {
  const components = new Map();
  layers.forEach((_, index) => {
    const key = root(index);
    if (!components.has(key)) components.set(key, []);
    components.get(key).push(index);
  });
  const usedGroups = new Set(layers.map(layer => layer.contextGroup)
    .filter(group => typeof group === "string" && group.length > 0 && group.length <= 160));
  let groupNumber = 0;
  for (const indexes of components.values()) {
    if (indexes.length < 2) continue;
    const explicit = indexes.map(index => layers[index].contextGroup)
      .find(value => typeof value === "string" && value.length > 0 && value.length <= 160);
    let group = explicit;
    while (!group || (usedGroups.has(group) && !explicit)) group = "reply-component-" + (++groupNumber);
    usedGroups.add(group);
    for (const index of indexes) groupedLayers[index].contextGroup = group;
  }
}

function identifier(value) {
  return value === undefined || value === null || value === "" ? "" : String(value);
}
