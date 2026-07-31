import fs from "node:fs";
import { CFG } from "../config.mjs";

export function getLatestChangelog() {
  try {
    const cl = fs.readFileSync(CFG.changelogFile, "utf-8");
    const lines = cl.split("\n");
    const block = [];
    let found = false;
    for (const line of lines) {
      if (!found && line.startsWith("## ")) {
        found = true;
        block.push(line);
        continue;
      }
      if (found && line.startsWith("## ")) break;
      if (found) block.push(line);
    }
    return block.join("\n").trim() || cl.slice(0, 500);
  } catch {
    return "更新日志暂无";
  }
}
