export function isSuccessfulOutbound(result) {
  if (Array.isArray(result)) {
    return result.length > 0 && result.every(isSuccessfulOutbound);
  }
  if (!result || typeof result !== "object") return false;
  if (result.status === "ok") return true;
  if (Number(result.retcode) === 0) return true;
  return Boolean(result.data?.message_id || result.message_id);
}
