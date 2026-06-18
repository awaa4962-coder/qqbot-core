// bridge/config.mjs — 全局配置
// 所有文件路径基于 ROOT（工作区根目录），而非本模块所在的 bridge/ 子目录
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

function _readKey(filename, label) {
  const p = path.join(ROOT, filename);
  try {
    return fs.readFileSync(p, 'utf-8').trim();
  } catch (e) {
    console.error('[config] 缺少密钥文件: ' + p + ' (' + label + ')');
    console.error('[config] 请确认 ' + filename + ' 存在且可读');
    process.exit(1);
  }
}

export const CFG = {
  napcatApi: 'http://127.0.0.1:6700',
  listenPort: 16789,
  selfUin: 3793063700,
  groupWhitelist: [1105126214, 807854486, 726305743, 686715443],
  botBlacklist: [3514543114],
  friendWhitelist: [3599026431, 475590364],
  memoryFile: path.join(ROOT, 'user_memory.json'),
  chatLogFile: path.join(ROOT, 'group_chats.json'),
  changelogFile: path.join(ROOT, 'CHANGELOG.md'),
  mimoKey: _readKey('.env_mimo', 'MiMo API'),
  dsKey: _readKey('.env_ds', 'DeepSeek API'),
  tavilyKey: _readKey('.env_tavily', 'Tavily Search'),
  doubaoKey: _readKey('.env_doubao', 'Doubao Vision'),
  logDir: path.join(ROOT, 'logs'),
};

export const LONG_GROUPS = ['726305743', '686715443'];
