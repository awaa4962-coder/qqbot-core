const generations = new Map();
let privacyGeneration = 0;

export function getMemoryPrivacyGeneration() {
  return privacyGeneration;
}

export function invalidateMemoryPrivacyGeneration() {
  privacyGeneration++;
}

export function getUserMemoryGeneration(uid) {
  return generations.get(String(uid || "")) || 0;
}

export function invalidateUserMemoryGeneration(uid, options = {}) {
  const id = String(uid || "");
  if (id) {
    generations.set(id, getUserMemoryGeneration(id) + 1);
    if (options.privacy !== false) invalidateMemoryPrivacyGeneration();
  }
}
