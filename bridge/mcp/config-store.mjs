import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { readJsonFile, writeJsonFileSync } from "../persistence/json-file.mjs";
import { MCP_LIMITS, exactKeys, plain, normalizeConfiguration, reject } from "./policy.mjs";

export function createMcpConfigStore(cfg) {
  if (!cfg?.configRoot || !cfg.mcpConfigFile || path.dirname(path.resolve(cfg.mcpConfigFile)) !== path.resolve(cfg.configRoot)) reject("configuration_path_required");
  const filename = path.resolve(cfg.mcpConfigFile);
  const secretsFile = path.join(path.resolve(cfg.configRoot), ".mcp-secrets.json");
  const missing = Symbol("missing");
  function read(file, fallback) {
    try {
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink() || (process.platform !== "win32" && (stat.mode & 0o077))) reject("unsafe_configuration_file");
    } catch (error) { if (error.code !== "ENOENT") throw error; }
    return readJsonFile(file, fallback, { maxBytes: MCP_LIMITS.configBytes });
  }
  function load() {
    const data = read(filename, missing);
    const secrets = read(secretsFile, missing);
    if (data === missing && secrets === missing) return { revision: "0", configuration: { servers: [] }, secrets: {} };
    if (data === missing || secrets === missing) reject("configuration_unreadable");
    if (!plain(secrets) || Object.keys(secrets).length > MCP_LIMITS.servers * 2 ||
        Object.entries(secrets).some(([id, token]) => !/^[a-f0-9-]{36}$/.test(id) || !validToken(token))) reject("configuration_unreadable");
    exactKeys(data, ["version", "revision", "configuration"]);
    if (data.version !== 1 || !/^[a-f0-9-]{36}$/.test(data.revision)) reject("configuration_unreadable");
    const configuration = normalizeConfiguration(data.configuration);
    if (configuration.servers.some(server => server.tokenRef && !Object.hasOwn(secrets, server.tokenRef))) reject("secret_missing");
    return { revision: data.revision, configuration, secrets };
  }
  function save(configuration, tokens, expectedRevision) {
    fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
    let lock;
    try { lock = fs.openSync(filename + ".lock", "wx", 0o600); }
    catch { reject("configuration_busy"); }
    try { return commit(configuration, tokens, expectedRevision); }
    finally { fs.closeSync(lock); fs.rmSync(filename + ".lock", { force: true }); }
  }
  function commit(configuration, tokens, expectedRevision) {
    const previous = load();
    if (expectedRevision !== previous.revision) reject("revision_conflict");
    const next = normalizeConfiguration(configuration);
    exactKeys(tokens || {}, next.servers.map(server => server.id));
    const secrets = {};
    // Keep the currently referenced tokens until the primary-file commit succeeds.
    for (const server of previous.configuration.servers) if (server.tokenRef) secrets[server.tokenRef] = previous.secrets[server.tokenRef];
    for (const server of next.servers) {
      const old = previous.configuration.servers.find(item => item.id === server.id);
      assignToken(server, old, previous.secrets, tokens || {}, secrets);
    }
    if (JSON.stringify(next) === JSON.stringify(previous.configuration)) return previous;
    const revision = randomUUID();
    writeJsonFileSync(secretsFile, secrets, { durable: true, spacing: 2 });
    writeJsonFileSync(filename, { version: 1, revision, configuration: next }, { durable: true, spacing: 2 });
    return { revision, configuration: next, secrets };
  }
  return { load, save };
}

function validToken(token) { return typeof token === "string" && /^[\x21-\x7e]{1,2048}$/.test(token); }

function assignToken(server, old, previousSecrets, tokens, secrets) {
  delete server.tokenRef;
  if (Object.hasOwn(tokens, server.id)) {
    const token = tokens[server.id];
    if (token !== null && !validToken(token)) reject("invalid_token");
    if (token !== null) {
      server.tokenRef = old?.tokenRef && previousSecrets[old.tokenRef] === token ? old.tokenRef : randomUUID();
      secrets[server.tokenRef] = token;
    }
  } else if (old?.tokenRef) { server.tokenRef = old.tokenRef; secrets[server.tokenRef] = previousSecrets[old.tokenRef]; }
}
