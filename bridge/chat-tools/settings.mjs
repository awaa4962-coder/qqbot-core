import { createHmac, randomBytes } from "node:crypto";
import { CFG } from "../config.mjs";
import { readJsonFile, writeJsonFileSync } from "../persistence/json-file.mjs";
import { resolveToolLimits, TOOL_LIMIT_PROFILES } from "./limits.mjs";

const REVISION_KEY = randomBytes(32);
const SETTINGS_KEYS = new Set(["autonomyEnabled", "profile", "interjectionProfile", "overrides"]);

function failure(code, statusCode = 400) {
  return Object.assign(new Error(code), { code, statusCode });
}

function validateSettings(value) {
  if (!value || ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
      Object.keys(value).some(key => !SETTINGS_KEYS.has(key)) || typeof value.autonomyEnabled !== "boolean" ||
      !Object.hasOwn(TOOL_LIMIT_PROFILES, value.profile) || value.interjectionProfile !== "light") {
    throw failure("tool_settings_invalid");
  }
  const overrides = value.overrides ?? {};
  resolveToolLimits(value.profile, overrides);
  return { autonomyEnabled: value.autonomyEnabled, profile: value.profile,
    interjectionProfile: "light", overrides: { ...overrides } };
}

export function getToolSettingsSnapshot(options = {}) {
  const cfg = options.cfg || CFG;
  const defaults = { autonomyEnabled: cfg.toolAutonomyEnabled === true,
    profile: "standard", interjectionProfile: "light", overrides: {} };
  let saved = null;
  try {
    saved = cfg.toolSettingsFile ? readJsonFile(cfg.toolSettingsFile, null, { maxBytes: 8192 }) : null;
    if (saved !== null && (saved.schema !== 1 || Object.keys(saved).some(key => key !== "schema" && !SETTINGS_KEYS.has(key)))) {
      throw failure("tool_settings_unavailable", 503);
    }
    const settings = validateSettings(saved === null ? defaults : Object.fromEntries(
      Object.entries(saved).filter(([key]) => key !== "schema")));
    const revision = createHmac("sha256", REVISION_KEY).update(JSON.stringify([cfg.toolSettingsFile || "", saved, defaults])).digest("hex");
    return { revision, settings, source: saved === null ? "default" : "saved",
      effective: { chat: resolveToolLimits(settings.profile, settings.overrides), interjection: resolveToolLimits("light") },
      profiles: Object.entries(TOOL_LIMIT_PROFILES).map(([name, limits]) => ({ name, limits: { ...limits } })) };
  } catch { throw failure("tool_settings_unavailable", 503); }
}

export function applyToolSettingsAction(body, options = {}) {
  const cfg = options.cfg || CFG;
  if (!body || body.action !== "save" || Object.keys(body).some(key => !["action", "expectedRevision", "settings"].includes(key))) {
    throw failure("tool_settings_invalid");
  }
  const before = getToolSettingsSnapshot({ cfg });
  if (typeof body.expectedRevision !== "string" || body.expectedRevision !== before.revision) throw failure("tool_settings_conflict", 409);
  if (!cfg.toolSettingsFile) throw failure("tool_settings_unavailable", 503);
  const settings = validateSettings(body.settings);
  if (getToolSettingsSnapshot({ cfg }).revision !== before.revision) throw failure("tool_settings_conflict", 409);
  try { writeJsonFileSync(cfg.toolSettingsFile, { schema: 1, ...settings }, { durable: true, spacing: 2 }); }
  catch { throw failure("tool_settings_save_failed", 503); }
  return { status: "ok", ...getToolSettingsSnapshot({ cfg }) };
}

export function effectiveToolPolicy(cfg, task) {
  const snapshot = getToolSettingsSnapshot({ cfg });
  const passive = task === "interjection";
  return Object.freeze({ autonomy: snapshot.settings.autonomyEnabled, profile: passive ? "light" : snapshot.settings.profile,
    network: !passive && task !== "file_chat", preparations: !passive && task === "group_chat",
    limits: passive ? snapshot.effective.interjection : snapshot.effective.chat, revision: snapshot.revision });
}
