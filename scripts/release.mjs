import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIST_DIR = "dist";
const DEV_TOOLS = ["debug_bridge.mjs", "search_comp.mjs", "test_server.mjs"];
const PUBLIC_BUILD_WORKFLOW = ".github/workflows/publish-linux-images.yml";
const PUBLIC_QQFRIEND_FILES = new Set([
  ".qqfriend/architecture.json",
  ".qqfriend/commands.json",
  ".qqfriend/diagnostics.json",
  ".qqfriend/index.json",
  ".qqfriend/modules.json",
  ".qqfriend/workflows.json",
]);
const PUBLIC_LINUX_FILES = new Set([
  ".env.example", "qqfriend.env.example", "compose.yaml",
  "Dockerfile", "Dockerfile.dependencies", "Dockerfile.overlay",
  "check.sh", "prepare.sh", "install-docker-host.sh", "install-summary-schedule.sh", "install-time-order.sh",
  "README.md", "ROADMAP.md", "MEMBER-SUMMARY.md", "MODULAR-RUNTIME.md", "SUMMARY-WORKBENCH.md", "MEMORY.md", "CHAT-TOOLS.md", "VISION.md", "USAGE.md", "CONTEXT.md",
  "FRONTEND-ACCEPTANCE.md", "LEGACY-INTERFACES.md", "QUALITY-MATRIX.md", "GRAY-ACCEPTANCE.md",
  "AGENT-PLAN.md",
  "systemd/docker-chrony-wait.conf", "systemd/qqfriend-summary.service",
  "systemd/qqfriend-summary.timer", "systemd/qqfriend.service",
].map(file => "deploy/linux/" + file));
const PUBLIC_ENV_EXAMPLES = new Set([".env.example", "deploy/linux/.env.example", "deploy/linux/qqfriend.env.example"]);
const RELEASE_ROOTS = [
  "bridge",
  ...PUBLIC_QQFRIEND_FILES,
  "test",
  "scripts",
  "deploy/linux",
  "launcher/QQFriendLauncher",
  ".github/workflows/ci.yml",
  PUBLIC_BUILD_WORKFLOW,
  ".dockerignore",
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
  "chat-delivery.json",
  "napcat_inbox.json",
  "ddg_search.json",
  "image-memes.json",
  "memes.json",
  "api-providers.json",
  "api-providers.previous.json",
  ".user-salt",
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

function isPrivateConfigPath(normalized, parts, base) {
  if (parts.includes(".qqfriend") && !PUBLIC_QQFRIEND_FILES.has(normalized)) return true;
  if (normalized.startsWith("deploy/linux/") &&
      ![...PUBLIC_LINUX_FILES].some(file => file === normalized || file.startsWith(normalized + "/"))) return true;
  return /(?:^|\.)env(?:[._-]|$)/i.test(base) && !PUBLIC_ENV_EXAMPLES.has(normalized);
}

export function isForbiddenPath(filePath) {
  const normalized = normalizeReleasePath(filePath);
  const parts = pathParts(normalized);
  const base = parts.at(-1) || "";
  const ext = path.extname(base);

  if (!base) return true;
  if (normalized.includes("..")) return true;
  if (isPrivateConfigPath(normalized, parts, base)) return true;
  if (/\.tmp(?:\.|$)/i.test(base)) return true;
  if (parts.some(part => /\.WebView2$/i.test(part) || (/^publish(?:-|$)/i.test(part) && normalized !== PUBLIC_BUILD_WORKFLOW))) return true;
  if (FORBIDDEN_NAMES.has(base)) return true;
  if (/^usage-\d{4}-\d{2}-\d{2}\.jsonl$/i.test(base)) return true;
  if (base.startsWith(".env_")) return true;
  if (base.startsWith("~$") && base.endsWith(".docx")) return true;
  if (FORBIDDEN_EXTENSIONS.has(ext)) return true;
  return parts.some(part => FORBIDDEN_DIRS.has(part));
}

function walkFiles(root, entry, out) {
  if (isForbiddenPath(entry)) return;
  const absolute = path.join(root, entry);
  let stat;
  // Never follow a file or directory link, including ancestors of explicit file roots.
  let cursor = root;
  for (const part of pathParts(entry)) {
    cursor = path.join(cursor, part);
    try { stat = fs.lstatSync(cursor); }
    catch (error) { if (error.code === "ENOENT") return; throw error; }
    if (stat.isSymbolicLink()) throw new Error("symbolic links are not allowed in releases: " + toPosix(entry));
  }
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
    env: options.env || process.env,
    shell: false,
  });

  const output = [result.stdout, result.stderr].filter(Boolean).join("\n");
  if (result.status !== 0) {
    const cause = result.error ? result.error.message + "\n" : "";
    const locations = options.redactOutput ? parseTestFailureLocations(output, knownTestFiles(options.cwd || ROOT)) : [];
    const detail = options.redactOutput
      ? locations.length ? "\n[release] test failure locations " + JSON.stringify(locations) : ""
      : "\n" + cause + output;
    throw new Error(`${command} ${args.join(" ")} failed${detail}`);
  }
  return output;
}

function runCheck(label, command, args, checks, options = {}) {
  console.log(`[release] ${label}`);
  const output = (options.runner || run)(command, args, options);
  checks[label] = "pass";
  return output;
}

export function parseTestFailureLocations(output, knownFiles = []) {
  if (typeof output !== "string") return [];
  const allowed = new Set(knownFiles);
  const locations = new Map();
  for (const line of output.split(/\r?\n/)) {
    if (!line.startsWith("[qqfriend-test-failure] ")) continue;
    let value;
    try { value = JSON.parse(line.slice("[qqfriend-test-failure] ".length)); }
    catch { continue; }
    if (!validTestFailureLocation(value) || !allowed.has(value.file)) continue;
    locations.set(value.file + ":" + value.line + ":" + value.column, value);
    if (locations.size === 20) break;
  }
  return [...locations.values()];
}

function knownTestFiles(root) {
  try { return collectReleaseFiles(root).filter(file => file.startsWith("test/")); }
  catch { return []; }
}

function validTestFailureLocation(value) {
  return value && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).length === 3 && typeof value.file === "string" &&
    /^test\/(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+\.(?:mjs|js)$/.test(value.file) &&
    !value.file.includes("..") && !value.file.split("/").includes(".") && value.file.length <= 240 &&
    [value.line, value.column].every(number => Number.isSafeInteger(number) && number > 0 && number <= 10000000);
}

export function parseTestCounts(output) {
  if (typeof output !== "string") return null;
  const counts = {};
  for (const line of output.split(/\r?\n/)) {
    const match = line.match(/^\s*(?:#|\u2139)\s*(tests|pass|fail|cancelled|skipped|todo)(?:\s+(.+?))?\s*$/);
    if (!match) continue;
    const [, name, value] = match;
    if (Object.hasOwn(counts, name) || !/^\d+$/.test(value)) return null;
    counts[name] = Number(value);
    if (!Number.isSafeInteger(counts[name])) return null;
  }
  if (["tests", "pass", "fail", "skipped"].some(name => !Object.hasOwn(counts, name))) return null;
  const outcomes = counts.pass + counts.fail + counts.skipped + (counts.cancelled || 0) + (counts.todo || 0);
  if (!Number.isSafeInteger(outcomes) || outcomes !== counts.tests) return null;
  return { total: counts.tests, pass: counts.pass, fail: counts.fail, skipped: counts.skipped };
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
  return filePath;
}

function releasePythonCandidates() {
  const bundled = path.join(
    process.env.USERPROFILE || "",
    ".cache",
    "codex-runtimes",
    "codex-primary-runtime",
    "dependencies",
    "python",
    "python.exe"
  );
  return [...new Set([
    process.env.QQBOT_RELEASE_PYTHON,
    process.env.QQBOT_JM_PYTHON,
    fs.existsSync(bundled) ? bundled : "",
    process.platform === "win32" ? "python" : "python3",
  ].filter(Boolean))];
}

function createZip(root, zipPath, fileListPath) {
  fs.rmSync(zipPath, { force: true });
  const script = path.join(root, "scripts", "create-release-zip.py");
  const failures = [];
  for (const python of releasePythonCandidates()) {
    const result = spawnSync(python, [
      script,
      "--root", root,
      "--output", zipPath,
      "--file-list", fileListPath,
    ], { cwd: root, encoding: "utf8" });
    if (result.status === 0) return;
    failures.push(`${python}: ${result.error?.message || result.stderr || "exit " + result.status}`);
  }
  throw new Error("failed to create permission-safe release zip\n" + failures.join("\n"));
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

async function runRelease(root, args, runner) {
  const options = parseArgs(args);
  const pkg = readPackage(root);
  const checks = {};
  const checkOptions = { cwd: root, runner };
  let tests = "not run";

  ensureDist(root);
  if (!options.zipOnly) {
    runCheck("dependencies", npmCommand(), ["run", "check:dependencies"], checks, checkOptions);
    runCheck("lint", npmCommand(), ["run", "lint"], checks, checkOptions);
    const testOutput = runCheck("test", npmCommand(), ["test"], checks, { ...checkOptions, redactOutput: true });
    const testCounts = parseTestCounts(testOutput);
    tests = testCounts ? `${testCounts.pass}/${testCounts.total} pass` : "unknown";
    console.log("[release] test counts " + (testCounts
      ? `total=${testCounts.total} pass=${testCounts.pass} fail=${testCounts.fail} skipped=${testCounts.skipped}`
      : "unknown"));
    runCheck("runtime", npmCommand(), ["run", "check:runtime:ci"], checks, checkOptions);
    runCheck("jmRuntime", npmCommand(), ["run", "check:jm"], checks, {
      ...checkOptions,
      env: { ...process.env, NODE_ENV: "test" },
    });
  }

  const files = collectReleaseFiles(root, options);
  assertNoForbiddenFiles(files);
  scanTextForSecrets(root, files);
  checks.forbiddenFiles = "pass";
  const fileListPath = writeFileList(root, files);

  if (options.checkOnly) {
    console.log("[release] check-only complete");
    return null;
  }

  const now = new Date();
  const zipPath = path.join(root, DIST_DIR, releaseZipName(pkg, now));
  createZip(root, zipPath, fileListPath);
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

export async function main(argv = process.argv.slice(2), root = ROOT, runner = run) {
  await runRelease(root, argv, runner);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch(error => {
    console.error("[release] " + error.message);
    process.exitCode = 1;
  });
}
