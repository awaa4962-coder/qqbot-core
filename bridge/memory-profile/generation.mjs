const generations = new Map();

export function getUserMemoryGeneration(uid) {
  return generations.get(String(uid || "")) || 0;
}

export function invalidateUserMemoryGeneration(uid) {
  const id = String(uid || "");
  if (id) generations.set(id, getUserMemoryGeneration(id) + 1);
}
