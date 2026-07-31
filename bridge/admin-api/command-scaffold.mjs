// bridge/admin-api/command-scaffold.mjs - safe command scaffold preview/write facade.

import { scaffoldCommand } from "../../scripts/scaffold-command.mjs";

export function buildCommandScaffold(payload = {}, context = {}) {
  const options = normalizeCommandScaffoldPayload(payload, context);
  const result = scaffoldCommand(options);
  return {
    schemaVersion: 1,
    ...result,
    nextSteps: [
      "Review generated files.",
      "Add manifestSnippet to bridge/commands/manifest.mjs.",
      "Wire the module into the command dispatcher.",
      "Run npm run lint and npm test.",
    ],
    safety: [
      "Only kebab-case command ids are accepted.",
      "Existing files are never overwritten.",
      "The API does not edit model calls, storage, auth helpers or reply main flow.",
    ],
  };
}

export function normalizeCommandScaffoldPayload(payload = {}, context = {}) {
  return {
    root: context.root,
    id: payload.id,
    permission: payload.permission || "user",
    aliases: normalizeAliases(payload.aliases),
    helpLine: payload.helpLine || "",
    write: payload.write === true,
  };
}

function normalizeAliases(value) {
  if (Array.isArray(value)) return value.map(item => String(item).trim()).filter(Boolean);
  if (typeof value === "string") {
    return value.split(",").map(item => item.trim()).filter(Boolean);
  }
  return [];
}
