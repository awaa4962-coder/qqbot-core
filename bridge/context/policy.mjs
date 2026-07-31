export function deriveReplyMode(options = {}) {
  if (options.mode) return options.mode;
  if (options.isPassiveInterjection === true) return "interjection";
  if (String(options.groupId || options.group_id || "") === "private") return "private";
  return "group-at";
}

export function isPassiveMode(mode) {
  return mode === "interjection";
}
