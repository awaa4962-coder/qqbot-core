// bridge/clients/auth.mjs — Authorization helpers

export function buildBearerAuth(apiKey) {
  const key = String(apiKey || '').trim();
  if (!key) throw new Error('missing api key');
  return `Bearer ${key}`;
}

export function maskSecret(apiKey) {
  const key = String(apiKey || '');
  if (!key) return '<empty>';
  if (key.length <= 8) return '****';
  return `${key.slice(0, 4)}****${key.slice(-4)}`;
}
