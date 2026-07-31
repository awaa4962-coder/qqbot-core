import fs from "node:fs";

import { CFG } from "../config.mjs";
import { DEFAULT_SUMMARY_GROUP_ID } from "./constants.mjs";
import { dateRange, formatDate } from "./date.mjs";

export function loadSummaryMessages(dateText = formatDate(), groupId = DEFAULT_SUMMARY_GROUP_ID) {
  const { start, end } = dateRange(dateText);
  const data = JSON.parse(fs.readFileSync(CFG.chatLogFile, "utf8"));
  return (data[String(groupId)] || []).filter(m => Number(m.ts) >= start && Number(m.ts) <= end);
}
