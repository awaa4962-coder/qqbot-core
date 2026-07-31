// bridge/admin-api/module-catalog.mjs - safe module catalog for local console.

import { CFG, LONG_GROUPS } from "../config.mjs";
import { MODULE_DEFINITIONS } from "../modules/manifest.mjs";

export function buildModuleCatalog(options = {}) {
  const cfg = options.cfg || CFG;
  const longGroups = options.longGroups || LONG_GROUPS;
  const modules = MODULE_DEFINITIONS.map(module => buildModuleView(module, cfg, longGroups));
  return {
    count: modules.length,
    modules,
  };
}

function buildModuleView(module, cfg, longGroups) {
  return {
    id: module.id,
    name: module.name,
    category: module.category,
    enabled: Boolean(module.enabled),
    riskLevel: module.riskLevel,
    entrypoints: [...module.entrypoints],
    commands: [...module.commands],
    config: buildModuleConfigSummary(module, cfg, longGroups),
    editableConfigFields: [...module.editableConfigFields],
    healthChecks: [...module.healthChecks],
    diagnostics: [...module.diagnostics],
    tests: [...module.tests],
    privacy: module.privacy,
  };
}

function buildModuleConfigSummary(module, cfg, longGroups) {
  const summary = {};
  for (const field of module.configFields) {
    summary[field] = configFieldSummary(field, cfg, longGroups);
  }
  return summary;
}

function configFieldSummary(field, cfg, longGroups) {
  if (field === "longGroups") return listSummary(longGroups);
  if (LIST_CONFIG_FIELDS.has(field)) return listSummary(cfg[field]);
  if (BOOLEAN_CONFIG_FIELDS.has(field)) return { enabled: Boolean(cfg[field]) };
  if (field === "resourceMaxBytes") return { bytes: cfg.resourceMaxBytes };
  if (field === "wordcloudMaxMessages") return { messages: cfg.wordcloudMaxMessages };
  if (field === "memeLearningMode") return { mode: cfg.memeLearningMode || "steady" };
  return jmFieldSummary(field, cfg);
}

const LIST_CONFIG_FIELDS = new Set([
  "botNames",
  "adminUins",
  "resourceGroupWhitelist",
  "featureGroupWhitelist",
  "jmUserWhitelist",
  "summaryGroupWhitelist",
]);

const BOOLEAN_CONFIG_FIELDS = new Set([
  "legacyProfileRefreshEnabled",
  "linkPreviewEnabled",
]);

function jmFieldSummary(field, cfg) {
  if (field === "jmTimeoutMs") return { ms: cfg.jmTimeoutMs };
  if (field === "jmDomains") return { count: cfg.jmDomains.length };
  if (field === "jmPython") return { status: cfg.jmPython ? "configured" : "missing" };
  if (field === "jmZipPassword") return { configured: Boolean(cfg.jmZipPassword) };
  if (field === "jmSevenZipPath") return { configured: Boolean(cfg.jmSevenZipPath) };
  return { status: "unknown" };
}

function listSummary(value) {
  const values = Array.isArray(value) ? value : [];
  return { count: values.length, values };
}
