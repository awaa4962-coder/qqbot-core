import { redactSensitiveText } from "../privacy.mjs";

const TEXT_FIELDS = new Set([
  "text", "content", "nickname", "nicknames", "alias", "description", "profile", "displayName",
  "userSummary", "assistantSummary", "topic", "topics", "commonTopics", "activeTopics", "recentTopics",
  "dislikes", "replyStyle", "preferredTone", "tone", "interactionStyle", "title",
]);

// Walk text-bearing fields only; IDs, timestamps and attachment URLs are not prose.
export function redactMemoryTextFields(root) {
  let changed = false;
  const seen = new WeakSet();
  function visit(value, field = "") {
    if (!value || typeof value !== "object" || seen.has(value)) return;
    seen.add(value);
    for (const [key, item] of Object.entries(value)) {
      const textField = Array.isArray(value) ? field : key;
      if (typeof item === "string" && TEXT_FIELDS.has(textField)) {
        const clean = redactSensitiveText(item);
        if (clean !== item) { value[key] = clean; changed = true; }
      } else if (item && typeof item === "object") visit(item, textField);
    }
  }
  visit(root);
  return changed;
}
