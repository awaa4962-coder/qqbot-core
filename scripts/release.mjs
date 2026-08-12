import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIST_DIR = "dist";
const DEV_TOOLS = ["debug_bridge.mjs", "search_comp.mjs", "test_server.mjs"];
const PUBLIC_QQFRIEND_FILES = new Set([
  ".qqfriend/architecture.json",
  ".qqfriend/commands.json",
  ".qqfriend/diagnostics.json",
  ".qqfriend/index.json",
  ".qqfriend/modules.json",
  ".qqfriend/workflows.json",
]);
const RELEASE_ROOTS = [
  "bridge",
  ...PUBLIC_QQFRIEND_FILES,
  "test",
  "scripts",
  ".github/workflows/ci.yml",
  "napcat_bridge.mjs",
  "start_bridge.bat",
  "package.json",
  "package-lock.json",
  "eslint.config.mjs",
  ".env.example",
  "README.md",
  "CHANGELOG.md",
  "WORKFLOW.md",
  "TOOLS.md",
  "HEARTBEAT.md",
  "daily_summary.mjs",
];

const FORBIDDEN_NAMES = new Set([
  ".env",
  ".env_admins",
  ".ds_key",
  "group_chats.json",
  "user_memory.json",
  "napcat_inbox.json",
  "ddg_search.json",
  "image-memes.json",
  "memes.json",
  "api-providers.json",
  "api-providers.previous.json",
  "openclaw-workspace-state.json",
  "launcher-config.json",
  "launcher-background.json",
  "AGENTS.md",
  "SOUL.md",
  "IDENTITY.md",
  "USER.md",
  "DREAMS.md",
]);

const FORBIDDEN_DIRS = new Set([
  ".git",
  ".openclaw",
  "dist",
  "node_modules",
  "logs",
  "memory",
  "backups",
  "bin",
  "obj",
  "NapCat",
  "tools",
  "skills",
]);

const FORBIDDEN_EXTENSIONS = new Set([
  ".docx",
  ".xlsx",
  ".pptx",
  ".log",
  ".tmp",
  ".bak",
  ".key",
]);

function toPosix(filePath) {
  return filePath.split(path.sep).join("/");
}

function normalizeReleasePath(filePath) {
  return filePath.replace(/\\/g, "/").replace(/^\.\/+/, "");
}

function pathParts(filePath) {
  return normalizeReleasePath(filePath).split("/").filter(Boolean);
}

export function isForbiddenPath(filePath) {
  const normalized = normalizeReleasePath(filePath);
  const parts = pathParts(normalized);
  const base = parts.at(-1) || "";
  const ext = path.extname(base);

  if (!base) return true;
  if (normalized.includes("..")) return true;
  if (parts[0] === ".qqfriend" && !PUBLIC_QQFRIEND_FILES.has(normalized)) return true;
  if (/\.tmp(?:\.|$)/i.test(base)) return true;
  if (parts.some(part => /\.WebView2$/i.test(part) || /^publish(?:-|$)/i.test(part))) return true;
  if (FORBIDDEN_NAMES.has(base)) return true;
  if (base.startsWith(".env_")) return true;
  if (base.startsWith("~$") && base.endsWith(".docx")) return true;
  if (FORBIDDEN_EXTENSIONS.has(ext)) return true;
  return parts.some(part => FORBIDDEN_DIRS.has(part));
}

function walkFiles(root, entry, out) {
  const absolute = path.join(root, entry);
  if (!fs.existsSync(absolute)) return;

  const stat = fs.statSync(absolute);
  if (stat.isDirectory()) {
    const children = fs.readdirSync(absolute).sort();
    for (const child of children) walkFiles(root, path.join(entry, child), out);
    return;
  }

  if (stat.isFile()) out.push(toPosix(entry));
}

export function collectReleaseFiles(root, options = {}) {
  const files = collectCandidateFiles(root, options);
  return files.filter(file => !isForbiddenPath(file));
}

function collectCandidateFiles(root, options = {}) {
  const roots = [...RELEASE_ROOTS];
  if (options.includeDevTools) roots.push(...DEV_TOOLS);

  const files = [];
  for (const item of roots) walkFiles(root, item, files);

  return [...new Set(files.map(normalizeReleasePath))].sort();
}

export function assertNoForbiddenFiles(files) {
  const forbidden = files.filter(isForbiddenPath);
  if (forbidden.length) {
    throw new Error("forbidden file in release package: " + forbidden.join(", "));
  }
}

export function assertPortableZipEntries(entries) {
  for (const entry of entries) {
    if (entry.includes("\\")) throw new Error("zip entry uses Windows path: " + entry);
    if (entry.startsWith("/")) throw new Error("zip entry is absolute: " + entry);
    if (entry.includes("../")) throw new Error("zip entry escapes root: " + entry);
  }
}

export function sha256File(filePath) {
  const hash = crypto.createHash("sha256");
  hash.update(fs.readFileSync(filePath));
  return hash.digest("hex");
}

function npmCommand() {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

function run(command, args, options = {}) {
  const spawn = process.platform === "win32"
    ? ["cmd.exe", ["/d", "/s", "/c", [command, ...args].join(" ")]]
    : [command, args];
  const result = spawnSync(spawn[0], spawn[1], {
    cwd: options.cwd || ROOT,
    encoding: "utf8",
    shell: false,
  });

  const output = [result.stdout, result.stderr].filter(Boolean).join("\n");
  if (result.status !== 0) {
    const cause = result.error ? result.error.message + "\n" : "";
    throw new Error(`${command} ${args.join(" ")} failed\n${cause}${output}`);
  }
  return output;
}

function runCheck(label, command, args, checks) {
  console.log(`[release] ${label}`);
  const output = run(command, args);
  checks[label] = "pass";
  return output;
}

function testCount(output) {
  const tests = output.match(/(?:#|\u2139)\s*tests\s+(\d+)/)?.[1];
  const pass = output.match(/(?:#|\u2139)\s*pass\s+(\d+)/)?.[1];
  if (tests && pass) return `${pass}/${tests} pass`;
  return "unknown";
}

function readPackage(root) {
  const raw = fs.readFileSync(path.join(root, "package.json"), "utf8");
  return JSON.parse(raw);
}

function stampFor(date) {
  return date.toISOString().replace(/[-:]/g, "").slice(0, 15);
}

function releaseZipName(pkg, date) {
  return `qqfriend_${pkg.version}_${stampFor(date)}.zip`;
}

function ensureDist(root) {
  const dir = path.join(root, DIST_DIR);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function writeFileList(root, files) {
  const filePath = path.join(root, DIST_DIR, "release-file-list.txt");
  fs.writeFileSync(filePath, files.join("\n") + "\n", "utf8");
}

function copyToStaging(root, files, staging) {
  fs.rmSync(staging, { recursive: true, force: true });
  for (const file of files) {
    const source = path.join(root, file);
    const target = path.join(staging, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(source, target);
  }
}

function compressWithTar(root, files, zipPath) {
  const result = spawnSync("tar", ["-a", "-cf", zipPath, ...files], {
    cwd: root,
    encoding: "utf8",
  });
  return result.status === 0;
}

function compressWithPowerShell(root, files, zipPath) {
  const staging = path.join(root, DIST_DIR, ".release-staging");
  copyToStaging(root, files, staging);
  const command = [
    "Compress-Archive",
    "-Path",
    "'*'",
    "-DestinationPath",
    `'${zipPath.replace(/'/g, "''")}'`,
    "-Force",
  ].join(" ");
  const result = spawnSync("powershell", ["-NoProfile", "-Command", command], {
    cwd: staging,
    encoding: "utf8",
  });
  fs.rmSync(staging, { recursive: true, force: true });
  return result.status === 0;
}

function createZip(root, files, zipPath) {
  fs.rmSync(zipPath, { force: true });
  if (compressWithTar(root, files, zipPath)) return;
  if (process.platform === "win32" && compressWithPowerShell(root, files, zipPath)) return;
  throw new Error("failed to create release zip");
}

export function inspectZipEntries(zipPath) {
  const result = spawnSync("tar", ["-tf", zipPath], { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error("failed to inspect zip entries: " + (result.stderr || result.stdout));
  }
  return result.stdout.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
}

function textLike(file) {
  const ext = path.extname(file).toLowerCase();
  if (file === "package-lock.json") return false;
  if ([".png", ".jpg", ".jpeg", ".gif", ".webp", ".zip"].includes(ext)) return false;
  return true;
}

function isAllowedFakeKey(file, match) {
  if (file.startsWith("test/")) return true;
  if (file === ".env.example" && /x{8,}/i.test(match)) return true;
  return false;
}

function scanTextForSecrets(root, files) {
  for (const file of files.filter(textLike)) {
    const text = fs.readFileSync(path.join(root, file), "utf8");
    const matches = text.match(/sk-[A-Za-z0-9_-]{16,}/g) || [];
    const suspicious = matches.filter(match => !isAllowedFakeKey(file, match));
    if (suspicious.length) {
      throw new Error("possible real sk key in release file: " + file);
    }
  }
}

function presentForbiddenRoots(root) {
  const names = fs.readdirSync(root, { withFileTypes: true }).map(item => item.name);
  return [...new Set(names.filter(isForbiddenPath).map(redactExcludedName))].sort();
}

function redactExcludedName(name) {
  const ext = path.extname(name);
  if (name.startsWith(".env_")) return ".env_*";
  if (FORBIDDEN_EXTENSIONS.has(ext)) return "*" + ext;
  return name;
}

export function buildManifest(data) {
  return {
    name: data.name,
    version: data.version,
    createdAt: data.createdAt,
    zip: data.zip,
    sha256: data.sha256,
    checks: data.checks,
    counts: data.counts,
    included: data.included,
    excluded: data.excluded,
  };
}

function writeReleaseOutputs(root, manifest, hash) {
  fs.writeFileSync(
    path.join(root, DIST_DIR, "release-manifest.json"),
    JSON.stringify(manifest, null, 2) + "\n",
    "utf8",
  );
  fs.writeFileSync(path.join(root, DIST_DIR, "release-sha256.txt"), hash + "\n", "utf8");
}

function parseArgs(argv) {
  return {
    checkOnly: argv.includes("--check-only"),
    includeDevTools: argv.includes("--include-dev-tools"),
    zipOnly: argv.includes("--zip-only"),
  };
}

async function runRelease(root, args) {
  const options = parseArgs(args);
  const pkg = readPackage(root);
  const checks = {};
  let tests = "not run";

  ensureDist(root);
  if (!options.zipOnly) {
    runCheck("lint", npmCommand(), ["run", "lint"], checks);
    const testOutput = runCheck("test", npmCommand(), ["test"], checks);
    tests = testCount(testOutput);
    runCheck("runtime", npmCommand(), ["run", "check:runtime:ci"], checks);
    runCheck("jmRuntime", npmCommand(), ["run", "check:jm"], checks);
  }

  const files = collectReleaseFiles(root, options);
  assertNoForbiddenFiles(files);
  scanTextForSecrets(root, files);
  checks.forbiddenFiles = "pass";
  writeFileList(root, files);

  if (options.checkOnly) {
    console.log("[release] check-only complete");
    return null;
  }

  const now = new Date();
  const zipPath = path.join(root, DIST_DIR, releaseZipName(pkg, now));
  createZip(root, files, zipPath);
  const entries = inspectZipEntries(zipPath);
  assertPortableZipEntries(entries);
  checks.zipPathStyle = "pass";

  const hash = sha256File(zipPath);
  const manifest = buildManifest({
    name: pkg.name,
    version: pkg.version,
    createdAt: now.toISOString(),
    zip: toPosix(path.relative(root, zipPath)),
    sha256: hash,
    checks,
    counts: { files: files.length, tests },
    included: files,
    excluded: presentForbiddenRoots(root),
  });

  writeReleaseOutputs(root, manifest, hash);
  console.log(JSON.stringify({ zip: zipPath, sha256: hash, files: files.length }, null, 2));
  return manifest;
}

export async function main(argv = process.argv.slice(2), root = ROOT) {
  await runRelease(root, argv);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch(error => {
    console.error("[release] " + error.message);
    process.exitCode = 1;
  });
}
