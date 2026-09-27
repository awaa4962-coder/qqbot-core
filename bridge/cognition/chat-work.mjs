const DEFAULT_LIMITS = Object.freeze({ global: 32, group: 4, speaker: 2,
  passiveGlobal: 8, passiveGroup: 1, previewGlobal: 8, previewGroup: 1,
  commandGlobal: 4, commandGroup: 1 });

export function createChatWorkScheduler(options = {}) {
  const limits = { ...DEFAULT_LIMITS, ...options.limits };
  const active = new Set();
  const groups = new Map();
  const speakers = new Map();
  const categories = new Map([
    ["interjection", { active: new Set(), groups: new Map(), max: limits.passiveGlobal, perGroup: limits.passiveGroup }],
    ["preview", { active: new Set(), groups: new Map(), max: limits.previewGlobal, perGroup: limits.previewGroup }],
    ["command", { active: new Set(), groups: new Map(), max: limits.commandGlobal, perGroup: limits.commandGroup }],
  ]);
  let stopping = false;

  function hasCapacity(group, speaker, category) {
    return active.size < limits.global && (groups.get(group) || 0) < limits.group &&
      (speakers.get(speaker) || 0) < limits.speaker &&
      (!category || (category.active.size < category.max &&
        (category.groups.get(group) || 0) < category.perGroup));
  }

  function start(scope, work) {
    if (stopping) return { ok: false, reason: "bridge_stopping" };
    const group = String(scope.groupId || "");
    const speaker = group + ":" + String(scope.userId || "");
    const category = categories.get(scope.kind);
    if (!hasCapacity(group, speaker, category)) return { ok: false, reason: "reply_capacity" };
    count(groups, group, 1);
    count(speakers, speaker, 1);
    if (category) count(category.groups, group, 1);
    let fulfill;
    let fail;
    const task = new Promise((resolve, reject) => { fulfill = resolve; fail = reject; });
    active.add(task);
    category?.active.add(task);
    try { Promise.resolve(work()).then(fulfill, fail); }
    catch (error) { fail(error); }
    task.finally(() => {
      active.delete(task);
      count(groups, group, -1);
      count(speakers, speaker, -1);
      if (category) { category.active.delete(task); count(category.groups, group, -1); }
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
    passiveActive: categories.get("interjection").active.size, previewActive: categories.get("preview").active.size,
    commandActive: categories.get("command").active.size, maxActive: limits.global, maxPerGroup: limits.group,
    maxPerSpeaker: limits.speaker, maxPassive: limits.passiveGlobal,
    maxPassivePerGroup: limits.passiveGroup, maxPreviews: limits.previewGlobal,
    maxPreviewsPerGroup: limits.previewGroup, maxCommands: limits.commandGlobal,
    maxCommandsPerGroup: limits.commandGroup, stopping }) };
}

function count(map, key, delta) {
  const next = (map.get(key) || 0) + delta;
  if (next > 0) map.set(key, next);
  else map.delete(key);
}

export const chatWorkScheduler = createChatWorkScheduler();
