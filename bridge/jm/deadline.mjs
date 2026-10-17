import { monotonicNow } from "../runtime-clock.mjs";

export const JM_HARD_TIMEOUT_MS = 90_000;
export const JM_PROGRESS_DELAY_MS = 60_000;
export const JM_MAX_RESPONSE_MS = 120_000;
export const JM_NOTICE_TIMEOUT_MS = 15_000;
export const JM_ACK_TIMEOUT_MS = 3_000;

const PHASES = new Set(["preparing", "downloading", "packing", "uploading", "cancelling"]);

export function createJmDeadline(options = {}) {
  const now = options.now || monotonicNow;
  const startedAt = Number.isFinite(options.startedAt) ? options.startedAt : now();
  const timeoutMs = boundedDuration(options.timeoutMs, JM_HARD_TIMEOUT_MS);
  const deadlineAt = startedAt + timeoutMs;
  const controller = new AbortController();
  let finished = false, expired = false, progressReported = false;
  const state = { phase: "preparing", completed: 0, total: null, bytes: 0, failed: 0 };
  const externalAbort = () => controller.abort(options.signal.reason);
  if (options.signal?.aborted) externalAbort();
  else options.signal?.addEventListener("abort", externalAbort, { once: true });

  const dispatch = (callback, value) => {
    try { Promise.resolve(callback?.(value)).catch(() => {}); } catch { /* Notifications cannot reopen a job. */ }
  };
  const expire = () => {
    if (finished || controller.signal.aborted) return;
    expired = true;
    const error = Object.assign(new Error("JM deadline exceeded"), { code: "JM_DEADLINE" });
    controller.abort(error);
    dispatch(options.onDeadline, snapshot());
  };
  const deadlineTimer = setTimeout(expire, Math.max(0, deadlineAt - now()));
  deadlineTimer.unref?.();
  const progressDelay = boundedDuration(options.progressDelayMs, JM_PROGRESS_DELAY_MS);
  const progressTimer = setTimeout(() => {
    if (finished || controller.signal.aborted || now() >= deadlineAt || progressReported) return;
    progressReported = true;
    dispatch(options.onProgress, snapshot());
  }, Math.max(0, startedAt + progressDelay - now()));
  progressTimer.unref?.();

  function snapshot() { return { ...state, elapsedMs: Math.max(0, now() - startedAt) }; }
  function check() {
    if (!finished && now() >= deadlineAt) expire();
    controller.signal.throwIfAborted();
  }
  function progress(update = {}) {
    if (finished || controller.signal.aborted) return;
    const changed = PHASES.has(update.phase) && state.phase !== update.phase;
    if (changed) state.phase = update.phase;
    for (const key of ["completed", "total", "bytes", "failed"]) {
      if (key === "total" && update[key] === null) state[key] = null;
      else if (Number.isSafeInteger(update[key]) && update[key] >= 0) state[key] = update[key];
    }
    if (changed) dispatch(options.onPhase, { ...state });
  }
  function finish() {
    if (finished) return;
    finished = true;
    clearTimeout(deadlineTimer);
    clearTimeout(progressTimer);
    options.signal?.removeEventListener("abort", externalAbort);
  }
  return { signal: controller.signal, startedAt, check, progress, snapshot, finish,
    remainingMs: () => Math.max(0, deadlineAt - now()),
    responseRemainingMs: () => Math.max(0, startedAt + JM_MAX_RESPONSE_MS - now()),
    get expired() { return expired; } };
}

export function boundedDuration(value, maximum) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.min(maximum, Math.max(1, Math.trunc(number))) : maximum;
}

export function buildJmProgressText(state) {
  const labels = { preparing: "准备下载", downloading: "下载", packing: "打包", uploading: "上传", cancelling: "停止处理" };
  const count = state.total === null ? String(state.completed) : state.completed + "/" + state.total;
  const size = (state.bytes / 1024 / 1024).toFixed(1);
  return "JM 进度：正在" + (labels[state.phase] || "处理") + "，已有 " + count + " 个文件，约 " + size + " MB。整单最多处理90秒，超时会停止并反馈。";
}
