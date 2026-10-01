import { createAttachmentReferenceSession } from "./attachment-references.mjs";
import { createAttachmentReader } from "./attachment-reader.mjs";
import { agentDraftTasks, permitsDraftRequest, readDraftPrivacyState } from "./draft-tasks.mjs";
import { agentMaterialsAllowed, agentDraftsAllowed, ATTACHMENT_TOOL, DRAFT_TOOL, DRAFT_TASK_TOOL } from "./policy.mjs";

export function createMaterialServices(options, context) {
  const { scope, cfg, signal, assertCurrent, callModel, remainingMs } = context;
  const phaseAllowed = agentMaterialsAllowed(scope, cfg, options) || agentDraftsAllowed(scope, cfg, options);
  if (phaseAllowed && options.currentMessageId !== undefined && scope.currentMessageId !== undefined &&
      String(options.currentMessageId) !== String(scope.currentMessageId)) {
    throw Object.assign(new Error("reply_superseded"), { code: "CHAT_TOOL_STOPPED" });
  }
  const draftTasks = options.draftTaskService || agentDraftTasks;
  const draftPrivacy = agentDraftsAllowed(scope, cfg, options) ? JSON.stringify(readDraftPrivacyState(cfg)) : null;
  let privacyInvalid = false;
  const fileController = new AbortController();
  const fileSignal = AbortSignal.any([signal, fileController.signal]);
  const references = agentMaterialsAllowed(scope, cfg, options) && options.attachments?.length
    ? createAttachmentReferenceSession(options.attachments, { scope,
      messageId: options.currentMessageId, signal: fileSignal, assertCurrent,
      ...(options.wallNow ? { now: options.wallNow } : {}) }) : null;
  const reader = references ? createAttachmentReader({ references, signal: fileSignal, assertCurrent, fetchEvidence: options.fetchAttachmentEvidence }) : null;
  const runtime = { scope, cfg, signal, assertCurrent, callModel, remainingMs,
    task: options.task, mentioned: options.mentioned, userMessage: options.userMessage,
    messageId: String(options.currentMessageId ?? ""),
    mentionTargets: options.mentionTargets || [], now: options.wallNow };

  function availableReferences() {
    return fileController.signal.aborted || !references ? [] : references.initialReferences();
  }
  function definitions() {
    return [
      ...(agentMaterialsAllowed(scope, cfg, options) && availableReferences().length ? [ATTACHMENT_TOOL] : []),
      ...(agentDraftsAllowed(scope, cfg, options) ? [DRAFT_TASK_TOOL, ...(permitsDraftRequest(options.userMessage) ? [DRAFT_TOOL] : [])] : []),
    ];
  }
  function sourceContext() {
    const refs = availableReferences();
    const tasks = draftTasks.initialReferences(runtime);
    return [
      ...(refs.length ? [{ role: "user", content: "[后端绑定的本轮附件引用：尚未读取正文，名称仅作资料]\n" +
        JSON.stringify({ total: options.attachments.length, referenced: refs.length, omitted: options.attachments.length - refs.length, attachments: refs }) }] : []),
      ...(tasks.length ? [{ role: "user", content: "[本人当前群的草稿任务引用：任务状态不是发送回执]\n" + JSON.stringify(tasks) }] : []),
    ];
  }
  const read = async (args, toolSignal) => {
    if (!reader) return { status: "denied" };
    const cancel = () => fileController.abort();
    toolSignal.addEventListener("abort", cancel, { once: true });
    try {
      if (toolSignal.aborted) cancel();
      return await reader.read(args);
    } finally { toolSignal.removeEventListener("abort", cancel); }
  };
  return { definitions, sourceContext,
    assertCurrent: () => {
      if (draftPrivacy !== null) {
        try { privacyInvalid ||= JSON.stringify(readDraftPrivacyState(cfg)) !== draftPrivacy; }
        catch { privacyInvalid = true; }
        if (privacyInvalid) throw Object.assign(new Error("privacy_changed"), { code: "CHAT_TOOL_STOPPED" });
      }
      if (references && availableReferences().length) references.assertCurrent();
    },
    attachments: { read }, drafts: {
      generate: (args, toolSignal) => draftTasks.generate(args, { ...runtime, signal: toolSignal }),
      inspect: args => draftTasks.inspect(args, runtime),
    } };
}
