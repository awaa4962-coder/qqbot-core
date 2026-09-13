import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import sharp from "sharp";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function requireVersion(name, version, minimum) {
  assert.match(String(version || ""), /^\d+\.\d+\.\d+$/, `${name}: unknown release version`);
  const actual = version.split(".").map(Number);
  const expected = minimum.split(".").map(Number);
  const difference = actual.map((part, index) => part - expected[index]).find(value => value !== 0) || 0;
  assert.ok(difference >= 0, `${name} ${version} is below the security minimum ${minimum}`);
}

export function assertPatchedDependencies(state) {
  requireVersion("sharp", state.sharpVersion, "0.35.4");
  assert.equal(state.sharpVersion, state.lockedSharpVersion, "Installed sharp differs from package-lock.json; rebuild dependencies");
  if (state.heifEnabled || state.heifVersion) requireVersion("libheif", state.heifVersion, "1.23.2");
  requireVersion("js-yaml lock", state.lockedYamlVersion, "4.3.2");
  if (state.yamlVersion !== null) {
    requireVersion("js-yaml", state.yamlVersion, "4.3.2");
    assert.equal(state.yamlVersion, state.lockedYamlVersion, "Installed js-yaml differs from package-lock.json");
  }
  return state;
}

export function checkDependencySecurity() {
  const lock = JSON.parse(fs.readFileSync(path.join(ROOT, "package-lock.json"), "utf8"));
  const yamlPath = path.join(ROOT, "node_modules/js-yaml/package.json");
  return assertPatchedDependencies({
    sharpVersion: sharp.versions.sharp,
    lockedSharpVersion: lock.packages["node_modules/sharp"]?.version,
    heifVersion: sharp.versions.heif || null,
    heifEnabled: Boolean(sharp.format.heif?.input?.buffer),
    lockedYamlVersion: lock.packages["node_modules/js-yaml"]?.version,
    yamlVersion: fs.existsSync(yamlPath) ? JSON.parse(fs.readFileSync(yamlPath, "utf8")).version : null,
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { console.log(JSON.stringify({ ok: true, ...checkDependencySecurity() }, null, 2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
