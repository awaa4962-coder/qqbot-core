const DEFAULT_LIMITS = Object.freeze({ global: 32, group: 4, speaker: 2,
  passiveGlobal: 8, passiveGroup: 1, previewGlobal: 8, previewGroup: 1 });

export function createChatWorkScheduler(options = {}) {
  const limits = { ...DEFAULT_LIMITS, ...options.limits };
  const active = new Set();
  const groups = new Map();
  const speakers = new Map();
  const passive = new Set();
  const passiveGroups = new Map();
  const previews = new Set();
  const previewGroups = new Map();
  let stopping = false;

  function hasCapacity(group, speaker, kind) {
    return active.size < limits.global && (groups.get(group) || 0) < limits.group &&
      (speakers.get(speaker) || 0) < limits.speaker &&
      (kind !== "interjection" || (passive.size < limits.passiveGlobal &&
        (passiveGroups.get(group) || 0) < limits.passiveGroup)) &&
      (kind !== "preview" || (previews.size < limits.previewGlobal &&
        (previewGroups.get(group) || 0) < limits.previewGroup));
  }

  function start(scope, work) {
    if (stopping) return { ok: false, reason: "bridge_stopping" };
    const group = String(scope.groupId || "");
    const speaker = group + ":" + String(scope.userId || "");
    const isPassive = scope.kind === "interjection";
    const isPreview = scope.kind === "preview";
    if (!hasCapacity(group, speaker, scope.kind)) return { ok: false, reason: "reply_capacity" };
    count(groups, group, 1);
    count(speakers, speaker, 1);
    if (isPassive) count(passiveGroups, group, 1);
    if (isPreview) count(previewGroups, group, 1);
    let fulfill;
    let fail;
    const task = new Promise((resolve, reject) => { fulfill = resolve; fail = reject; });
    active.add(task);
    if (isPassive) passive.add(task);
    if (isPreview) previews.add(task);
    try { Promise.resolve(work()).then(fulfill, fail); }
    catch (error) { fail(error); }
    task.finally(() => {
      active.delete(task);
      count(groups, group, -1);
      count(speakers, speaker, -1);
      if (isPassive) { passive.delete(task); count(passiveGroups, group, -1); }
      if (isPreview) { previews.delete(task); count(previewGroups, group, -1); }
    }).catch(() => {});
    task.catch(() => {});
    return { ok: true, completion: task };
  }

  async function stop(settings = {}) {
    stopping = true;
    const drainMs = Math.max(0, Number(settings.drainMs ?? 10000));
    if (!active.size || !drainMs) return active.size === 0;
    let timer;
    await Promise.race([
      Promise.allSettled([...active]),
      new Promise(resolve => { timer = setTimeout(resolve, drainMs); }),
    ]);
    clearTimeout(timer);
    return active.size === 0;
  }

  return { start, stop, status: () => ({ active: active.size, groups: groups.size,
    passiveActive: passive.size, previewActive: previews.size, maxActive: limits.global, maxPerGroup: limits.group,
    maxPerSpeaker: limits.speaker, maxPassive: limits.passiveGlobal,
    maxPassivePerGroup: limits.passiveGroup, maxPreviews: limits.previewGlobal,
    maxPreviewsPerGroup: limits.previewGroup, stopping }) };
}

function count(map, key, delta) {
  const next = (map.get(key) || 0) + delta;
  if (next > 0) map.set(key, next);
  else map.delete(key);
}

export const chatWorkScheduler = createChatWorkScheduler();
