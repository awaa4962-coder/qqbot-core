import { agentWriteCoordinator } from "./write-coordinator.mjs";
import { autonomousPreparationAllowed } from "./preparation-policy.mjs";
import { agentPersonalAllowed, agentRemindersAllowed, permitsReminderPreparation, authorizedReminderArguments, PERSONAL_CHANGE_TOOL, REMINDER_TOOL, PERSONAL_ACTIONS_TOOL } from "./policy.mjs";

export function createWriteServices(options, context) {
  const { scope, cfg, signal, assertCurrent } = context;
  const autonomous = context.autonomous === true;
  const coordinator = options.writeCoordinator || agentWriteCoordinator;
  const personal = () => agentPersonalAllowed(scope, cfg, options);
  const reminders = () => agentRemindersAllowed(scope, cfg, options);
  const messageId = String(options.currentMessageId ?? "");
  if ((personal() || reminders()) && scope.currentMessageId !== undefined && messageId !== String(scope.currentMessageId)) {
    throw Object.assign(new Error("reply_superseded"), { code: "CHAT_TOOL_STOPPED" });
  }
  const runtime = { scope, cfg, signal, assertCurrent, messageId, userMessage: options.userMessage,
    task: options.task, mentioned: options.mentioned, autonomous };
  return { definitions: () => [
    ...(personal() && (autonomous || permitsPersonalPreparation(options.userMessage)) ? [PERSONAL_CHANGE_TOOL] : []),
    ...(reminders() && (autonomous || permitsReminderPreparation(options.userMessage)) ? [REMINDER_TOOL] : []),
    ...(personal() || reminders() ? [PERSONAL_ACTIONS_TOOL] : []),
  ],
  writes: {
    preparePersonal: args => personal() && (autonomous ? autonomousPreparationAllowed(options.userMessage, "personal")
      : permitsPersonalPreparation(options.userMessage)) ? coordinator.preparePersonal(args, runtime) : { status: "denied" },
    prepareReminder: args => reminders() && (autonomous ? autonomousPreparationAllowed(options.userMessage, "reminder", args)
      : authorizedReminderArguments(args, options.userMessage)) ? coordinator.prepareReminder(args, runtime) : { status: "denied" },
    read: args => coordinator.read(args, runtime),
  } };
}

function currentRequest(text) {
  return typeof text === "string" ? text.normalize("NFKC").replace(/\p{Cf}/gu, "") : "";
}

export function permitsPersonalPreparation(message) {
  const text = currentRequest(message);
  return /记住|记一下|记下来|保存.{0,8}记忆|修改.{0,8}记忆|纠正.{0,8}记忆|删除.{0,8}记忆|叫我|称呼|回复风格|说话风格/.test(text) &&
    !/(?:不要|不用|别|禁止|取消|不必).{0,8}(?:记住|保存|修改|纠正|删除|叫我|称呼|风格)/.test(text);
}

export { permitsReminderPreparation } from "./policy.mjs";
