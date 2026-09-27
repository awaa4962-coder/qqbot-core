const DEFAULT_LIMITS = Object.freeze({ global: 32, group: 4, speaker: 2 });

export function createChatWorkScheduler(options = {}) {
  const limits = { ...DEFAULT_LIMITS, ...options.limits };
  const active = new Set();
  const groups = new Map();
  const speakers = new Map();
  let stopping = false;

  function start(scope, work) {
    if (stopping) return { ok: false, reason: "bridge_stopping" };
    const group = String(scope.groupId || "");
    const speaker = group + ":" + String(scope.userId || "");
    if (active.size >= limits.global || (groups.get(group) || 0) >= limits.group ||
        (speakers.get(speaker) || 0) >= limits.speaker) return { ok: false, reason: "reply_capacity" };
    count(groups, group, 1);
    count(speakers, speaker, 1);
    let fulfill;
    let fail;
    const task = new Promise((resolve, reject) => { fulfill = resolve; fail = reject; });
    active.add(task);
    try { Promise.resolve(work()).then(fulfill, fail); }
    catch (error) { fail(error); }
    task.finally(() => {
      active.delete(task);
      count(groups, group, -1);
      count(speakers, speaker, -1);
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
    maxActive: limits.global, maxPerGroup: limits.group, maxPerSpeaker: limits.speaker, stopping }) };
}

function count(map, key, delta) {
  const next = (map.get(key) || 0) + delta;
  if (next > 0) map.set(key, next);
  else map.delete(key);
}

export const chatWorkScheduler = createChatWorkScheduler();
