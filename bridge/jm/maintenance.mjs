import fs from "node:fs";
import path from "node:path";
import { CFG } from "../config.mjs";

export const JM_MAINTENANCE_FILE = path.join(CFG.dataRoot, ".qqfriend", "tasks", "jm-maintenance.json");

// The operator creates this only after sealing and draining ingress, and removes it at commit.
export function isJmMaintenanceActive(filename = JM_MAINTENANCE_FILE) {
  try { fs.lstatSync(filename); return true; }
  catch (error) { return error.code !== "ENOENT"; }
}
