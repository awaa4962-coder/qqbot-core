// bridge/admin-api/backup-manager.mjs - safe non-secret backup snapshots.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SAFE_FILES = [
  ".env.example",
  "package.json",
  "package-lock.json",
  "README.md",
  "CHANGELOG.md",
  "WORKFLOW.md",
  "TOOLS.md",
  "HEARTBEAT.md",
  ".qqfriend/index.json",
  ".qqfriend/architecture.json",
  ".qqfriend/modules.json",
  ".qqfriend/commands.json",
  ".qqfriend/workflows.json",
  ".qqfriend/diagnostics.json",
];

const EXCLUDED_PATTERNS = [
  ".env_*",
  ".env",
  "logs/",
  "memory/",
  "group_chats.json",
  "user_memory.json",
  "napcat_inbox.json",
  "DREAMS.md",
  "SOUL.md",
  "IDENTITY.md",
  "USER.md",
  "*.docx",
  "*.log",
  "*.tmp",
];

export function listSafeBackups(root = ROOT) {
  const backupRoot = path.join(root, "dist", "admin-backups");
  if (!fs.existsSync(backupRoot)) return { schemaVersion: 1, backups: [] };

  const backups = fs.readdirSync(backupRoot, { withFileTypes: true })
    .filter(item => item.isDirectory())
    .map(item => readBackupSummary(path.join(backupRoot, item.name), item.name))
    .filter(Boolean)
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));

  return { schemaVersion: 1, backups };
}

export function createSafeBackup(options = {}) {
  const root = options.root || ROOT;
  const createdAt = new Date(options.now || Date.now()).toISOString();
  const name = options.name ? normalizeBackupName(options.name) : "safe-" + createdAt.replace(/[-:.TZ]/g, "").slice(0, 14);
  const backupDir = path.join(root, "dist", "admin-backups", name);
  const included = [];
  const skipped = [];

  if (fs.existsSync(backupDir)) throw new Error("backup already exists: " + name);
  fs.mkdirSync(backupDir, { recursive: true });

  for (const relative of SAFE_FILES) {
    const source = path.join(root, relative);
    if (!fs.existsSync(source)) {
      skipped.push(relative);
      continue;
    }
    const target = path.join(backupDir, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(source, target);
    included.push(toPosix(relative));
  }

  const manifest = {
    schemaVersion: 1,
    name,
    createdAt,
    mode: "safe-non-secret",
    included,
    skipped,
    excludedPatterns: EXCLUDED_PATTERNS,
    restore: buildRestorePlanFromIncluded(name, included),
  };
  fs.writeFileSync(path.join(backupDir, "backup-manifest.json"), JSON.stringify(manifest, null, 2) + "\n", "utf8");
  return manifest;
}

export function buildBackupRestorePlan(options = {}) {
  const root = options.root || ROOT;
  const name = normalizeBackupName(options.name || "");
  const manifestPath = path.join(root, "dist", "admin-backups", name, "backup-manifest.json");
  if (!fs.existsSync(manifestPath)) throw new Error("backup not found: " + name);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  return {
    schemaVersion: 1,
    name,
    dryRun: true,
    executable: false,
    reason: "Restore is intentionally manual until overwrite review and rollback are implemented.",
    restore: buildRestorePlanFromIncluded(name, manifest.included || []),
  };
}

function readBackupSummary(backupDir, name) {
  const manifestPath = path.join(backupDir, "backup-manifest.json");
  if (!fs.existsSync(manifestPath)) return null;
  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    return {
      name,
      createdAt: manifest.createdAt,
      mode: manifest.mode,
      files: Array.isArray(manifest.included) ? manifest.included.length : 0,
    };
  } catch {
    return null;
  }
}

function buildRestorePlanFromIncluded(name, included) {
  return {
    backup: name,
    manualSteps: [
      "Stop Bridge from the launcher.",
      "Review backup-manifest.json and included files.",
      "Copy selected files back manually only after confirming they do not overwrite newer work.",
      "Restart Bridge and run /health.",
    ],
    files: included.map(file => ({ source: `dist/admin-backups/${name}/${file}`, target: file })),
  };
}

function normalizeBackupName(value) {
  const name = String(value || "").trim();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{2,80}$/.test(name)) {
    throw new Error("backup name must be 3-81 safe filename characters");
  }
  return name;
}

function toPosix(value) {
  return value.replace(/\\/g, "/");
}
