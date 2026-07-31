import fs from "node:fs";
import path from "node:path";

import { CFG } from "../config.mjs";

export function writeManualSummary(dateText, summary, options = {}) {
  const groupSuffix = options.groupId ? "-" + Number(options.groupId) : "";
  const filePath = path.join(CFG.logDir, "manual-summary-" + dateText + groupSuffix + ".txt");
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, summary, "utf8");
  return filePath;
}
