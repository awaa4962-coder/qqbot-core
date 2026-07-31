// bridge/admin-api/plugin-catalog.mjs - plugin-center skeleton built from module metadata.

import { buildModuleCatalog } from "./module-catalog.mjs";

export function buildPluginCatalog(options = {}) {
  const modules = buildModuleCatalog(options).modules;
  const plugins = modules.map(module => ({
    id: module.id,
    name: module.name,
    category: module.category,
    status: module.enabled ? "builtin-enabled" : "builtin-disabled",
    source: "builtin-module",
    riskLevel: module.riskLevel,
    entrypoints: module.entrypoints,
    commands: module.commands,
    diagnostics: module.diagnostics,
    tests: module.tests,
    privacy: module.privacy,
    actions: {
      canEnable: false,
      canDisable: false,
      canInstall: false,
      canUninstall: false,
      canDiagnose: module.diagnostics.length > 0,
    },
  }));

  return {
    schemaVersion: 1,
    mode: "readonly-skeleton",
    count: plugins.length,
    plugins,
    notes: [
      "Current plugin center is a readonly inventory over built-in modules.",
      "Enable/disable/install/uninstall are intentionally disabled until module lifecycle isolation exists.",
    ],
  };
}
