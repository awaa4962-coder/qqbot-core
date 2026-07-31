// bridge/admin-api/config-editor.mjs - safe editable config surface for the local console.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CFG, LONG_GROUPS } from "../config.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

const EDITABLE_FILES = Object.freeze({
  botNames: ".env_bot_names",
  groupWhitelist: ".env_groups",
  summaryGroupWhitelist: ".env_summary_groups",
  resourceGroupWhitelist: ".env_resource_groups",
  featureGroupWhitelist: ".env_feature_groups",
  longGroups: ".env_long_groups",
  friendWhitelist: ".env_friends",
  jmUserWhitelist: ".env_jm_users",
  botBlacklist: ".env_bot_blacklist",
  adminUins: ".env_admins",
});

const NUMBER_LIST_FIELDS = new Set([
  "groupWhitelist",
  "summaryGroupWhitelist",
  "resourceGroupWhitelist",
  "featureGroupWhitelist",
  "longGroups",
  "friendWhitelist",
  "jmUserWhitelist",
  "botBlacklist",
  "adminUins",
]);

export function buildEditableConfigSnapshot(options = {}) {
  const cfg = options.cfg || CFG;
  const longGroups = options.longGroups || LONG_GROUPS;
  const root = options.root || ROOT;
  return {
    editable: {
      botNames: [...cfg.botNames],
      groupWhitelist: [...cfg.groupWhitelist],
      summaryGroupWhitelist: [...cfg.summaryGroupWhitelist],
      resourceGroupWhitelist: [...cfg.resourceGroupWhitelist],
      featureGroupWhitelist: [...cfg.featureGroupWhitelist],
      longGroups: [...longGroups].map(String),
      friendWhitelist: [...cfg.friendWhitelist],
      jmUserWhitelist: [...cfg.jmUserWhitelist],
      botBlacklist: [...cfg.botBlacklist],
      adminUins: [...cfg.adminUins],
    },
    files: Object.fromEntries(Object.entries(EDITABLE_FILES).map(([key, file]) => {
      const exists = fs.existsSync(path.join(root, file));
      return [
        key,
        {
          file,
          exists,
          source: exists ? "sidecar-file" : "runtime-default-or-env",
          status: exists ? "editable" : "editable-create-on-save",
          writable: true,
        },
      ];
    })),
    fileStatusLegend: {
      "editable": "The sidecar file exists and can be overwritten by save.",
      "editable-create-on-save": "The current value is active; saving will create the sidecar file.",
    },
    restartRequiredAfterSave: true,
    unsafeFieldsExcluded: [
      "mimoKey",
      "dsKey",
      "tavilyKey",
      "doubaoKey",
      "napcatApi",
      "listenPort",
      "selfUin",
    ],
  };
}

export function saveEditableConfig(payload, options = {}) {
  const root = options.root || ROOT;
  const normalized = normalizeEditablePayload(payload);
  const saved = [];
  fs.mkdirSync(root, { recursive: true });

  for (const [field, values] of Object.entries(normalized)) {
    const file = EDITABLE_FILES[field];
    if (!file) continue;
    writeListFile(path.join(root, file), values);
    saved.push({ field, file, count: values.length });
  }

  return {
    ok: true,
    saved,
    restartRequired: saved.length > 0,
  };
}

export function normalizeEditablePayload(payload) {
  const source = payload && typeof payload === "object" && !Array.isArray(payload)
    ? (payload.editable && typeof payload.editable === "object" ? payload.editable : payload)
    : {};
  const normalized = {};

  rejectUnknownEditableFields(source);
  for (const field of Object.keys(EDITABLE_FILES)) {
    if (!Object.prototype.hasOwnProperty.call(source, field)) continue;
    normalized[field] = NUMBER_LIST_FIELDS.has(field)
      ? normalizeNumberList(source[field], field)
      : normalizeNameList(source[field], field);
  }
  return normalized;
}

function rejectUnknownEditableFields(source) {
  const unknown = Object.keys(source).filter(field => !Object.prototype.hasOwnProperty.call(EDITABLE_FILES, field));
  if (unknown.length) {
    throw new Error("unsupported config field: " + unknown.join(", "));
  }
}

function normalizeNameList(value, field) {
  const items = normalizeRawList(value);
  const names = [];
  for (const item of items) {
    const name = String(item).trim();
    if (!name || name.length > 32 || /[\r\n\t]/.test(name)) {
      throw new Error("invalid " + field + " item");
    }
    if (!names.includes(name)) names.push(name);
  }
  if (!names.length) throw new Error(field + " cannot be empty");
  if (names.length > 20) throw new Error(field + " has too many items");
  return names;
}

function normalizeNumberList(value, field) {
  const items = normalizeRawList(value);
  const numbers = [];
  for (const item of items) {
    const text = String(item).trim();
    if (!/^\d{5,15}$/.test(text)) throw new Error("invalid " + field + " item");
    const num = Number(text);
    if (!Number.isSafeInteger(num) || num <= 0) throw new Error("invalid " + field + " item");
    if (!numbers.includes(num)) numbers.push(num);
  }
  if (numbers.length > 200) throw new Error(field + " has too many items");
  return numbers.map(String);
}

function normalizeRawList(value) {
  if (Array.isArray(value)) return value;
  return String(value || "")
    .split(/[\s,;]+/)
    .map(item => item.trim())
    .filter(Boolean);
}

function writeListFile(filePath, values) {
  const tmp = filePath + ".tmp";
  fs.writeFileSync(tmp, values.join("\n") + (values.length ? "\n" : ""), "utf8");
  fs.renameSync(tmp, filePath);
}
