export function createCandidateQueue(options = {}) {
  const maxSize = Math.max(1, Number(options.maxSize || 50));
  const jobs = [];
  const keys = new Set();
  let running = false;
  let stopped = false;
  const stats = {
    accepted: 0,
    duplicate: 0,
    dropped: 0,
    completed: 0,
    failed: 0,
  };

  function enqueue(key, task) {
    const normalizedKey = String(key || "");
    if (stopped) return { accepted: false, reason: "stopped" };
    if (keys.has(normalizedKey)) {
      stats.duplicate++;
      return { accepted: false, reason: "duplicate" };
    }
    if (jobs.length + (running ? 1 : 0) >= maxSize) {
      stats.dropped++;
      return { accepted: false, reason: "queue_full" };
    }
    jobs.push({ key: normalizedKey, task });
    keys.add(normalizedKey);
    stats.accepted++;
    drain();
    return { accepted: true, reason: "" };
  }

  async function drain() {
    if (running || stopped) return;
    running = true;
    try {
      while (!stopped && jobs.length) {
        const job = jobs.shift();
        try {
          await job.task();
          stats.completed++;
        } catch {
          stats.failed++;
        } finally {
          keys.delete(job.key);
        }
      }
    } finally {
      running = false;
    }
  }

  function stop() {
    stopped = true;
    jobs.length = 0;
    keys.clear();
  }

  function status() {
    return {
      ...stats,
      queued: jobs.length,
      processing: running,
      stopped,
      maxSize,
    };
  }

  return { enqueue, status, stop };
}
