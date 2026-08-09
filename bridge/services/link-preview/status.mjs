const state = {
  attempts: 0,
  hits: 0,
  misses: 0,
  errors: 0,
  bilibiliHits: 0,
  genericHits: 0,
  skips: 0,
  duplicateSkips: 0,
  lastPreviewAt: "",
  lastError: "",
  lastSkipReason: "",
};

export function recordLinkPreview(kind, result, error = "") {
  state.attempts++;
  state.lastPreviewAt = new Date().toISOString();
  if (error) {
    state.errors++;
    state.lastError = String(error).slice(0, 160);
    return;
  }
  if (!result) {
    state.misses++;
    return;
  }
  state.hits++;
  if (kind === "bilibili") state.bilibiliHits++;
  else state.genericHits++;
}

export function recordLinkPreviewSkip(reason) {
  state.skips++;
  state.lastSkipReason = String(reason || "policy").slice(0, 80);
  if (reason === "duplicate") state.duplicateSkips++;
}

export function getLinkPreviewStatus(options = {}) {
  return {
    enabled: options.enabled !== false,
    attempts: state.attempts,
    hits: state.hits,
    misses: state.misses,
    errors: state.errors,
    bilibiliHits: state.bilibiliHits,
    genericHits: state.genericHits,
    skips: state.skips,
    duplicateSkips: state.duplicateSkips,
    mode: "smart",
    lastPreviewAt: state.lastPreviewAt,
    lastError: state.lastError,
    lastSkipReason: state.lastSkipReason,
  };
}

export function resetLinkPreviewStatus() {
  state.attempts = 0;
  state.hits = 0;
  state.misses = 0;
  state.errors = 0;
  state.bilibiliHits = 0;
  state.genericHits = 0;
  state.skips = 0;
  state.duplicateSkips = 0;
  state.lastPreviewAt = "";
  state.lastError = "";
  state.lastSkipReason = "";
}
