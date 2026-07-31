import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildBearerAuth, maskSecret } from '../bridge/clients/auth.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const HEALTH_URL = process.env.QQFRIEND_HEALTH_URL || 'http://127.0.0.1:16789/health';
const allowMissingEnv = process.argv.includes('--allow-missing-env');

let failed = false;

function ok(message) {
  console.log('[ok] ' + message);
}

function info(message) {
  console.log('[info] ' + message);
}

function fail(message) {
  failed = true;
  console.log('[fail] ' + message);
}

function readSecretFile(filename) {
  const filePath = path.join(ROOT, filename);
  if (!fs.existsSync(filePath)) {
    if (allowMissingEnv) {
      info(filename + ' missing (allowed in CI mode)');
      return null;
    }
    fail(filename + ' missing');
    return null;
  }
  ok(filename + ' exists');

  const value = fs.readFileSync(filePath, 'utf-8').trim();
  if (!value) {
    fail(filename + ' is empty');
    return null;
  }
  ok(filename + ' is non-empty');
  return value;
}

function checkAuthHeader(label, apiKey) {
  if (!apiKey) return;
  try {
    const auth = buildBearerAuth(apiKey);
    if (!auth.startsWith('Bearer ')) {
      fail(label + ' auth header does not start with Bearer');
      return;
    }
    ok(label + ' auth header format: Bearer ' + maskSecret(apiKey));

    if (auth.includes('****')) {
      fail(label + ' real Authorization header contains masked characters');
      return;
    }
    ok(label + ' real Authorization header does not contain ****');
  } catch (e) {
    fail(label + ' auth header error: ' + e.message);
  }
}

function checkProxyEnv(name) {
  const value = process.env[name];
  info(name + ': ' + (value ? 'set' : 'not set'));
}

async function checkHealth() {
  try {
    const r = await fetch(HEALTH_URL, { signal: AbortSignal.timeout(3000) });
    if (!r.ok) {
      info('health: HTTP ' + r.status);
      return;
    }
    const data = await r.json().catch(function() { return null; });
    if (data?.status === 'ok') ok('health: ok');
    else info('health: reachable but status is not ok');
  } catch (e) {
    info('health: unavailable (' + e.message + ')');
  }
}

const mimoKey = readSecretFile('.env_mimo');
const dsKey = readSecretFile('.env_ds');

checkAuthHeader('MiMo', mimoKey);
checkAuthHeader('DeepSeek', dsKey);

checkProxyEnv('HTTP_PROXY');
checkProxyEnv('HTTPS_PROXY');
checkProxyEnv('ALL_PROXY');

await checkHealth();

if (failed) {
  process.exitCode = 1;
}
