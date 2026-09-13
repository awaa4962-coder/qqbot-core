import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { URL } from "node:url";
import { assertPatchedDependencies, checkDependencySecurity } from "../scripts/check-dependency-security.mjs";

const patched = {
  sharpVersion: "0.35.4", lockedSharpVersion: "0.35.4", heifVersion: "1.23.2",
  heifEnabled: true, lockedYamlVersion: "4.3.2", yamlVersion: "4.3.2",
};

test("installed image libraries satisfy the security floor and dependency lock", () => {
  assert.ok(checkDependencySecurity());
});

test("dependency guard permits production images without development-only YAML", () => {
  assert.equal(assertPatchedDependencies({ ...patched, yamlVersion: null }).yamlVersion, null);
});

test("dependency guard rejects old sharp even when the lock matches", () => {
  assert.throws(() => assertPatchedDependencies({ ...patched, sharpVersion: "0.35.3", lockedSharpVersion: "0.35.3" }), /sharp.*security minimum/);
});

test("dependency guard rejects an old native decoder behind patched sharp", () => {
  assert.throws(() => assertPatchedDependencies({ ...patched, heifVersion: "1.23.1" }), /libheif.*security minimum/);
  assert.throws(() => assertPatchedDependencies({ ...patched, heifVersion: null }), /libheif.*unknown/);
});

test("dependency guard rejects stale overlays and outdated YAML locks", () => {
  assert.throws(() => assertPatchedDependencies({ ...patched, lockedSharpVersion: "0.35.5" }), /rebuild dependencies/);
  assert.throws(() => assertPatchedDependencies({ ...patched, lockedYamlVersion: "4.3.1" }), /js-yaml lock.*security minimum/);
  assert.throws(() => assertPatchedDependencies({ ...patched, yamlVersion: "4.3.1" }), /js-yaml.*security minimum/);
});

test("dependency guard accepts newer release versions without lexical comparison errors", () => {
  assert.ok(assertPatchedDependencies({ ...patched, sharpVersion: "0.35.10", lockedSharpVersion: "0.35.10", heifVersion: "1.24.0" }));
  assert.throws(() => assertPatchedDependencies({ ...patched, heifVersion: "1.9.9" }), /security minimum/);
  assert.throws(() => assertPatchedDependencies({ ...patched, heifVersion: "1.23.2-rc1" }), /unknown/);
});

test("all Linux image recipes verify the actual image dependencies", () => {
  for (const name of ["Dockerfile", "Dockerfile.overlay", "Dockerfile.dependencies"]) {
    const source = fs.readFileSync(new URL(`../deploy/linux/${name}`, import.meta.url), "utf8");
    assert.match(source, /RUN node scripts\/check-dependency-security\.mjs/);
  }
});

test("dependency refresh rebuilds npm packages while preserving the accepted Python runtime", () => {
  const source = fs.readFileSync(new URL("../deploy/linux/Dockerfile.dependencies", import.meta.url), "utf8");
  assert.match(source, /COPY --chown=node:node package\.json package-lock\.json[\s\S]*RUN npm ci --omit=dev/);
  assert.match(source, /chmod 0755 "\$SEVEN_ZIP_PATH"/);
  assert.doesNotMatch(source, /pip install|apt-get|USER root\s*$/);
  assert.match(source, /USER node\s+RUN node scripts\/check-dependency-security\.mjs\s*$/);
});

test("image manifests remain readable and validation runs as the real non-root user", () => {
  for (const name of ["Dockerfile", "Dockerfile.overlay", "Dockerfile.dependencies"]) {
    const source = fs.readFileSync(new URL(`../deploy/linux/${name}`, import.meta.url), "utf8");
    assert.match(source, /COPY --chown=node:node package\.json package-lock\.json/);
    assert.match(source, /USER node\s+RUN node scripts\/check-dependency-security\.mjs/);
  }
});
