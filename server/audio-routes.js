import crypto from 'crypto';
import { execFile } from 'child_process';
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import multer from 'multer';
import { tmpdir } from 'os';
import { extname, join } from 'path';
import { promisify } from 'util';
import { query } from './db.js';
import { requireAdmin, requireKbAuth } from './auth.js';
import { getAdminAudioSettings, getAudioSetting, loadAudioSettings, saveAdminAudioSettings } from './audio-settings.js';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 200 * 1024 * 1024, files: 1 }
});

const progressById = new Map();
const execFileAsync = promisify(execFile);
const DIRECT_MEDIA_TYPES = new Set(['audio/wav', 'audio/x-wav', 'audio/mpeg', 'audio/mp4', 'audio/aac', 'audio/ogg', 'audio/webm', 'audio/flac', 'video/mp4', 'video/webm']);
const TASK_PROMPTS = {
  default: 'Сгенерируй краткое информативное резюме текста.',
  extractive: 'Выдели ключевые предложения из исходного текста.',
  abstractive: 'Кратко перескажи текст своими словами в 3-5 предложениях.'
};
const MOCK_TRANSCRIPT = 'Это тестовая расшифровка аудиозаписи. Mock-режим не отправляет аудио во внешний сервис и нужен для проверки локального workflow.';

function mockMode() {
  return String(getAudioSetting('IMOSCOW_MOCK_MODE') ?? 'true').toLowerCase() !== 'false';
}

function apiError(res, status, code, message, details) {
  return res.status(status).json({ error: { code, message }, ...(details ? { details } : {}) });
}

function parseJson(value, fallback) {
  if (value == null) return fallback;
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch { return fallback; }
}

function asIso(value) {
  return value instanceof Date ? value.toISOString() : value;
}

function publicSummary(row) {
  return {
    id: row.id,
    task_type: row.task_type,
    text_chars: Number(row.text_chars),
    status: row.status,
    created_at: asIso(row.created_at),
    source_transcription_id: row.source_transcription_id || null
  };
}

async function summariesForTranscription(id, userId) {
  const { rows } = await query(
    `SELECT id, task_type, text_chars, status, created_at, source_transcription_id
       FROM audio_summaries
      WHERE source_transcription_id = $1 AND user_id = $2
      ORDER BY created_at DESC`,
    [id, userId]
  );
  return rows.map(publicSummary);
}

async function publicTranscription(row, userId) {
  return {
    id: row.id,
    status: row.status,
    created_at: asIso(row.created_at),
    updated_at: asIso(row.updated_at),
    completed_at: asIso(row.completed_at),
    parameters: parseJson(row.parameters, {}),
    audio_sha256: row.audio_sha256,
    audio_media_type: row.audio_media_type,
    audio_size_bytes: Number(row.audio_size_bytes),
    original_filename: row.original_filename,
    transcript: row.transcript || '',
    detected_language: row.detected_language || null,
    segments: parseJson(row.segments, []),
    error: row.error_code ? { code: row.error_code, message: row.error_message || 'Ошибка транскрибации.' } : null,
    summaries: await summariesForTranscription(row.id, userId)
  };
}

function textFromUnknown(value) {
  if (typeof value === 'string') return value.trim();
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = textFromUnknown(item);
      if (found) return found;
    }
  }
  if (value && typeof value === 'object') {
    for (const key of ['answer', 'summary', 'transcript', 'text', 'result_text', 'output_text']) {
      const found = textFromUnknown(value[key]);
      if (found) return found;
    }
    for (const key of ['predictions', 'prediction', 'result', 'results', 'output', 'outputs', 'data']) {
      const found = textFromUnknown(value[key]);
      if (found) return found;
    }
  }
  return '';
}

function explanationFromUnknown(value) {
  if (!value || typeof value !== 'object') return '';
  for (const key of ['explain', 'explanation', 'reasoning']) {
    if (typeof value[key] === 'string') return value[key].trim();
  }
  for (const key of ['predictions', 'prediction', 'result', 'results', 'output', 'outputs', 'data']) {
    const found = explanationFromUnknown(value[key]);
    if (found) return found;
  }
  return '';
}

async function responseBody(response) {
  const text = await response.text();
  if (!text) return {};
  try { return JSON.parse(text); } catch { return { text }; }
}

function safeExternalUrl(url) {
  const safe = new URL(url);
  safe.search = '';
  return safe.toString();
}

function redactLogString(value) {
  return String(value)
    .replace(/([?&]token=)[^&\s]+/gi, '$1[REDACTED]')
    .replace(/(PHPSESSID=)[^;\s]+/gi, '$1[REDACTED]')
    .replace(/(session-cookie=)[^;\s]+/gi, '$1[REDACTED]')
    .replace(/(Bearer\s+)[A-Za-z0-9._~+\/-]+/gi, '$1[REDACTED]')
    .slice(0, 12000);
}

function redactLogValue(value, depth = 0) {
  if (depth > 8) return '[MAX_DEPTH]';
  if (typeof value === 'string') return redactLogString(value);
  if (Array.isArray(value)) return value.slice(0, 100).map(item => redactLogValue(item, depth + 1));
  if (value && typeof value === 'object') {
    const output = {};
    for (const [key, item] of Object.entries(value)) {
      if (/token|cookie|session|authorization|phpsessid|secret/i.test(key)) output[key] = '[REDACTED]';
      else output[key] = redactLogValue(item, depth + 1);
    }
    return output;
  }
  return value;
}

function safeResponseHeaders(response) {
  const output = {};
  for (const name of ['content-type', 'content-length', 'x-request-id', 'x-correlation-id', 'date', 'server']) {
    const value = response.headers.get(name);
    if (value) output[name] = redactLogString(value);
  }
  return output;
}

function responseForLog(body, ok) {
  if (!ok) return redactLogValue(body);
  if (!body || typeof body !== 'object') return { kind: typeof body };
  const output = {};
  for (const key of ['id', 'job_id', 'task_id', 'status', 'code', 'message', 'detail']) {
    if (body[key] != null) output[key] = redactLogValue(body[key]);
  }
  return output;
}

async function recordExternalLog(entry) {
  const safeEntry = {
    request_id: entry.request_id,
    user_id: entry.user_id || null,
    transcription_id: entry.transcription_id || null,
    operation: entry.operation,
    method: entry.method,
    url: safeExternalUrl(entry.url),
    request_meta: redactLogValue(entry.request_meta || {}),
    response_status: entry.response_status || null,
    response_headers: redactLogValue(entry.response_headers || {}),
    response_body: redactLogValue(entry.response_body || {}),
    error_code: entry.error_code || null,
    duration_ms: entry.duration_ms
  };
  const consoleMethod = safeEntry.response_status && safeEntry.response_status < 400 && !safeEntry.error_code ? 'info' : 'warn';
  console[consoleMethod]('[audio-assistant.external]', JSON.stringify(safeEntry));
  try {
    await query(
      `INSERT INTO audio_external_logs
        (request_id, user_id, transcription_id, operation, method, url, request_meta, response_status, response_headers, response_body, error_code, duration_ms)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [safeEntry.request_id, safeEntry.user_id, safeEntry.transcription_id, safeEntry.operation, safeEntry.method, safeEntry.url, JSON.stringify(safeEntry.request_meta), safeEntry.response_status, JSON.stringify(safeEntry.response_headers), JSON.stringify(safeEntry.response_body), safeEntry.error_code, safeEntry.duration_ms]
    );
    await query(`DELETE FROM audio_external_logs WHERE id NOT IN (SELECT id FROM audio_external_logs ORDER BY id DESC LIMIT 500)`);
  } catch (error) {
    console.warn('[audio-assistant.external-log-failed]', error.message);
  }
}

async function externalFetch({ operation, url, method, headers, body, timeoutMs, requestMeta, context = {} }) {
  const requestId = crypto.randomUUID();
  const started = Date.now();
  try {
    const response = await fetch(url, { method, headers, body, signal: AbortSignal.timeout(timeoutMs) });
    const parsedBody = await responseBody(response);
    await recordExternalLog({
      request_id: requestId,
      ...context,
      operation,
      method,
      url,
      request_meta: requestMeta,
      response_status: response.status,
      response_headers: safeResponseHeaders(response),
      response_body: responseForLog(parsedBody, response.ok),
      duration_ms: Date.now() - started
    });
    return { response, body: parsedBody, requestId };
  } catch (error) {
    await recordExternalLog({
      request_id: requestId,
      ...context,
      operation,
      method,
      url,
      request_meta: requestMeta,
      error_code: error.name || 'transport_error',
      response_body: { message: redactLogString(error.message) },
      duration_ms: Date.now() - started
    });
    error.details = { ...(error.details || {}), request_id: requestId };
    throw error;
  }
}

function iMoscowUrl(suffix = '') {
  const base = (process.env.IMOSCOW_BASE_URL || 'https://i.moscow').replace(/\/$/, '');
  const operation = (process.env.IMOSCOW_TRANSCRIPTION_OPERATION_PATH || '/api/dit/proxy/operation/voice-log-server').replace(/^\/?/, '/').replace(/\/$/, '');
  const token = getAudioSetting('IMOSCOW_PROXY_TOKEN') || '';
  const url = new URL(`${base}${operation}/${suffix}`.replace(/\/$/, ''));
  if (token) url.searchParams.set('token', token);
  return url;
}

function iMoscowHeaders(extra = {}) {
  const phpsessid = getAudioSetting('IMOSCOW_PHPSESSID') || '';
  const session = getAudioSetting('IMOSCOW_SESSION_COOKIE') || '';
  const cookie = [phpsessid && `PHPSESSID=${phpsessid}`, session && `session-cookie=${session}`].filter(Boolean).join('; ');
  return { ...(cookie ? { Cookie: cookie } : {}), ...extra };
}

function ensureRealModeConfigured(kind) {
  const verifiedName = kind === 'summary' ? 'SUMMARIZER_PROXY_CONTRACT_VERIFIED' : 'TRANSCRIPTION_PROXY_CONTRACT_VERIFIED';
  if (String(getAudioSetting(verifiedName) || '').toLowerCase() !== 'true') {
    const error = new Error('Контракт внешнего сервиса требует проверки перед реальным запросом.');
    error.code = 'external_contract_unverified'; error.status = 503; throw error;
  }
  for (const name of ['IMOSCOW_PROXY_TOKEN', 'IMOSCOW_PHPSESSID', 'IMOSCOW_SESSION_COOKIE']) {
    if (!getAudioSetting(name)) {
      const error = new Error('Не настроены учетные данные внешнего сервиса.');
      error.code = 'external_auth_failed'; error.status = 503; throw error;
    }
  }
}

async function prepareMedia(file) {
  const sourceType = String(file.mimetype || 'application/octet-stream').toLowerCase();
  if (DIRECT_MEDIA_TYPES.has(sourceType) || mockMode()) {
    return { ...file, converted: false, sourceType, sourceSize: file.size };
  }
  const extension = extname(file.originalname || '').toLowerCase() || '.bin';
  const workDir = await mkdtemp(join(tmpdir(), 'audio-assistant-'));
  const inputPath = join(workDir, `input${extension}`);
  const outputPath = join(workDir, 'output.mp3');
  try {
    await writeFile(inputPath, file.buffer);
    await execFileAsync(process.env.FFMPEG_PATH || 'ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', inputPath, '-vn', '-codec:a', 'libmp3lame', '-b:a', process.env.AUDIO_ASSISTANT_BITRATE || '64k', outputPath], { timeout: Number(process.env.AUDIO_ASSISTANT_CONVERSION_TIMEOUT_MS) || 600000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
    const buffer = await readFile(outputPath);
    return { ...file, buffer, size: buffer.length, mimetype: 'audio/mpeg', originalname: `${String(file.originalname || 'audio').replace(/\.[^.]+$/, '')}.mp3`, converted: true, sourceType, sourceSize: file.size };
  } catch (error) {
    const wrapped = new Error('Не удалось преобразовать медиафайл. Проверьте формат записи.');
    wrapped.code = error.code === 'ENOENT' ? 'ffmpeg_unavailable' : 'media_conversion_failed';
    wrapped.status = 422;
    throw wrapped;
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

function findJobId(body) {
  if (!body || typeof body !== 'object') return null;
  for (const key of ['job_id', 'task_id', 'id']) if (typeof body[key] === 'string' || typeof body[key] === 'number') return String(body[key]);
  for (const key of ['data', 'result', 'prediction']) {
    const found = findJobId(body[key]);
    if (found) return found;
  }
  return null;
}

function normalizedSegments(body) {
  const candidates = [body?.segments, body?.result?.segments, body?.data?.segments].find(Array.isArray) || [];
  return candidates.map(item => ({
    text: String(item?.text || item?.transcript || '').trim(),
    start_seconds: Number.isFinite(Number(item?.start_seconds ?? item?.start)) ? Number(item.start_seconds ?? item.start) : null,
    end_seconds: Number.isFinite(Number(item?.end_seconds ?? item?.end)) ? Number(item.end_seconds ?? item.end) : null,
    speaker: item?.speaker ? String(item.speaker) : null
  })).filter(item => item.text);
}

async function submitTranscription(file, context = {}) {
  ensureRealModeConfigured('transcription');
  const form = new FormData();
  const fieldName = process.env.IMOSCOW_UPLOAD_FIELD || 'file';
  form.append(fieldName, new Blob([file.buffer], { type: file.mimetype || 'application/octet-stream' }), file.originalname || 'audio');
  const method = process.env.IMOSCOW_UPLOAD_METHOD || 'POST';
  const url = iMoscowUrl('upload');
  const { response, body, requestId } = await externalFetch({
    operation: 'transcription.upload',
    url,
    method,
    headers: iMoscowHeaders(),
    body: form,
    timeoutMs: Number(process.env.IMOSCOW_TIMEOUT_MS) || 300000,
    requestMeta: { multipart_field: fieldName, filename: file.originalname || 'audio', content_type: file.mimetype || 'application/octet-stream', size_bytes: file.size, sha256_prefix: crypto.createHash('sha256').update(file.buffer).digest('hex').slice(0, 16) },
    context
  });
  if (!response.ok) throw Object.assign(new Error('Внешний сервис отклонил аудиофайл.'), { code: 'external_unavailable', status: 502, details: { external_status: response.status, request_id: requestId } });
  const transcript = textFromUnknown(body);
  if (transcript) return { status: 'completed', transcript, language: body.language || body.detected_language || null, segments: normalizedSegments(body) };
  const jobId = findJobId(body);
  if (!jobId) throw Object.assign(new Error('Внешний сервис не вернул идентификатор задачи.'), { code: 'unknown_external_response', status: 502 });
  return { status: 'processing', jobId };
}

async function pollExternalTranscription(jobId) {
  ensureRealModeConfigured('transcription');
  const statusResponse = await fetch(iMoscowUrl(`process/${encodeURIComponent(jobId)}`), { method: process.env.IMOSCOW_STATUS_METHOD || 'GET', headers: iMoscowHeaders(), signal: AbortSignal.timeout(Number(process.env.IMOSCOW_TIMEOUT_MS) || 300000) });
  const statusBody = await responseBody(statusResponse);
  if (!statusResponse.ok) throw Object.assign(new Error('Не удалось получить статус обработки.'), { code: 'external_unavailable', status: 502 });
  const externalStatus = String(statusBody.status || statusBody.data?.status || '').toLowerCase();
  if (['created', 'pending', 'processing', 'running', 'queued', ''].includes(externalStatus)) return { status: 'processing' };
  if (['failed', 'error', 'cancelled'].includes(externalStatus)) throw Object.assign(new Error('Внешний сервис не смог обработать файл.'), { code: 'external_processing_failed', status: 502 });
  const resultResponse = await fetch(iMoscowUrl(`result/${encodeURIComponent(jobId)}`), { method: process.env.IMOSCOW_RESULT_METHOD || 'GET', headers: iMoscowHeaders(), signal: AbortSignal.timeout(Number(process.env.IMOSCOW_TIMEOUT_MS) || 300000) });
  const resultBody = await responseBody(resultResponse);
  if (!resultResponse.ok) throw Object.assign(new Error('Не удалось получить результат обработки.'), { code: 'external_unavailable', status: 502 });
  const transcript = textFromUnknown(resultBody);
  if (!transcript) throw Object.assign(new Error('Внешний сервис вернул результат неизвестного формата.'), { code: 'unknown_external_response', status: 502 });
  return { status: 'completed', transcript, language: resultBody.language || resultBody.detected_language || null, segments: normalizedSegments(resultBody) };
}

function splitSentences(text) {
  return text.split(/(?<=[.!?])\s+/u).map(part => part.trim()).filter(Boolean);
}

function mockSummary(text, taskType) {
  const sentences = splitSentences(text);
  const first = sentences[0] || text.slice(0, 300);
  if (taskType === 'extractive') return { answer: sentences.slice(0, 5).map(sentence => `- ${sentence}`).join('\n'), explain: 'Выбраны первые содержательные предложения mock-текста.' };
  if (taskType === 'abstractive') return { answer: `Текст описывает: ${first.slice(0, 300)}`, explain: 'Mock-режим формирует короткий пересказ без внешнего запроса.' };
  return { answer: sentences.slice(0, 3).join(' ') || text.slice(0, 900), explain: 'Mock-режим вернул краткое содержание без обращения к внешнему сервису.' };
}

async function realSummary(payload) {
  ensureRealModeConfigured('summary');
  const base = process.env.IMOSCOW_SUMMARIZER_PROXY_URL || 'https://i.moscow/api/dit/proxy/operation/structurizer/invocations';
  const url = new URL(base);
  url.searchParams.set('token', getAudioSetting('IMOSCOW_PROXY_TOKEN'));
  const body = {
    id: payload.request_id || 'AudioTextAssistant_Service',
    route: payload.route || 'structuring',
    data_route: {
      dataframe_records: '',
      text: payload.text,
      task: payload.task || TASK_PROMPTS[payload.task_type] || TASK_PROMPTS.default,
      user_prompt: payload.user_prompt || '',
      kwargs: { temperature: Number(payload.temperature ?? 0), max_tokens: Number(payload.max_tokens ?? 800) }
    }
  };
  const response = await fetch(url, { method: process.env.IMOSCOW_SUMMARIZER_METHOD || 'POST', headers: iMoscowHeaders({ 'Content-Type': 'application/json' }), body: JSON.stringify(body), signal: AbortSignal.timeout(Number(process.env.IMOSCOW_SUMMARIZER_TIMEOUT_MS) || 90000) });
  const raw = await responseBody(response);
  if (!response.ok) throw Object.assign(new Error('Внешний сервис суммаризации вернул ошибку.'), { code: 'external_error', status: response.status === 400 ? 400 : 502, details: { external_status: response.status } });
  const answer = textFromUnknown(raw);
  if (!answer) throw Object.assign(new Error('Ответ получен, но формат результата не распознан.'), { code: 'invalid_external_response', status: 502 });
  return { answer, explain: explanationFromUnknown(raw) };
}

function xmlEscape(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

let crcTable;
function crc32(buffer) {
  if (!crcTable) crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k += 1) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1); return c >>> 0; });
  let crc = 0xffffffff;
  for (const byte of buffer) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function zipStore(entries) {
  const local = [], central = [];
  let offset = 0;
  for (const [filename, value] of entries) {
    const name = Buffer.from(filename);
    const data = Buffer.isBuffer(value) ? value : Buffer.from(value);
    const crc = crc32(data);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0); header.writeUInt16LE(20, 4); header.writeUInt16LE(0x0800, 6); header.writeUInt16LE(0, 8); header.writeUInt32LE(crc, 14); header.writeUInt32LE(data.length, 18); header.writeUInt32LE(data.length, 22); header.writeUInt16LE(name.length, 26);
    local.push(header, name, data);
    const directory = Buffer.alloc(46);
    directory.writeUInt32LE(0x02014b50, 0); directory.writeUInt16LE(20, 4); directory.writeUInt16LE(20, 6); directory.writeUInt16LE(0x0800, 8); directory.writeUInt16LE(0, 10); directory.writeUInt32LE(crc, 16); directory.writeUInt32LE(data.length, 20); directory.writeUInt32LE(data.length, 24); directory.writeUInt16LE(name.length, 28); directory.writeUInt32LE(offset, 42);
    central.push(directory, name);
    offset += header.length + name.length + data.length;
  }
  const centralBuffer = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(centralBuffer.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, centralBuffer, end]);
}

function buildDocx(filename, transcript, segments) {
  const lines = [`Расшифровка`, `Исходный файл: ${filename}`, ''];
  if (segments.length) for (const segment of segments) lines.push(`${segment.speaker ? `${segment.speaker}: ` : ''}${segment.text}`);
  else lines.push(transcript);
  const paragraphs = lines.map(line => `<w:p><w:r><w:t xml:space="preserve">${xmlEscape(line)}</w:t></w:r></w:p>`).join('');
  return zipStore([
    ['[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'],
    ['_rels/.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'],
    ['word/document.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paragraphs}<w:sectPr/></w:body></w:document>`]
  ]);
}

function formatTime(value) {
  if (value == null) return '--:--';
  const total = Math.max(0, Math.floor(Number(value)));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

function exportText(row, markdown = false) {
  const segments = parseJson(row.segments, []);
  const lines = markdown ? ['# Расшифровка', '', `**Исходный файл:** ${row.original_filename}`, ''] : ['РАСШИФРОВКА', `Исходный файл: ${row.original_filename}`, ''];
  if (segments.length) for (const segment of segments) lines.push(`${markdown ? '## ' : ''}[${formatTime(segment.start_seconds)}-${formatTime(segment.end_seconds)}] ${segment.speaker || 'Спикер не указан'}\n${segment.text}\n`);
  else lines.push(row.transcript || '');
  return lines.join('\n').trimEnd() + '\n';
}

async function getOwnedTranscription(id, user) {
  const params = user.role === 'admin' ? [id] : [id, user.id];
  const condition = user.role === 'admin' ? 'id = $1' : 'id = $1 AND user_id = $2';
  const { rows } = await query(`SELECT * FROM audio_transcriptions WHERE ${condition}`, params);
  return rows[0] || null;
}

export async function setupAudioRoutes(app) {
  await loadAudioSettings();
  await query(`
    CREATE TABLE IF NOT EXISTS audio_transcriptions (
      id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      status TEXT NOT NULL,
      parameters JSONB NOT NULL DEFAULT '{}'::jsonb,
      audio_sha256 TEXT NOT NULL,
      audio_media_type TEXT NOT NULL,
      audio_size_bytes BIGINT NOT NULL,
      original_filename TEXT NOT NULL,
      transcript TEXT,
      detected_language TEXT,
      segments JSONB NOT NULL DEFAULT '[]'::jsonb,
      error_code TEXT,
      error_message TEXT,
      external_job_id TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      completed_at TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS idx_audio_transcriptions_user ON audio_transcriptions(user_id, created_at DESC);
    CREATE TABLE IF NOT EXISTS audio_summaries (
      id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      task_type TEXT NOT NULL,
      source_text TEXT NOT NULL,
      text_chars INTEGER NOT NULL,
      answer TEXT NOT NULL,
      explain TEXT,
      status TEXT NOT NULL DEFAULT 'completed',
      source_transcription_id TEXT REFERENCES audio_transcriptions(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_audio_summaries_user ON audio_summaries(user_id, created_at DESC);
    CREATE TABLE IF NOT EXISTS audio_external_logs (
      id BIGSERIAL PRIMARY KEY,
      request_id TEXT NOT NULL UNIQUE,
      user_id INTEGER,
      transcription_id TEXT,
      operation TEXT NOT NULL,
      method TEXT NOT NULL,
      url TEXT NOT NULL,
      request_meta JSONB NOT NULL DEFAULT '{}'::jsonb,
      response_status INTEGER,
      response_headers JSONB NOT NULL DEFAULT '{}'::jsonb,
      response_body TEXT,
      error_code TEXT,
      duration_ms INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_audio_external_logs_created ON audio_external_logs(created_at DESC);
  `);

  const auth = requireKbAuth();

  app.get('/api/admin/audio-assistant-settings', requireAdmin(), (req, res) => {
    res.json(getAdminAudioSettings());
  });

  app.put('/api/admin/audio-assistant-settings', requireAdmin(), async (req, res) => {
    try {
      res.json(await saveAdminAudioSettings(req.body || {}));
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });

  app.get('/api/admin/audio-assistant-logs', requireAdmin(), async (req, res) => {
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 50));
    const { rows } = await query(
      `SELECT request_id, user_id, transcription_id, operation, method, url, request_meta,
              response_status, response_headers, response_body, error_code, duration_ms, created_at
         FROM audio_external_logs
        ORDER BY created_at DESC
        LIMIT $1`,
      [limit]
    );
    res.json(rows.map(row => ({ ...row, response_body: parseJson(row.response_body, row.response_body) })));
  });

  app.get('/api/audio-assistant/health', auth, (req, res) => {
    res.json({
      status: 'ok',
      env: getAudioSetting('APP_ENV'),
      auth_mode: getAudioSetting('AUTH_MODE'),
      setup_mode: getAudioSetting('AUDIO_TEXT_ASSISTANT_SETUP_MODE'),
      mock_mode: mockMode(),
      transcription_real_mode_allowed: !mockMode() && String(getAudioSetting('TRANSCRIPTION_PROXY_CONTRACT_VERIFIED')).toLowerCase() === 'true',
      summarizer_real_mode_allowed: !mockMode() && String(getAudioSetting('SUMMARIZER_PROXY_CONTRACT_VERIFIED')).toLowerCase() === 'true'
    });
  });

  app.post('/api/transcriptions', auth, upload.single('audio'), async (req, res) => {
    if (!req.file?.buffer?.length) return apiError(res, 422, 'validation_error', 'Загрузите непустой аудиофайл.');
    const mediaType = String(req.file.mimetype || 'application/octet-stream').toLowerCase();
    if (!mediaType.startsWith('audio/') && !mediaType.startsWith('video/') && !mockMode()) return apiError(res, 422, 'unsupported_media_type', 'Поддерживаются аудио- и видеофайлы.');
    let media;
    try { media = await prepareMedia(req.file); } catch (error) { return apiError(res, error.status || 422, error.code || 'media_conversion_failed', error.message); }
    const id = crypto.randomUUID();
    const parameters = { language: req.body.language || null, context_hint: req.body.context_hint || null, speaker_labels: req.body.speaker_labels === 'true', timestamp_granularity: req.body.timestamp_granularity === 'segment' ? 'segment' : 'none', converted: media.converted, source_media_type: media.sourceType, source_size_bytes: media.sourceSize };
    if ((parameters.context_hint || '').length > 1000) return apiError(res, 422, 'validation_error', 'Контекстная подсказка слишком длинная.');
    await query(`INSERT INTO audio_transcriptions (id, user_id, status, parameters, audio_sha256, audio_media_type, audio_size_bytes, original_filename) VALUES ($1,$2,'processing',$3,$4,$5,$6,$7)`, [id, req.user.id, JSON.stringify(parameters), crypto.createHash('sha256').update(media.buffer).digest('hex'), media.mimetype, media.size, req.file.originalname || 'audio']);
    try {
      const result = mockMode() ? { status: 'completed', transcript: MOCK_TRANSCRIPT, language: parameters.language || 'ru', segments: parameters.timestamp_granularity === 'segment' ? [{ text: MOCK_TRANSCRIPT, start_seconds: 0, end_seconds: 6, speaker: parameters.speaker_labels ? 'speaker-1' : null }] : [] } : await submitTranscription(media, { user_id: req.user.id, transcription_id: id });
      await query(`UPDATE audio_transcriptions SET status=$2, transcript=$3, detected_language=$4, segments=$5, external_job_id=$6, updated_at=NOW(), completed_at=CASE WHEN $2='completed' THEN NOW() ELSE NULL END WHERE id=$1`, [id, result.status, result.transcript || null, result.language || null, JSON.stringify(result.segments || []), result.jobId || null]);
    } catch (error) {
      const diagnosticMessage = error.details?.request_id ? `${error.message} ID диагностики: ${error.details.request_id}` : error.message;
      await query(`UPDATE audio_transcriptions SET status='failed', error_code=$2, error_message=$3, updated_at=NOW() WHERE id=$1`, [id, error.code || 'processing_failed', diagnosticMessage]);
    }
    const row = await getOwnedTranscription(id, req.user);
    res.status(201).json(await publicTranscription(row, req.user.id));
  });

  app.get('/api/transcriptions', auth, async (req, res) => {
    const { rows } = await query('SELECT * FROM audio_transcriptions WHERE user_id=$1 ORDER BY created_at DESC LIMIT 100', [req.user.id]);
    res.json({ items: await Promise.all(rows.map(row => publicTranscription(row, req.user.id))) });
  });

  app.get('/api/transcriptions/:id', auth, async (req, res) => {
    let row = await getOwnedTranscription(req.params.id, req.user);
    if (!row) return apiError(res, 404, 'not_found', 'Транскрибация не найдена.');
    if (!mockMode() && ['created', 'pending', 'processing'].includes(row.status) && row.external_job_id) {
      try {
        const result = await pollExternalTranscription(row.external_job_id);
        if (result.status === 'completed') await query(`UPDATE audio_transcriptions SET status='completed', transcript=$2, detected_language=$3, segments=$4, updated_at=NOW(), completed_at=NOW() WHERE id=$1`, [row.id, result.transcript, result.language, JSON.stringify(result.segments || [])]);
      } catch (error) {
        await query(`UPDATE audio_transcriptions SET status='failed', error_code=$2, error_message=$3, updated_at=NOW() WHERE id=$1`, [row.id, error.code || 'processing_failed', error.message]);
      }
      row = await getOwnedTranscription(req.params.id, req.user);
    }
    res.json(await publicTranscription(row, req.user.id));
  });

  app.get('/api/transcriptions/:id/download/:format', auth, async (req, res) => {
    const row = await getOwnedTranscription(req.params.id, req.user);
    if (!row) return apiError(res, 404, 'not_found', 'Транскрибация не найдена.');
    if (row.status !== 'completed') return apiError(res, 409, 'not_ready', 'Расшифровка ещё не готова.');
    const format = req.params.format.toLowerCase();
    const stem = String(row.original_filename).replace(/\.[^.]+$/, '').replace(/[^\p{L}\p{N} _.-]/gu, '').trim().slice(0, 80) || `transcription-${row.id.slice(0, 8)}`;
    if (format === 'txt' || format === 'md') {
      res.type(format === 'txt' ? 'text/plain; charset=utf-8' : 'text/markdown; charset=utf-8');
      res.attachment(`${stem}.${format}`); return res.send(exportText(row, format === 'md'));
    }
    if (format === 'docx') {
      res.type('application/vnd.openxmlformats-officedocument.wordprocessingml.document');
      res.attachment(`${stem}.docx`); return res.send(buildDocx(row.original_filename, row.transcript || '', parseJson(row.segments, [])));
    }
    return apiError(res, 422, 'download_format_unsupported', 'Доступны форматы TXT, MD и DOCX.');
  });

  async function createSummary(req, res, sourceTranscriptionId = null) {
    let text = String(req.body?.text || '').trim();
    if (sourceTranscriptionId) {
      const transcription = await getOwnedTranscription(sourceTranscriptionId, req.user);
      if (!transcription) return apiError(res, 404, 'not_found', 'Транскрибация не найдена.');
      text = String(transcription.transcript || '').trim();
    }
    if (!text) return apiError(res, 422, 'validation_error', 'Исходный текст не должен быть пустым.');
    if (text.length > 20000) return apiError(res, 413, 'payload_too_large', 'Текст превышает допустимый размер.');
    const taskType = Object.hasOwn(TASK_PROMPTS, req.body?.task_type) ? req.body.task_type : 'default';
    const progressId = req.body?.progress_id;
    if (progressId) progressById.set(`${req.user.id}:${progressId}`, { status: 'running', stage: 'request', current: 0, total: 1, message: 'Запрос к сервису суммаризации' });
    try {
      const result = mockMode() ? mockSummary(text, taskType) : await realSummary({ ...req.body, text, task_type: taskType });
      const id = crypto.randomUUID();
      await query(`INSERT INTO audio_summaries (id,user_id,task_type,source_text,text_chars,answer,explain,source_transcription_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [id, req.user.id, taskType, text, text.length, result.answer, result.explain || '', sourceTranscriptionId]);
      if (progressId) progressById.set(`${req.user.id}:${progressId}`, { status: 'completed', stage: 'completed', current: 1, total: 1, message: 'Готово' });
      return res.status(201).json({ id, status: 'completed', source_transcription_id: sourceTranscriptionId, result: { answer: result.answer, explain: result.explain || '', result_kind: taskType, raw_status: 200 } });
    } catch (error) {
      if (progressId) progressById.set(`${req.user.id}:${progressId}`, { status: 'failed', stage: 'failed', current: 0, total: 1, message: error.message });
      return apiError(res, error.status || 502, error.code || 'summary_failed', error.message, error.details);
    }
  }

  app.post('/api/summarizer/summaries', auth, (req, res) => createSummary(req, res));
  app.post('/api/transcriptions/:id/summaries', auth, (req, res) => createSummary(req, res, req.params.id));

  app.get('/api/summarizer/progress/:progressId', auth, (req, res) => {
    const progress = progressById.get(`${req.user.id}:${req.params.progressId}`);
    if (!progress) return apiError(res, 404, 'not_found', 'Прогресс не найден.');
    res.json(progress);
  });

  app.get('/api/summarizer/summaries', auth, async (req, res) => {
    const { rows } = await query(`SELECT id, task_type, text_chars, status, created_at, source_transcription_id FROM audio_summaries WHERE user_id=$1 ORDER BY created_at DESC LIMIT 100`, [req.user.id]);
    res.json(rows.map(publicSummary));
  });

  app.get('/api/summarizer/summaries/:id', auth, async (req, res) => {
    const { rows } = await query(`SELECT * FROM audio_summaries WHERE id=$1 AND user_id=$2`, [req.params.id, req.user.id]);
    const row = rows[0];
    if (!row) return apiError(res, 404, 'not_found', 'Резюме не найдено.');
    res.json({ id: row.id, status: row.status, source_transcription_id: row.source_transcription_id || null, result: { answer: row.answer, explain: row.explain || '', result_kind: row.task_type, raw_status: 200 } });
  });
}
