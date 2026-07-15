import crypto from 'crypto';
import { query } from './db.js';

const STORAGE_KEY = 'qwen_chat_settings';

export const QWEN_VALUE_KEYS = Object.freeze([
  'QWEN_LOGIN_URL',
  'QWEN_27B_BASE_URL',
  'QWEN_35B_BASE_URL',
  'QWEN_27B_MODEL',
  'QWEN_35B_MODEL',
  'QWEN_REQUEST_TIMEOUT_MS'
]);

export const QWEN_SECRET_KEYS = Object.freeze([
  'QWEN_PLATFORM_LOGIN',
  'QWEN_PLATFORM_PASSWORD',
  'QWEN_API_KEY',
  'QWEN_AIP_TOKEN',
  'QWEN_AIP_REFRESH_TOKEN'
]);

const DEFAULTS = Object.freeze({
  QWEN_LOGIN_URL: 'https://aiplatform.mos.ru/app_login',
  QWEN_27B_BASE_URL: 'https://models.aiplatform.mos.ru/operation/openqwen/model-v43/v1',
  QWEN_35B_BASE_URL: 'https://models.aiplatform.mos.ru/operation/openqwen/model-v41/v1',
  QWEN_27B_MODEL: 'local_huggingface/Qwen3.6-27B',
  QWEN_35B_MODEL: 'local_huggingface/Qwen3.6-35B-A3B',
  QWEN_REQUEST_TIMEOUT_MS: '2400000'
});

let stored = { values: {}, secrets: {} };

function envValue(key) {
  if (Object.hasOwn(DEFAULTS, key)) return process.env[key] || DEFAULTS[key];
  if (key === 'QWEN_API_KEY') return process.env.QWEN_API_KEY || 'token-abc123';
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
  for (const key of QWEN_VALUE_KEYS) if (value.values?.[key] != null) values[key] = String(value.values[key]);
  for (const key of QWEN_SECRET_KEYS) if (value.secrets?.[key]) secrets[key] = value.secrets[key];
  return { values, secrets };
}

export async function loadQwenSettings() {
  const { rows } = await query('SELECT value FROM kv WHERE key = $1', [STORAGE_KEY]);
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
  if (url.protocol !== 'https:' && url.hostname !== 'localhost') throw new Error(`${key} must use HTTPS`);
  return value.replace(/\/$/, '');
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

  await query(
    `INSERT INTO kv (key, value) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [STORAGE_KEY, JSON.stringify(next)]
  );
  stored = next;
  return getAdminQwenSettings();
}
