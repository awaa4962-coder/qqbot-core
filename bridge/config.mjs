// bridge/config.mjs - global runtime configuration.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const TEST_MODE = process.env.NODE_ENV === 'test';
const CONFIG_ROOT = path.resolve(process.env.QQBOT_CONFIG_ROOT || ROOT);
const DATA_ROOT = path.resolve(process.env.QQBOT_DATA_DIR || ROOT);
const LOG_ROOT = path.resolve(process.env.QQBOT_LOG_DIR || path.join(DATA_ROOT, 'logs'));
const ADMIN_BACKUP_DIR = DATA_ROOT === ROOT
  ? path.join(ROOT, 'dist', 'admin-backups')
  : path.join(DATA_ROOT, 'backups');
const MEMORY_PROFILE_FILE = path.resolve(
  process.env.QQBOT_MEMORY_PROFILE_FILE || (
    process.env.QQBOT_DATA_DIR
      ? path.join(DATA_ROOT, '.qqfriend', 'memory_profiles.json')
      : path.join(process.env.LOCALAPPDATA || DATA_ROOT, 'qqfriend', 'memory_profiles.json')
  )
);

const DEFAULT_GROUP_WHITELIST = [];
const TEST_SELF_UIN = 1000000001;
const TEST_GROUP_WHITELIST = [2000000001, 2000000002, 2000000003, 2000000004, 2000000005];
const TEST_SUMMARY_EXCLUDED = new Set([2000000004, 2000000005]);
const TEST_FRIEND_WHITELIST = [3000000001, 3000000002];
const TEST_BOT_BLACKLIST = [4000000001];
const TEST_LONG_GROUPS = ['2000000005', '2000000003'];
const DEFAULT_RESOURCE_MAX_BYTES = 500 * 1024 * 1024;
const DEFAULT_JM_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_JM_ZIP_PASSWORD = 'FS';
const DEFAULT_JMCOMIC_SRC = path.join(ROOT, 'runtime_deps', 'jmcomic', 'src');

function _readKey(filename, label) {
  const p = path.join(CONFIG_ROOT, filename);
  if (TEST_MODE) return 'test-only-' + filename.replace(/[^a-z0-9]+/gi, '-');
  try {
    return fs.readFileSync(p, 'utf-8').trim();
  } catch {
    if (process.env.CI) {
      console.warn('[config] missing key file: ' + p + ' (' + label + '), skipped in test mode');
      return '';
    }
    console.error('[config] missing key file: ' + p + ' (' + label + ')');
    console.error('[config] please ensure ' + filename + ' exists and is readable');
    process.exit(1);
    return '';
  }
}

function _readOptionalList(filename, envName) {
  const fromEnv = String(process.env[envName] || '').trim();
  if (fromEnv) return parseList(fromEnv);
  try {
    return parseList(fs.readFileSync(path.join(CONFIG_ROOT, filename), 'utf-8'));
  } catch {
    return [];
  }
}

function _readOptionalNumberList(filename, envName) {
  const fromEnv = String(process.env[envName] || '').trim();
  if (fromEnv) return parseNumberList(fromEnv);
  try {
    return parseNumberList(fs.readFileSync(path.join(CONFIG_ROOT, filename), 'utf-8'));
  } catch {
    return [];
  }
}

function _readOptionalSecret(filename, envName) {
  if (Object.prototype.hasOwnProperty.call(process.env, envName)) {
    return String(process.env[envName] || '').trim();
  }
  try {
    return fs.readFileSync(path.join(CONFIG_ROOT, filename), 'utf-8').trim();
  } catch {
    return '';
  }
}

function parseList(raw) {
  return String(raw || '')
    .split(/[\s,;]+/)
    .map(function(item) { return item.trim(); })
    .filter(Boolean);
}

function parseNumberList(raw) {
  return parseList(raw)
    .map(function(item) { return Number(item); })
    .filter(function(item) { return Number.isSafeInteger(item) && item > 0; });
}

function readBotNames() {
  const fromConfig = _readOptionalList('.env_bot_names', 'QQBOT_NAMES');
  return fromConfig.length ? fromConfig : ['夜星', 'QQFriend', 'Yexing'];
}

function readGroupWhitelist() {
  const fromConfig = _readOptionalNumberList('.env_groups', 'QQBOT_GROUPS');
  if (fromConfig.length) return fromConfig;
  return TEST_MODE ? TEST_GROUP_WHITELIST : DEFAULT_GROUP_WHITELIST;
}

function readSelfUin() {
  const fromConfig = _readOptionalNumberList('.env_self_uin', 'QQBOT_SELF_UIN');
  return fromConfig[0] || (TEST_MODE ? TEST_SELF_UIN : 0);
}

function readSummaryGroupWhitelist(groupWhitelist) {
  const fromConfig = _readOptionalNumberList('.env_summary_groups', 'QQBOT_SUMMARY_GROUPS');
  if (fromConfig.length) return fromConfig;
  return TEST_MODE
    ? groupWhitelist.filter(groupId => !TEST_SUMMARY_EXCLUDED.has(groupId))
    : groupWhitelist;
}

function readResourceGroupWhitelist(groupWhitelist) {
  const fromConfig = _readOptionalNumberList('.env_resource_groups', 'QQBOT_RESOURCE_GROUPS');
  return fromConfig.length ? fromConfig : groupWhitelist;
}

function readFeatureGroupWhitelist(groupWhitelist) {
  const fromConfig = _readOptionalNumberList('.env_feature_groups', 'QQBOT_FEATURE_GROUPS');
  return fromConfig.length ? fromConfig : groupWhitelist;
}

function readStickerGroupWhitelist(groupWhitelist) {
  const fromConfig = _readOptionalNumberList('.env_sticker_groups', 'QQBOT_STICKER_GROUPS');
  return fromConfig.length ? fromConfig : groupWhitelist;
}

function readFriendWhitelist() {
  const fromConfig = _readOptionalNumberList('.env_friends', 'QQBOT_FRIENDS');
  return fromConfig.length || !TEST_MODE ? fromConfig : TEST_FRIEND_WHITELIST;
}

function readJmUserWhitelist() {
  return _readOptionalNumberList('.env_jm_users', 'QQBOT_JM_USERS');
}

function readBotBlacklist() {
  const fromConfig = _readOptionalNumberList('.env_bot_blacklist', 'QQBOT_BLACKLIST');
  return fromConfig.length || !TEST_MODE ? fromConfig : TEST_BOT_BLACKLIST;
}

function readLongGroups() {
  const fromConfig = _readOptionalNumberList('.env_long_groups', 'QQBOT_LONG_GROUPS');
  return fromConfig.length || !TEST_MODE ? fromConfig.map(String) : TEST_LONG_GROUPS;
}

function readJmPython() {
  if (process.env.QQBOT_JM_PYTHON) return process.env.QQBOT_JM_PYTHON;
  const bundled = path.join(
    process.env.USERPROFILE || '',
    '.cache',
    'codex-runtimes',
    'codex-primary-runtime',
    'dependencies',
    'python',
    'python.exe'
  );
  if (fs.existsSync(bundled)) return bundled;
  return process.platform === 'win32' ? 'python' : 'python3';
}

function readJmZipPassword() {
  if (Object.prototype.hasOwnProperty.call(process.env, 'QQBOT_JM_ZIP_PASSWORD')) {
    return String(process.env.QQBOT_JM_ZIP_PASSWORD || '').trim();
  }
  return DEFAULT_JM_ZIP_PASSWORD;
}

function readBooleanEnv(name, defaultValue) {
  if (!Object.prototype.hasOwnProperty.call(process.env, name)) return defaultValue;
  const value = String(process.env[name] || '').trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(value)) return true;
  if (['0', 'false', 'no', 'off'].includes(value)) return false;
  return defaultValue;
}

function readBoundedNumber(name, defaultValue, min, max) {
  const value = Number(process.env[name]);
  if (!Number.isFinite(value)) return defaultValue;
  return Math.min(max, Math.max(min, value));
}

function readJmcomicSrc() {
  if (Object.prototype.hasOwnProperty.call(process.env, 'QQBOT_JMCOMIC_SRC')) {
    return String(process.env.QQBOT_JMCOMIC_SRC || '').trim();
  }
  return fs.existsSync(DEFAULT_JMCOMIC_SRC) ? DEFAULT_JMCOMIC_SRC : '';
}

function readWordcloudStopwords() {
  const defaults = [
    'the', 'and', 'for', 'with', 'that', 'this', 'what', 'from',
    'http', 'https', 'www', 'com',
    '我', '你', '他', '她', '它', '们', '我们', '你们', '他们',
    '这个', '那个', '就是', '一个', '一下', '不是', '没有', '可以',
    '什么', '怎么', '然后', '因为', '所以', '还是', '已经', '现在',
    '今天', '昨天', '明天', '夜星', 'QQFriend', 'Yexing',
    '消息', '文本', '非文', '非文本', '本消', '本消息', '文本消', '非文本消息',
    '图片', '文件', '命令', 'command',
    '傻逼', '煞笔', 'sb', 'nmsl',
  ];
  const extra = _readOptionalList('.env_wordcloud_stopwords', 'QQBOT_WORDCLOUD_STOPWORDS');
  return [...new Set(defaults.concat(extra))];
}

const GROUP_WHITELIST = readGroupWhitelist();
const SUMMARY_GROUP_WHITELIST = readSummaryGroupWhitelist(GROUP_WHITELIST);
const RESOURCE_GROUP_WHITELIST = readResourceGroupWhitelist(GROUP_WHITELIST);
const FEATURE_GROUP_WHITELIST = readFeatureGroupWhitelist(GROUP_WHITELIST);
const STICKER_GROUP_WHITELIST = readStickerGroupWhitelist(GROUP_WHITELIST);

export const CFG = {
  napcatApi: String(process.env.QQBOT_NAPCAT_API || 'http://127.0.0.1:6700').trim().replace(/\/+$/, ''),
  napcatWsApi: String(process.env.QQBOT_NAPCAT_WS_API || '').trim(),
  napcatAccessToken: _readOptionalSecret('.env_napcat_token', 'QQBOT_NAPCAT_TOKEN'),
  napcatStreamRequired: readBooleanEnv('QQBOT_NAPCAT_STREAM_REQUIRED', false),
  napcatStreamChunkBytes: readBoundedNumber('QQBOT_NAPCAT_STREAM_CHUNK_BYTES', 256 * 1024, 64 * 1024, 1024 * 1024),
  napcatStreamRetentionSeconds: readBoundedNumber('QQBOT_NAPCAT_STREAM_RETENTION_SECONDS', 86400, 60, 604800),
  napcatStreamTimeoutMs: readBoundedNumber('QQBOT_NAPCAT_STREAM_TIMEOUT_MS', 60000, 5000, 10 * 60 * 1000),
  listenHost: String(process.env.QQBOT_LISTEN_HOST || '0.0.0.0').trim() || '0.0.0.0',
  listenPort: readBoundedNumber('QQBOT_LISTEN_PORT', 16789, 1, 65535),
  webConsoleEnabled: readBooleanEnv('QQFRIEND_WEB_CONSOLE', false),
  selfUin: readSelfUin(),
  groupWhitelist: GROUP_WHITELIST,
  summaryGroupWhitelist: SUMMARY_GROUP_WHITELIST,
  resourceGroupWhitelist: RESOURCE_GROUP_WHITELIST,
  featureGroupWhitelist: FEATURE_GROUP_WHITELIST,
  stickerGroupWhitelist: STICKER_GROUP_WHITELIST,
  resourceMaxBytes: DEFAULT_RESOURCE_MAX_BYTES,
  jmPython: readJmPython(),
  jmcomicSrc: readJmcomicSrc(),
  jmDomains: parseList(process.env.QQBOT_JM_DOMAINS || ''),
  jmTimeoutMs: Number(process.env.QQBOT_JM_TIMEOUT_MS || DEFAULT_JM_TIMEOUT_MS),
  jmZipPassword: readJmZipPassword(),
  jmSevenZipPath: String(process.env.QQBOT_7Z_PATH || '').trim(),
  linkPreviewEnabled: readBooleanEnv('QQBOT_LINK_PREVIEW_ENABLED', true),
  wordcloudMaxMessages: Number(process.env.QQBOT_WORDCLOUD_MAX_MESSAGES || 800),
  wordcloudStopwords: readWordcloudStopwords(),
  memeKnowledgeFile: path.join(DATA_ROOT, '.qqfriend', 'memes.json'),
  memeUpdateLockFile: path.join(DATA_ROOT, '.qqfriend', 'meme-update.lock'),
  memeAutoUpdateEnabled: readBooleanEnv('QQBOT_MEME_AUTO_UPDATE', true),
  memeUpdateIntervalMs: readBoundedNumber(
    'QQBOT_MEME_UPDATE_INTERVAL_MS',
    6 * 60 * 60 * 1000,
    60 * 60 * 1000,
    7 * 24 * 60 * 60 * 1000
  ),
  memeUpdateLimit: readBoundedNumber('QQBOT_MEME_UPDATE_LIMIT', 15, 1, 50),
  memeTrendApiBase: String(
    process.env.QQBOT_MEME_TREND_API_BASE || 'https://api-hot.imsyy.top'
  ).trim().replace(/\/+$/, ''),
  memeRssHubBase: String(process.env.QQBOT_MEME_RSSHUB_BASE || '').trim().replace(/\/+$/, ''),
  memeEvidenceMinSources: readBoundedNumber('QQBOT_MEME_MIN_SOURCES', 2, 1, 5),
  memeEvidenceMinItems: readBoundedNumber('QQBOT_MEME_MIN_EVIDENCE', 3, 1, 10),
  memeExpiryDays: readBoundedNumber('QQBOT_MEME_EXPIRY_DAYS', 90, 7, 365),
  imageMemeCacheFile: path.join(DATA_ROOT, '.qqfriend', 'image-memes.json'),
  stickerCatalogFile: path.join(DATA_ROOT, '.qqfriend', 'stickers', 'catalog.json'),
  stickerTempDir: path.join(
    process.env.QQBOT_TEMP_DIR || process.env.TEMP || process.env.TMP || path.join(DATA_ROOT, '.qqfriend'),
    'qqfriend-stickers'
  ),
  stickerEnabled: readBooleanEnv('QQBOT_STICKERS_ENABLED', true),
  stickerPrivateEnabled: readBooleanEnv('QQBOT_STICKER_PRIVATE', true),
  stickerMode: String(process.env.QQBOT_STICKER_MODE || 'steady').trim().toLowerCase(),
  stickerCaptureMode: String(process.env.QQBOT_STICKER_CAPTURE_MODE || 'observe').trim().toLowerCase(),
  stickerCaptureDailyLimit: readBoundedNumber('QQBOT_STICKER_CAPTURE_DAILY_LIMIT', 20, 0, 200),
  stickerCaptureCatalogLimit: readBoundedNumber('QQBOT_STICKER_CAPTURE_CATALOG_LIMIT', 300, 1, 2000),
  stickerCaptureMinConfidence: readBoundedNumber('QQBOT_STICKER_CAPTURE_MIN_CONFIDENCE', 0.82, 0, 1),
  stickerCaptureMinDistinctSenders: readBoundedNumber(
    'QQBOT_STICKER_CAPTURE_MIN_DISTINCT_SENDERS',
    readBoundedNumber('QQBOT_STICKER_CAPTURE_MIN_SENDERS', 2, 1, 20),
    1,
    20
  ),
  stickerCaptureQueueLimit: readBoundedNumber('QQBOT_STICKER_CAPTURE_QUEUE_LIMIT', 50, 1, 500),
  stickerChance: readBoundedNumber('QQBOT_STICKER_CHANCE', 0.1, 0, 1),
  stickerStrongChance: readBoundedNumber('QQBOT_STICKER_STRONG_CHANCE', 0.25, 0, 1),
  stickerCooldownMs: readBoundedNumber('QQBOT_STICKER_COOLDOWN_MS', 300000, 0, 86400000),
  stickerSyncIntervalMs: readBoundedNumber('QQBOT_STICKER_SYNC_INTERVAL_MS', 3600000, 60000, 86400000),
  stickerFetchCount: readBoundedNumber('QQBOT_STICKER_FETCH_COUNT', 100, 1, 500),
  memeLearningMode: String(process.env.QQBOT_MEME_MODE || 'steady').trim() || 'steady',
  legacyProfileRefreshEnabled: process.env.QQBOT_LEGACY_PROFILE_REFRESH === '1',
  botBlacklist: readBotBlacklist(),
  friendWhitelist: readFriendWhitelist(),
  jmUserWhitelist: readJmUserWhitelist(),
  adminUins: _readOptionalList('.env_admins', 'QQBOT_ADMINS'),
  botNames: readBotNames(),
  memoryFile: path.join(DATA_ROOT, 'user_memory.json'),
  chatLogFile: path.join(DATA_ROOT, 'group_chats.json'),
  configRoot: CONFIG_ROOT,
  dataRoot: DATA_ROOT,
  adminBackupDir: ADMIN_BACKUP_DIR,
  adminAuditFile: path.join(LOG_ROOT, 'admin-audit.log'),
  memoryProfileFile: MEMORY_PROFILE_FILE,
  changelogFile: path.join(ROOT, 'CHANGELOG.md'),
  mimoKey: _readKey('.env_mimo', 'MiMo API'),
  dsKey: _readKey('.env_ds', 'DeepSeek API'),
  tavilyKey: _readKey('.env_tavily', 'Tavily Search'),
  doubaoKey: _readKey('.env_doubao', 'Doubao Vision'),
  logDir: LOG_ROOT,
};

export const LONG_GROUPS = readLongGroups();
