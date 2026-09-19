// bridge/admin-api/config-editor.mjs - safe editable config surface for the local console.

import fs from "node:fs";
import path from "node:path";
import { CFG, LONG_GROUPS } from "../config.mjs";

const EDITABLE_FILES = Object.freeze({
  botNames: { file: ".env_bot_names", env: "QQBOT_NAMES" },
  groupWhitelist: { file: ".env_groups", env: "QQBOT_GROUPS" },
  summaryGroupWhitelist: { file: ".env_summary_groups", env: "QQBOT_SUMMARY_GROUPS" },
  resourceGroupWhitelist: { file: ".env_resource_groups", env: "QQBOT_RESOURCE_GROUPS" },
  featureGroupWhitelist: { file: ".env_feature_groups", env: "QQBOT_FEATURE_GROUPS" },
  conversationSummaryGroupWhitelist: { file: ".env_conversation_summary_groups", env: "QQBOT_CONVERSATION_SUMMARY_GROUPS" },
  stickerGroupWhitelist: { file: ".env_sticker_groups", env: "QQBOT_STICKER_GROUPS" },
  longGroups: { file: ".env_long_groups", env: "QQBOT_LONG_GROUPS" },
  friendWhitelist: { file: ".env_friends", env: "QQBOT_FRIENDS" },
  jmUserWhitelist: { file: ".env_jm_users", env: "QQBOT_JM_USERS" },
  botBlacklist: { file: ".env_bot_blacklist", env: "QQBOT_BLACKLIST" },
  adminUins: { file: ".env_admins", env: "QQBOT_ADMINS" },
});

const NUMBER_LIST_FIELDS = new Set([
  "groupWhitelist",
  "summaryGroupWhitelist",
  "resourceGroupWhitelist",
  "featureGroupWhitelist",
  "conversationSummaryGroupWhitelist",
  "stickerGroupWhitelist",
  "longGroups",
  "friendWhitelist",
  "jmUserWhitelist",
  "botBlacklist",
  "adminUins",
]);

export function buildEditableConfigSnapshot(options = {}) {
  const cfg = options.cfg || CFG;
  const longGroups = options.longGroups || LONG_GROUPS;
  const root = options.root || CFG.configRoot;
  const env = options.env || process.env;
  const effective = Object.fromEntries(Object.keys(EDITABLE_FILES).map(field => [field,
    [...(field === "longGroups" ? longGroups : cfg[field] || [])],
  ]));
  const editable = {};
  const files = {};
  for (const [field, definition] of Object.entries(EDITABLE_FILES)) {
    const { file, env: envName } = definition;
    const environmentControlled = Object.hasOwn(env, envName);
    const stored = environmentControlled ? null : readSavedList(root, file, field);
    editable[field] = environmentControlled ? parseEnvironmentList(env[envName], field, cfg) : stored ?? [...effective[field]];
    const exists = environmentControlled ? fs.existsSync(path.join(root, file)) : stored !== null;
    files[field] = {
      file,
      exists,
      source: environmentControlled ? "environment" : exists ? "sidecar-file" : "runtime-default",
      status: environmentControlled ? "environment-override" : exists ? "editable" : "editable-create-on-save",
      writable: !environmentControlled,
      envName,
      pendingRestart: !sameList(editable[field], effective[field]),
    };
  }
  return {
    editable,
    effective,
    files,
    pendingRestart: Object.values(files).some(file => file.pendingRestart),
    fileStatusLegend: {
      "editable": "The sidecar file exists and can be overwritten by save.",
      "editable-create-on-save": "The current value is active; saving will create the sidecar file.",
      "environment-override": "An environment variable controls this field; change the deployment environment instead.",
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
  const root = options.root || CFG.configRoot;
  const normalized = normalizeEditablePayload(payload);
  const env = options.env || process.env;
  // Validate all environment-owned fields before writing any sidecar.
  for (const [field, values] of Object.entries(normalized)) {
    const envName = EDITABLE_FILES[field].env;
    if (!Object.hasOwn(env, envName)) continue;
    if (!sameList(values, parseEnvironmentList(env[envName], field, options.cfg || CFG))) {
      throw new Error(field + " is controlled by environment variable " + envName);
    }
    delete normalized[field];
  }
  const saved = [];
  fs.mkdirSync(root, { recursive: true });

  for (const [field, values] of Object.entries(normalized)) {
    const file = EDITABLE_FILES[field]?.file;
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

function readSavedList(root, file, field) {
  try {
    return parseConfigList(fs.readFileSync(path.join(root, file), "utf8"), field);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw new Error("cannot read config list " + file + " (" + (error.code || "read_error") + ")");
  }
}

function parseConfigList(value, field) {
  const values = normalizeRawList(value);
  if (!NUMBER_LIST_FIELDS.has(field) || field === "adminUins") return values;
  const numbers = values.map(Number).filter(number => Number.isSafeInteger(number) && number > 0);
  return field === "longGroups" ? numbers.map(String) : numbers;
}

function parseEnvironmentList(value, field, cfg) {
  const values = parseConfigList(value, field);
  return field === "botNames" && !values.length ? [...cfg.botNames] : values;
}

function sameList(left, right) {
  const leftValues = [...new Set(left.map(String))];
  const rightValues = [...new Set(right.map(String))];
  return leftValues.length === rightValues.length && leftValues.every((value, index) => value === rightValues[index]);
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
