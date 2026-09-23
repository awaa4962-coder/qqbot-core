// A message id cannot override a contradictory status or return code.
export function classifyOneBotReceipt(receipt, options = {}) {
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) return "unknown";
  if (receipt.delivery === "unconfirmed") return "unknown";
  const status = receipt.status;
  const code = returnCode(receipt.retcode);
  if (status === "cancelled") return "cancelled";
  if (status === "unknown" || status === "async" || code === 1) return "unknown";
  if (status !== undefined && !["ok", "failed"].includes(status)) return "unknown";
  if (code === "invalid") return "unknown";
  return classifyFields(status, code, messageIdPresent(receipt), options.allowIdOnly !== false);
}

function classifyFields(status, code, hasId, allowIdOnly) {
  if (status === "failed") return code === 0 || hasId ? "unknown" : "failed";
  if (status === "ok") return code === null || code === 0 ? "sent" : "unknown";
  if (code !== null) return code === 0 ? "sent" : hasId ? "unknown" : "failed";
  return hasId && allowIdOnly ? "sent" : "unknown";
}

function returnCode(value) {
  if (value === undefined) return null;
  if (typeof value !== "number" && typeof value !== "string") return "invalid";
  const text = String(value);
  return /^-?\d+$/.test(text) && Number.isSafeInteger(Number(value)) ? Number(value) : "invalid";
}

function messageIdPresent(receipt) {
  const id = receipt.data?.message_id ?? receipt.message_id;
  return ["number", "string"].includes(typeof id) && /^-?\d+$/.test(String(id));
}

export function isDefiniteOneBotRejection(receipt) {
  return classifyOneBotReceipt(receipt) === "failed";
}

// Read APIs and file uploads need an API envelope, not just a chat message id.
export function isOneBotResponseSuccessful(receipt) {
  return classifyOneBotReceipt(receipt, { allowIdOnly: false }) === "sent";
}
