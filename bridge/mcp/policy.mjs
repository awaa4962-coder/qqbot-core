import { createHash } from "node:crypto";
import { isIP } from "node:net";

export const MCP_LIMITS = Object.freeze({ servers: 4, tools: 32, pages: 4, schemaBytes: 8192,
  argsBytes: 4096, resultBytes: 16384, wireBytes: 131072, configBytes: 131072,
  timeoutMs: 8000, resultChars: 4000 });
export const plain = value => Boolean(value && typeof value === "object" && !Array.isArray(value) &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value)));
export const hash = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export const publicName = (id, name) => "mcp_" + hash([id, name]).slice(0, 40);
export function failure(reason) {
  const status = reason === "invalid_arguments" ? "invalid_arguments" :
    ["cancelled", "mcp_call_failed", "malformed_result", "unsupported_result", "result_limit", "remote_tool_error"].includes(reason) ? "unavailable" : "denied";
  return { status, reason, isError: true, text: "External tool did not return usable data (" + reason + ")." };
}
export function reject(reason) { const error = new Error(reason); error.mcpReason = reason; throw error; }
export function bounded(value, bytes) {
  const serialized = JSON.stringify(value);
  if (typeof serialized !== "string" || Buffer.byteLength(serialized) > bytes) reject("size_limit");
  return serialized;
}
export function exactKeys(value, allowed) {
  if (!plain(value) || Object.keys(value).some(key => !allowed.includes(key))) reject("invalid_configuration");
}
export function safeEndpoint(value) {
  if (typeof value !== "string" || value.length > 1024) reject("invalid_endpoint");
  let url;
  try { url = new URL(value); } catch { reject("invalid_endpoint"); }
  if (url.username || url.password || url.search || url.hash ||
      !(url.protocol === "https:" || (url.protocol === "http:" && privateHttpHost(url.hostname)))) reject("invalid_endpoint");
  return url.href;
}
function privateHttpHost(hostname) {
  const host = hostname.replace(/^\[|\]$/g, "");
  if (host === "::1") return true;
  if (isIP(host) === 6) return /^(?:fc|fd)[a-f0-9]{2}:/i.test(host);
  if (isIP(host) === 4) {
    const [a, b] = host.split(".").map(Number);
    return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  }
  // Only administrator-supplied single-label Docker DNS; never a model destination.
  return /^[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(host);
}

function text(value, max) {
  if (typeof value !== "string" || !value.trim() || value.length > max ||
      [...value].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) reject("invalid_configuration");
  return value;
}
export function normalizeConfiguration(value) {
  exactKeys(value, ["servers"]);
  bounded(value, MCP_LIMITS.configBytes);
  if (!Array.isArray(value.servers) || value.servers.length > MCP_LIMITS.servers) reject("invalid_configuration");
  const ids = new Set();
  return { servers: value.servers.map(server => {
    exactKeys(server, ["id", "label", "url", "enabled", "tools", "tokenRef"]);
    if (!/^[a-z][a-z0-9_-]{0,31}$/.test(server.id) || ids.has(server.id) || typeof server.enabled !== "boolean") reject("invalid_configuration");
    ids.add(server.id);
    if (!Array.isArray(server.tools) || server.tools.length > MCP_LIMITS.tools) reject("invalid_configuration");
    const names = new Set();
    const tools = server.tools.map(tool => normalizeTool(tool, names));
    if (server.tokenRef !== undefined && !/^[a-f0-9-]{36}$/.test(server.tokenRef)) reject("invalid_configuration");
    return { id: server.id, label: text(server.label, 80), url: safeEndpoint(server.url), enabled: server.enabled,
      tools, ...(server.tokenRef ? { tokenRef: server.tokenRef } : {}) };
  }) };
}

function normalizeTool(tool, names) {
  exactKeys(tool, ["name", "label", "enabled", "mode", "scope", "bindings", "schemaHash", "inputPolicy"]);
  if (typeof tool.name !== "string" || !/^[A-Za-z0-9_.-]{1,64}$/.test(tool.name) || names.has(tool.name) ||
      typeof tool.enabled !== "boolean" || tool.mode !== "read" || !["public", "current"].includes(tool.scope) ||
      (tool.schemaHash !== undefined && !/^[a-f0-9]{64}$/.test(tool.schemaHash))) reject("invalid_configuration");
  names.add(tool.name);
  const bindings = normalizeBindings(tool);
  if (tool.enabled && !tool.schemaHash) reject("invalid_configuration");
  const inputPolicy = normalizeInputPolicy(tool);
  return { name: tool.name, label: text(tool.label || tool.name, 80), enabled: tool.enabled,
    mode: "read", scope: tool.scope, inputPolicy, bindings, ...(tool.schemaHash ? { schemaHash: tool.schemaHash } : {}) };
}
function normalizeInputPolicy(tool) {
  const expected = tool.scope === "current" ? "current-scope" : "public-query";
  const inputPolicy = tool.inputPolicy || expected;
  if (inputPolicy !== expected) reject("invalid_configuration");
  return inputPolicy;
}
function normalizeBindings(tool) {
  exactKeys(tool.bindings || {}, ["group_id", "user_id"]);
  const bindings = tool.bindings || {};
  if (Object.entries(bindings).some(([key, target]) => target !== ({ group_id: "groupId", user_id: "userId" })[key]) ||
      (tool.scope === "public" && Object.keys(bindings).length) ||
      (tool.scope === "current" && !Object.keys(bindings).length)) reject("invalid_configuration");
  return { ...bindings };
}

// Accept only a finite, non-referencing schema subset; SDK validates actual values.
const SCHEMA_KEYS = ["type", "properties", "required", "additionalProperties", "items", "enum",
  "minimum", "maximum", "minLength", "maxLength", "minItems", "maxItems", "description", "title", "$schema"];
export function modelSchema(schema, bindings) {
  bounded(schema, MCP_LIMITS.schemaBytes);
  let count = 0;
  function inspect(node, depth) {
    exactKeys(node, SCHEMA_KEYS);
    if (++count > 128 || depth > 5 || !["object", "array", "string", "number", "integer", "boolean"].includes(node.type)) reject("unsupported_schema");
    if (node.type === "object") inspectObject(node, depth, bindings, inspect);
    if (node.type === "array") {
      checkOptionalCap(node.maxItems);
      inspect(node.items, depth + 1);
    }
    if (node.type === "string") checkOptionalCap(node.maxLength);
    if (node.enum && (!Array.isArray(node.enum) || node.enum.length > 32 || node.enum.some(item => item !== null && typeof item === "object"))) reject("unsupported_schema");
  }
  inspect(schema, 0);
  if (schema.type !== "object") reject("unsupported_schema");
  const clone = JSON.parse(JSON.stringify(schema));
  clone.properties ||= {};
  for (const field of Object.keys(bindings)) {
    if (!identityTypes(clone.properties[field])) reject("unsupported_binding");
    delete clone.properties[field];
  }
  clone.required = (clone.required || []).filter(field => !Object.hasOwn(bindings, field));
  function removeAnnotations(node) {
    delete node.description; delete node.title; delete node.$schema;
    if (node.type === "string") node.maxLength = Math.min(node.maxLength ?? 2048, 2048);
    if (node.type === "array") node.maxItems = Math.min(node.maxItems ?? 32, 32);
    if (node.type === "object") { node.properties ||= {}; node.additionalProperties = false; }
    for (const child of Object.values(node.properties || {})) removeAnnotations(child);
    if (node.items) removeAnnotations(node.items);
  }
  removeAnnotations(clone);
  return clone;
}

function inspectObject(node, depth, bindings, inspect) {
  const properties = node.properties ?? {};
  if (!plain(properties) || (node.additionalProperties !== undefined && typeof node.additionalProperties !== "boolean") || Object.keys(properties).length > 32 ||
      (node.required !== undefined && (!Array.isArray(node.required) || node.required.some(key => !Object.hasOwn(properties, key))))) reject("unsupported_schema");
  for (const [key, child] of Object.entries(properties)) {
    inspectProperty(key, child, depth, bindings, inspect);
  }
}
function inspectProperty(key, child, depth, bindings, inspect) {
  const bound = depth === 0 && Object.hasOwn(bindings, key);
  const selector = /^(?:group_id|user_id|groupId|userId|message_id|messageId|recipient|target|token|key|secret|authorization|session_id|uin|qq|uid|account_id|member_id)$/i.test(key);
  if (!/^[a-zA-Z][a-zA-Z0-9_]{0,47}$/.test(key) || (selector && !bound)) reject("unsafe_selector");
  if (bound) inspectIdentity(child); else inspect(child, depth + 1);
}
function inspectIdentity(schema) {
  exactKeys(schema, SCHEMA_KEYS);
  if (!identityTypes(schema)) reject("unsupported_binding");
}
export function identityTypes(schema) {
  const types = Array.isArray(schema?.type) ? schema.type : [schema?.type];
  return types.length > 0 && types.length <= 3 && types.every(type => ["string", "integer", "number"].includes(type)) ? types : null;
}

function checkOptionalCap(value) {
  if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) reject("unsupported_schema");
}

export function enforceInputPolicy(parameters) {
  for (const [name, schema] of Object.entries(parameters.properties)) {
    if (name === "query" && schema.type === "string") continue;
    if (["object", "array"].includes(schema.type)) reject("unsupported_input_policy");
    if (schema.enum?.length || schema.type === "boolean") continue;
    if (["integer", "number"].includes(schema.type) && Number.isFinite(schema.minimum) &&
        Number.isFinite(schema.maximum) && schema.minimum >= 0 && schema.maximum <= 1000) continue;
    reject("unsupported_input_policy");
  }
}

export function redact(value, secrets = []) {
  let result = String(value);
  for (const secret of secrets.filter(Boolean).sort((a, b) => b.length - a.length)) result = result.split(secret).join("[redacted]");
  return result.replace(/https?:\/\/[^\s"<>]+/gi, "[redacted_url]")
    .replace(/(?:Bearer\s+[^\s"<>]+|\b(?:api[_-]?key|token|secret|password|authorization)\b\s*[:=]\s*[^\s,;}]+)/gi, "[redacted]");
}
export function safeResult(result, secrets) {
  try { bounded(result, MCP_LIMITS.resultBytes); } catch { return failure("result_limit"); }
  if (!plain(result) || !Array.isArray(result.content) || result.content.length > 16) return failure("malformed_result");
  if (result.isError) return failure("remote_tool_error");
  if (result.content.some(item => !plain(item) || item.type !== "text" || typeof item.text !== "string")) return failure("unsupported_result");
  const content = result.content.map(item => ({ type: "text", text: redact(item.text, secrets) }));
  function sanitize(value, depth = 0) {
    if (depth > 8) reject("result_limit");
    if (typeof value === "string") return redact(value, secrets);
    if (Array.isArray(value)) return value.map(child => sanitize(child, depth + 1));
    if (plain(value)) return Object.fromEntries(Object.entries(value).map(([key, child]) =>
      [redact(key, secrets), /token|secret|password|authorization|api.?key/i.test(key) ? "[redacted]" : sanitize(child, depth + 1)]));
    return value;
  }
  const structuredContent = result.structuredContent === undefined ? undefined : sanitize(result.structuredContent);
  const output = content.map(item => item.text).join("\n") || (structuredContent === undefined ? "" : JSON.stringify(structuredContent));
  const safe = { status: output ? "ok" : "empty", text: output || "No data returned by external tool.", isError: false, untrusted: true, content,
    ...(structuredContent === undefined ? {} : { structuredContent }) };
  if (JSON.stringify(safe).length > MCP_LIMITS.resultChars) return failure("result_limit");
  return safe;
}
