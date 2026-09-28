import { monotonicNow } from "../runtime-clock.mjs";
import { measurePromptComposition } from "../system-prompts/compose.mjs";

const BUDGETS = Object.freeze({
  group_summary: { calls: 2, attempts: 4, durationMs: 240000, requestChars: 80000,
    inputChars: 320000, maxTokens: 8192, completionTokens: 22528, responseBytes: 524288 },
  conversation_summary: { calls: 2, attempts: 4, durationMs: 90000, requestChars: 24000,
    inputChars: 96000, maxTokens: 4096, completionTokens: 16384, responseBytes: 262144 },
});

export function createModelTaskBudget(task, options = {}) {
  const limits = BUDGETS[task];
  if (!limits) throw new Error("unsupported_model_task_budget");
  const now = options.now || monotonicNow;
  const deadline = now() + limits.durationMs;
  const timer = AbortSignal.timeout(limits.durationMs);
  const signal = options.signal ? AbortSignal.any([timer, options.signal]) : timer;
  const state = { calls: 0, transportAttempts: 0, requestedInputChars: 0, requestedCompletionTokens: 0 };

  function assertCurrent() {
    options.assertCurrent?.();
    if (options.signal?.aborted) throw stopped("task_cancelled");
    if (timer.aborted || now() >= deadline) throw stopped("task_deadline");
  }

  function prepare(request) {
    assertCurrent();
    if (state.calls >= limits.calls) throw stopped("task_budget");
    const measured = measurePromptComposition(request.messages, request.tools);
    const chars = String(request.systemPrompt || "").length + measured.inputTextChars + measured.toolSchemaChars;
    const tokens = Number(request.maxTokens);
    if (chars > limits.requestChars) throw stopped("task_input_budget");
    if (!Number.isSafeInteger(tokens) || tokens < 1 || tokens > limits.maxTokens) throw stopped("task_output_budget");
    state.calls++;
    return { ...request, signal,
      timeoutMs: Math.max(1, Math.min(Number(request.timeoutMs) || limits.durationMs, Math.floor(deadline - now()))),
      maxAttempts: Math.max(1, Math.min(2, Number(request.maxAttempts) || 2)),
      maxResponseBytes: Number.isSafeInteger(request.maxResponseBytes) && request.maxResponseBytes > 0
        ? Math.min(request.maxResponseBytes, limits.responseBytes) : limits.responseBytes,
      beforeAttempt: () => reserveAttempt(request.beforeAttempt, chars, tokens),
    };
  }

  function reserveAttempt(prior, chars, tokens) {
    try { assertCurrent(); } catch (error) { return error.code === "MODEL_TASK_BUDGET" ? error.message : "task_cancelled"; }
    const reason = prior?.();
    if (reason) return reason;
    if (state.transportAttempts >= limits.attempts || state.requestedInputChars + chars > limits.inputChars ||
        state.requestedCompletionTokens + tokens > limits.completionTokens) return "task_budget";
    state.transportAttempts++;
    state.requestedInputChars += chars;
    state.requestedCompletionTokens += tokens;
    return "";
  }

  return { prepare, assertCurrent, snapshot: () => ({ ...state }) };
}

function stopped(reason) { return Object.assign(new Error(reason), { code: "MODEL_TASK_BUDGET" }); }
