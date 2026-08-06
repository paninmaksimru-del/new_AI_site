import crypto from 'crypto';

const STORAGE_KEY = 'qwen_chat_settings';

async function databaseQuery(sql, params = []) {
  const { query } = await import('./db.js');
  return query(sql, params);
}

export const QWEN_VALUE_KEYS = Object.freeze([
  'QWEN_27B_BASE_URL',
  'QWEN_35B_BASE_URL',
  'QWEN_27B_MODEL',
  'QWEN_35B_MODEL',
  'QWEN_REQUEST_TIMEOUT_MS'
]);

export const QWEN_SECRET_KEYS = Object.freeze([
  'QWEN_PROXY_TOKEN'
]);

const DEFAULTS = Object.freeze({
  QWEN_27B_BASE_URL: 'https://i.moscow/api/dit/proxy/operation/openqwen/model-v43/v1',
  QWEN_35B_BASE_URL: 'https://i.moscow/api/dit/proxy/operation/openqwen/model-v41/v1',
  QWEN_27B_MODEL: 'local_huggingface/Qwen3.6-27B',
  QWEN_35B_MODEL: 'local_huggingface/Qwen3.6-35B-A3B',
  QWEN_REQUEST_TIMEOUT_MS: '2400000'
});

let stored = { values: {}, secrets: {} };

function envValue(key) {
  if (Object.hasOwn(DEFAULTS, key)) {
    const value = process.env[key] || DEFAULTS[key];
    if (key.endsWith('_BASE_URL')) {
      try { return validateUrl(value, key); }
      catch { return DEFAULTS[key]; }
    }
    return value;
  }
  return process.env[key] || '';
}

function encryptionKey() {
  const material = process.env.QWEN_SETTINGS_KEY || process.env.APP_SECRET_KEY || process.env.DATABASE_URL;
  if (!material) throw new Error('QWEN_SETTINGS_KEY, APP_SECRET_KEY or DATABASE_URL is required');
  return crypto.createHash('sha256').update(`mik-qwen-settings:v1:${material}`).digest();
}

function encryptSecret(value) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return {
    version: 1,
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: encrypted.toString('base64')
  };
}

function decryptSecret(payload) {
  if (!payload || payload.version !== 1) return '';
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(payload.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(payload.tag, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(payload.data, 'base64')), decipher.final()]).toString('utf8');
  } catch (error) {
    console.error('Qwen secret could not be decrypted:', error.message);
    return '';
  }
}

function sanitize(value) {
  if (!value || typeof value !== 'object') return { values: {}, secrets: {} };
  const values = {};
  const secrets = {};
  for (const key of QWEN_VALUE_KEYS) {
    if (value.values?.[key] == null) continue;
    const candidate = String(value.values[key]);
    if (key.endsWith('_BASE_URL')) {
      try { values[key] = validateUrl(candidate, key); } catch { /* Ignore legacy non-proxy endpoints. */ }
    } else {
      values[key] = candidate;
    }
  }
  for (const key of QWEN_SECRET_KEYS) if (value.secrets?.[key]) secrets[key] = value.secrets[key];
  return { values, secrets };
}

export async function loadQwenSettings() {
  const { rows } = await databaseQuery('SELECT value FROM kv WHERE key = $1', [STORAGE_KEY]);
  if (!rows[0]?.value) {
    stored = { values: {}, secrets: {} };
    return;
  }
  try {
    stored = sanitize(typeof rows[0].value === 'string' ? JSON.parse(rows[0].value) : rows[0].value);
  } catch (error) {
    console.error('Qwen settings could not be loaded:', error.message);
    stored = { values: {}, secrets: {} };
  }
}

export function getQwenSetting(key) {
  if (QWEN_SECRET_KEYS.includes(key)) return decryptSecret(stored.secrets[key]) || envValue(key);
  if (!QWEN_VALUE_KEYS.includes(key)) return undefined;
  return Object.hasOwn(stored.values, key) ? stored.values[key] : envValue(key);
}

export function getAdminQwenSettings() {
  const values = {};
  const secrets = {};
  const sources = {};
  for (const key of QWEN_VALUE_KEYS) {
    values[key] = getQwenSetting(key);
    sources[key] = Object.hasOwn(stored.values, key) ? 'database' : 'environment';
  }
  for (const key of QWEN_SECRET_KEYS) {
    const savedValue = decryptSecret(stored.secrets[key]);
    const fallback = envValue(key);
    secrets[key] = Boolean(savedValue || fallback);
    sources[key] = savedValue ? 'database' : fallback ? 'environment' : 'empty';
  }
  return { values, secrets, sources };
}

function validateUrl(value, key) {
  let url;
  try { url = new URL(value); } catch { throw new Error(`${key} must be a valid URL`); }
  if (url.origin !== 'https://i.moscow' || url.username || url.password) {
    throw new Error(`${key} must use the https://i.moscow proxy`);
  }
  if (!url.pathname.startsWith('/api/dit/proxy/operation/openqwen/')) {
    throw new Error(`${key} must use the i.moscow OpenQwen proxy path`);
  }
  url.search = '';
  url.hash = '';
  url.pathname = url.pathname.replace(/\/+$/, '');
  return url.toString().replace(/\/$/, '');
}

export async function saveAdminQwenSettings(payload = {}) {
  const next = sanitize(stored);
  const incomingValues = payload.values && typeof payload.values === 'object' ? payload.values : {};
  const incomingSecrets = payload.secrets && typeof payload.secrets === 'object' ? payload.secrets : {};
  const clearSecrets = new Set(Array.isArray(payload.clear_secrets) ? payload.clear_secrets : []);

  for (const key of QWEN_VALUE_KEYS) {
    if (!Object.hasOwn(incomingValues, key)) continue;
    let value = String(incomingValues[key] ?? '').trim();
    if (!value) value = DEFAULTS[key] || '';
    if (key.endsWith('_URL')) value = validateUrl(value, key);
    if (key === 'QWEN_REQUEST_TIMEOUT_MS') {
      const timeout = Number(value);
      if (!Number.isInteger(timeout) || timeout < 1000 || timeout > 2400000) throw new Error('QWEN_REQUEST_TIMEOUT_MS must be between 1000 and 2400000');
      value = String(timeout);
    }
    next.values[key] = value;
  }

  for (const key of QWEN_SECRET_KEYS) {
    if (clearSecrets.has(key)) {
      delete next.secrets[key];
      continue;
    }
    const value = String(incomingSecrets[key] ?? '').trim();
    if (value) next.secrets[key] = encryptSecret(value);
  }

  await databaseQuery(
    `INSERT INTO kv (key, value) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [STORAGE_KEY, JSON.stringify(next)]
  );
  stored = next;
  return getAdminQwenSettings();
}
