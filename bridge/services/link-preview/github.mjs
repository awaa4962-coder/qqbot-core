import { fetchSafeResponse } from "../../safe-url.mjs";

const API_VERSION = "2026-03-10";
const MAX_RESPONSE_BYTES = 512 * 1024;
const CACHE_TTL_MS = 15 * 60 * 1000;
const MAX_CACHE_ENTRIES = 100;
const RESERVED_ROOTS = new Set([
  "about",
  "account",
  "apps",
  "collections",
  "contact",
  "customer-stories",
  "enterprise",
  "events",
  "explore",
  "features",
  "issues",
  "login",
  "marketplace",
  "new",
  "notifications",
  "orgs",
  "organizations",
  "pricing",
  "pulls",
  "search",
  "security",
  "settings",
  "signup",
  "site",
  "sponsors",
  "stars",
  "topics",
  "trending",
  "users",
]);

const cache = new Map();

export function isGitHubRepositoryUrl(value) {
  return Boolean(parseGitHubRepositoryUrl(value));
}

export function parseGitHubRepositoryUrl(value) {
  let url;
  try {
    url = new URL(String(value || ""));
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase();
  if (url.protocol !== "https:" || !["github.com", "www.github.com"].includes(host)) return null;

  const segments = url.pathname.split("/").filter(Boolean).map(decodeSegment);
  if (segments.length < 2 || segments.some(segment => segment === null)) return null;
  const owner = segments[0];
  const repo = segments[1].replace(/\.git$/i, "");
  if (RESERVED_ROOTS.has(owner.toLowerCase())) return null;
  if (!isRepositoryPart(owner, 39) || !isRepositoryPart(repo, 100)) return null;

  const fullName = owner + "/" + repo;
  return {
    owner,
    repo,
    fullName,
    key: fullName.toLowerCase(),
    url: "https://github.com/" + fullName,
  };
}

export async function fetchGitHubRepositoryInfo(value, options = {}) {
  const repository = parseGitHubRepositoryUrl(value);
  if (!repository) return null;
  const now = Number(options.now || Date.now());
  const cached = readCache(repository.key, now);
  if (cached) return cached;

  const loader = options.loader || loadGitHubRepository;
  let data;
  try {
    data = await loader(repository, options);
  } catch {
    return null;
  }
  const preview = normalizeGitHubRepository(data, repository);
  if (!preview) return null;
  cache.set(repository.key, { value: preview, createdAt: now });
  trimCache();
  return preview;
}

export function normalizeGitHubRepository(data, repository) {
  if (!data || data.private === true || !repository) return null;
  const fullName = cleanText(data.full_name) || repository.fullName;
  const description = clipText(data.description, 180) || "暂无仓库简介";
  const details = [
    cleanText(data.language),
    "Stars " + formatCount(data.stargazers_count),
    "Forks " + formatCount(data.forks_count),
  ].filter(Boolean);
  const meta = [];
  const license = normalizeLicense(data.license);
  if (license) meta.push("许可证 " + license);
  const updated = formatDate(data.updated_at || data.pushed_at);
  if (updated) meta.push("更新 " + updated);

  const lines = ["GitHub：" + fullName, description, details.join(" · ")];
  if (meta.length) lines.push(meta.join(" · "));
  const topics = normalizeTopics(data.topics);
  if (topics.length) lines.push("主题：" + topics.join(" / "));
  const states = normalizeStates(data);
  if (states.length) lines.push("状态：" + states.join("、"));

  return {
    text: lines.filter(Boolean).join("\n"),
    image: buildSocialImage(repository),
    title: fullName,
    description,
    siteName: "GitHub",
    host: "github.com",
    url: repository.url,
    githubRepository: repository.fullName,
  };
}

export function resetGitHubPreviewCache() {
  cache.clear();
}

async function loadGitHubRepository(repository, options = {}) {
  const endpoint = "https://api.github.com/repos/" +
    encodeURIComponent(repository.owner) + "/" + encodeURIComponent(repository.repo);
  const result = await fetchSafeResponse(endpoint, {
    timeoutMs: options.timeoutMs || 8000,
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "QQFriend-LinkPreview",
      "X-GitHub-Api-Version": API_VERSION,
    },
  });
  if (!result.ok || !result.response?.ok) return null;
  const contentType = result.response.headers.get("content-type") || "";
  if (!/^application\/(?:json|vnd\.github\+json)(?:;|$)/i.test(contentType)) return null;
  return readJsonBounded(result.response, MAX_RESPONSE_BYTES);
}

async function readJsonBounded(response, maxBytes) {
  const contentLength = Number(response.headers.get("content-length") || 0);
  if (contentLength > maxBytes) return null;
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length > maxBytes) return null;
  try {
    return JSON.parse(buffer.toString("utf8"));
  } catch {
    return null;
  }
}

function decodeSegment(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

function isRepositoryPart(value, maxLength) {
  return value.length > 0 && value.length <= maxLength && /^[A-Za-z0-9_.-]+$/.test(value);
}

function buildSocialImage(repository) {
  return "https://opengraph.githubassets.com/1/" +
    encodeURIComponent(repository.owner) + "/" + encodeURIComponent(repository.repo);
}

function cleanText(value) {
  const printable = [...String(value || "")]
    .map(character => isControlCharacter(character) ? " " : character)
    .join("");
  return printable.replace(/\s+/g, " ").trim();
}

function isControlCharacter(character) {
  const code = character.charCodeAt(0);
  return code <= 31 || code === 127;
}

function clipText(value, maxLength) {
  const text = cleanText(value);
  return text.length > maxLength ? text.slice(0, maxLength - 1).trimEnd() + "..." : text;
}

function formatCount(value) {
  const number = Math.max(0, Number(value) || 0);
  if (number >= 1000000) return trimDecimal(number / 1000000) + "m";
  if (number >= 1000) return trimDecimal(number / 1000) + "k";
  return String(Math.floor(number));
}

function trimDecimal(value) {
  return value.toFixed(1).replace(/\.0$/, "");
}

function normalizeLicense(license) {
  const spdx = cleanText(license?.spdx_id);
  if (spdx && spdx !== "NOASSERTION") return spdx;
  return cleanText(license?.name);
}

function formatDate(value) {
  const match = String(value || "").match(/^(\d{4})-(\d{2})-(\d{2})/);
  return match ? match[1] + "-" + match[2] + "-" + match[3] : "";
}

function normalizeTopics(topics) {
  if (!Array.isArray(topics)) return [];
  return topics.map(cleanText).filter(Boolean).slice(0, 5);
}

function normalizeStates(data) {
  const states = [];
  if (data.archived) states.push("已归档");
  if (data.disabled) states.push("已停用");
  if (data.is_template) states.push("模板仓库");
  if (data.fork) states.push("派生仓库");
  return states;
}

function readCache(key, now) {
  const cached = cache.get(key);
  return cached && now - cached.createdAt <= CACHE_TTL_MS ? cached.value : null;
}

function trimCache() {
  while (cache.size > MAX_CACHE_ENTRIES) cache.delete(cache.keys().next().value);
}
