const cleaners = new Set();

export function registerAgentOwnedStateCleaner(cleaner) {
  if (typeof cleaner !== "function") throw new TypeError("invalid_agent_state_cleaner");
  cleaners.add(cleaner);
  return () => cleaners.delete(cleaner);
}

export function clearAgentOwnedState(userId, options = {}) {
  let complete = true;
  for (const clean of cleaners) {
    try { if (clean(String(userId), options) !== true) complete = false; }
    catch { complete = false; }
  }
  return complete;
}
