import { DEFAULT_SUMMARY_GROUP_ID } from "./constants.mjs";
import { formatDate } from "./date.mjs";
import { loadSummaryCapture } from "./journal.mjs";

export function loadSummaryMessages(dateText = formatDate(), groupId = DEFAULT_SUMMARY_GROUP_ID) {
  return loadSummaryCapture(dateText, groupId).messages;
}
