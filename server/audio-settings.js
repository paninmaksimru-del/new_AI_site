import crypto from 'crypto';
import { query } from './db.js';

const STORAGE_KEY = 'audio_text_assistant_settings';

export const AUDIO_SETTING_KEYS = Object.freeze([
  'IMOSCOW_MOCK_MODE',
  'IMOSCOW_PROXY_TOKEN',
  'IMOSCOW_PHPSESSID',
  'IMOSCOW_SESSION_COOKIE',
  'TRANSCRIPTION_PROXY_CONTRACT_VERIFIED',
  'SUMMARIZER_PROXY_CONTRACT_VERIFIED',
  'AUTH_MODE',
  'APP_ENV',
  'AUDIO_TEXT_ASSISTANT_SETUP_MODE'
]);

export const AUDIO_SECRET_KEYS = Object.freeze([
  'IMOSCOW_PROXY_TOKEN',
  'IMOSCOW_PHPSESSID',
  'IMOSCOW_SESSION_COOKIE'
]);

const SECRET_SET = new Set(AUDIO_SECRET_KEYS);
const BOOLEAN_SET = new Set([
  'IMOSCOW_MOCK_MODE',
  'TRANSCRIPTION_PROXY_CONTRACT_VERIFIED',
  'SUMMARIZER_PROXY_CONTRACT_VERIFIED'
]);

let stored = { values: {}, secrets: {} };

function envValue(key) {
  if (key === 'IMOSCOW_MOCK_MODE') return process.env.IMOSCOW_MOCK_MODE ?? process.env.AUDIO_ASSISTANT_MOCK_MODE ?? 'true';
  if (key === 'APP_ENV') return process.env.APP_ENV ?? process.env.NODE_ENV ?? 'development';
  if (key === 'AUTH_MODE') return process.env.AUTH_MODE ?? 'reverse_proxy';
  if (key === 'AUDIO_TEXT_ASSISTANT_SETUP_MODE') return process.env.AUDIO_TEXT_ASSISTANT_SETUP_MODE ?? 'portal';
  return process.env[key] ?? '';
}

function encryptionKey() {
  const material = process.env.AUDIO_ASSISTANT_SETTINGS_KEY || process.env.APP_SECRET_KEY || process.env.DATABASE_URL;
  if (!material) throw new Error('AUDIO_ASSISTANT_SETTINGS_KEY or DATABASE_URL is required to protect audio assistant secrets');
  return crypto.createHash('sha256').update(`mik-audio-settings:v1:${material}`).digest();
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
    console.error('Audio assistant secret could not be decrypted:', error.message);
    return '';
  }
}

function normalizeBoolean(value, key) {
  const normalized = String(value).trim().toLowerCase();
  if (!['true', 'false'].includes(normalized)) throw new Error(`${key} must be true or false`);
  return normalized;
}

function sanitizeStored(value) {
  if (!value || typeof value !== 'object') return { values: {}, secrets: {} };
  const values = {};
  const secrets = {};
  for (const key of AUDIO_SETTING_KEYS) {
    if (!SECRET_SET.has(key) && value.values?.[key] != null) values[key] = String(value.values[key]);
    if (SECRET_SET.has(key) && value.secrets?.[key]) secrets[key] = value.secrets[key];
  }
  return { values, secrets };
}

export async function loadAudioSettings() {
  const { rows } = await query('SELECT value FROM kv WHERE key = $1', [STORAGE_KEY]);
  if (!rows[0]?.value) {
    stored = { values: {}, secrets: {} };
    return;
  }
  try {
    const parsed = typeof rows[0].value === 'string' ? JSON.parse(rows[0].value) : rows[0].value;
    stored = sanitizeStored(parsed);
  } catch (error) {
    console.error('Audio assistant settings could not be loaded:', error.message);
    stored = { values: {}, secrets: {} };
  }
}

export function getAudioSetting(key) {
  if (!AUDIO_SETTING_KEYS.includes(key)) return undefined;
  if (SECRET_SET.has(key)) return decryptSecret(stored.secrets[key]) || envValue(key);
  return Object.hasOwn(stored.values, key) ? stored.values[key] : envValue(key);
}

export function getAdminAudioSettings() {
  const values = {};
  const secrets = {};
  const sources = {};
  for (const key of AUDIO_SETTING_KEYS) {
    if (SECRET_SET.has(key)) {
      const savedValue = decryptSecret(stored.secrets[key]);
      const envConfigured = Boolean(envValue(key));
      secrets[key] = Boolean(savedValue || envConfigured);
      sources[key] = savedValue ? 'database' : envConfigured ? 'environment' : 'empty';
    } else {
      values[key] = getAudioSetting(key);
      sources[key] = Object.hasOwn(stored.values, key) ? 'database' : 'environment';
    }
  }
  return { values, secrets, sources };
}

export async function saveAdminAudioSettings(payload = {}) {
  const next = sanitizeStored(stored);
  const incomingValues = payload.values && typeof payload.values === 'object' ? payload.values : {};
  const incomingSecrets = payload.secrets && typeof payload.secrets === 'object' ? payload.secrets : {};
  const clearSecrets = new Set(Array.isArray(payload.clear_secrets) ? payload.clear_secrets : []);

  for (const key of AUDIO_SETTING_KEYS) {
    if (SECRET_SET.has(key)) continue;
    if (!Object.hasOwn(incomingValues, key)) continue;
    let value = String(incomingValues[key] ?? '').trim();
    if (BOOLEAN_SET.has(key)) value = normalizeBoolean(value, key);
    if (key === 'AUTH_MODE' && !['dev', 'reverse_proxy'].includes(value)) throw new Error('AUTH_MODE must be dev or reverse_proxy');
    if (key === 'APP_ENV' && !['development', 'staging', 'production', 'dev'].includes(value)) throw new Error('APP_ENV must be development, staging or production');
    next.values[key] = value;
  }

  for (const key of AUDIO_SECRET_KEYS) {
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
  return getAdminAudioSettings();
}
