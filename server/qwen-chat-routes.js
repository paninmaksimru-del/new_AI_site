import crypto from 'crypto';
import { extname } from 'path';
import mammoth from 'mammoth';
import multer from 'multer';
import { PDFParse } from 'pdf-parse';
import { query } from './db.js';
import { requireAdmin, requireKbAuth } from './auth.js';
import {
  getAdminQwenSettings,
  getQwenSetting,
  loadQwenSettings,
  saveAdminQwenSettings
} from './qwen-settings.js';

const MODEL_DEFINITIONS = Object.freeze({
  'qwen3.6-27b': {
    id: 'qwen3.6-27b',
    label: 'Qwen3.6-27B',
    endpointKey: 'QWEN_27B_BASE_URL',
    modelKey: 'QWEN_27B_MODEL',
    speed: '≈ 30 токенов/с',
    description: 'Полноразмерная модель для сложного анализа, текста, кода и рассуждений.'
  },
  'qwen3.6-35b-a3b': {
    id: 'qwen3.6-35b-a3b',
    label: 'Qwen3.6-35B-A3B',
    endpointKey: 'QWEN_35B_BASE_URL',
    modelKey: 'QWEN_35B_MODEL',
    speed: '≈ 90 токенов/с',
    description: 'Быстрая MoE-модель для повседневных запросов, документов и диалогов.'
  }
});

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024, files: 5, fields: 30 }
});
const MAX_FILE_TEXT_CHARS = 160000;
const MAX_CONTEXT_CHARS = 300000;
const TEXT_EXTENSIONS = new Set(['.txt', '.md', '.csv', '.json', '.xml', '.html', '.log', '.yaml', '.yml']);

let cachedCookies = null;
let cookieExpiresAt = 0;

function publicModels() {
  return Object.values(MODEL_DEFINITIONS).map(model => ({
    ...model,
    context_tokens: 128000,
    supports: {
      chat_history: true,
      system_prompt: true,
      thinking: true,
      streaming: true,
      text_files: true,
      sampling_controls: true,
      native_vision: false
    }
  }));
}

function settingsConfigured() {
  const direct = getQwenSetting('QWEN_AIP_TOKEN') && getQwenSetting('QWEN_AIP_REFRESH_TOKEN');
  const credentials = getQwenSetting('QWEN_PLATFORM_LOGIN') && getQwenSetting('QWEN_PLATFORM_PASSWORD');
  return Boolean(direct || credentials);
}

function clamp(value, fallback, min, max, integer = false) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  const normalized = Math.min(max, Math.max(min, parsed));
  return integer ? Math.round(normalized) : normalized;
}

function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value || ''));
}

function normalizedParameters(body = {}) {
  return {
    enable_thinking: String(body.enable_thinking ?? 'true') !== 'false',
    max_tokens: clamp(body.max_tokens, 2048, 1, 32768, true),
    temperature: clamp(body.temperature, 1, 0, 1),
    top_p: clamp(body.top_p, 0.95, 0, 1),
    top_k: clamp(body.top_k, 20, 1, 100, true),
    min_p: clamp(body.min_p, 0, 0, 1),
    presence_penalty: clamp(body.presence_penalty, 0, 0, 2),
    frequency_penalty: clamp(body.frequency_penalty, 0, 0, 2),
    repetition_penalty: clamp(body.repetition_penalty, 1, 0.1, 2),
    system_prompt: String(body.system_prompt || '').trim().slice(0, 20000)
  };
}

function parseCookies(headers) {
  const raw = typeof headers.getSetCookie === 'function'
    ? headers.getSetCookie().join(', ')
    : (headers.get('set-cookie') || '');
  const found = {};
  for (const match of raw.matchAll(/(?:^|[,;]\s*)(aip_token|aip_refresh_token)=([^;,\s]+)/gi)) {
    found[match[1].toLowerCase()] = match[2];
  }
  return found;
}

async function authenticatePlatform(force = false) {
  if (!force && cachedCookies && Date.now() < cookieExpiresAt) return cachedCookies;

  const directToken = getQwenSetting('QWEN_AIP_TOKEN');
  const directRefresh = getQwenSetting('QWEN_AIP_REFRESH_TOKEN');
  if (directToken && directRefresh) {
    cachedCookies = `aip_token=${directToken}; aip_refresh_token=${directRefresh}`;
    cookieExpiresAt = Date.now() + 5.5 * 60 * 60 * 1000;
    return cachedCookies;
  }

  const login = getQwenSetting('QWEN_PLATFORM_LOGIN');
  const password = getQwenSetting('QWEN_PLATFORM_PASSWORD');
  if (!login || !password) {
    const error = new Error('Подключение Qwen не настроено. Администратору нужно заполнить учётные данные в /admin.');
    error.status = 503;
    throw error;
  }

  const response = await fetch(getQwenSetting('QWEN_LOGIN_URL'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ login, password }),
    signal: AbortSignal.timeout(60000)
  });
  if (!response.ok) {
    const error = new Error(`Платформа ИИ отклонила авторизацию (HTTP ${response.status}).`);
    error.status = 502;
    throw error;
  }
  const cookies = parseCookies(response.headers);
  if (!cookies.aip_token || !cookies.aip_refresh_token) {
    const error = new Error('Платформа ИИ не вернула aip_token и aip_refresh_token.');
    error.status = 502;
    throw error;
  }
  cachedCookies = `aip_token=${cookies.aip_token}; aip_refresh_token=${cookies.aip_refresh_token}`;
  cookieExpiresAt = Date.now() + 5.5 * 60 * 60 * 1000;
  return cachedCookies;
}

async function requestModel(model, payload, signal, retry = true) {
  const cookies = await authenticatePlatform();
  const baseUrl = getQwenSetting(model.endpointKey).replace(/\/$/, '');
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${getQwenSetting('QWEN_API_KEY') || 'token-abc123'}`,
      'Content-Type': 'application/json',
      'Cookie': cookies
    },
    body: JSON.stringify(payload),
    signal
  });
  if (retry && (response.status === 401 || response.status === 403)) {
    cachedCookies = null;
    cookieExpiresAt = 0;
    await authenticatePlatform(true);
    return requestModel(model, payload, signal, false);
  }
  return response;
}

async function extractFileText(file) {
  const extension = extname(file.originalname || '').toLowerCase();
  const mime = String(file.mimetype || '').toLowerCase();
  let text = '';

  if (mime === 'application/pdf' || extension === '.pdf') {
    const parser = new PDFParse({ data: file.buffer });
    try { text = (await parser.getText()).text || ''; }
    finally { await parser.destroy(); }
  } else if (mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' || extension === '.docx') {
    text = (await mammoth.extractRawText({ buffer: file.buffer })).value || '';
  } else if (mime.startsWith('image/')) {
    const Tesseract = await import('tesseract.js');
    text = (await Tesseract.recognize(file.buffer, 'rus+eng', { logger: () => {} })).data.text || '';
  } else if (mime.startsWith('text/') || TEXT_EXTENSIONS.has(extension)) {
    text = file.buffer.toString('utf8');
  } else {
    const error = new Error(`Формат файла «${file.originalname}» не поддерживается.`);
    error.status = 415;
    throw error;
  }

  text = text.replace(/\u0000/g, '').trim();
  if (!text) {
    const error = new Error(`В файле «${file.originalname}» не удалось найти текст.`);
    error.status = 422;
    throw error;
  }
  return text.slice(0, MAX_FILE_TEXT_CHARS);
}

function sse(res, event) {
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}

async function streamUpstreamResponse(response, onText) {
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    const error = new Error(`Ошибка модели Qwen (HTTP ${response.status}). Проверьте доступ к модели и настройки подключения.`);
    error.status = 502;
    throw error;
  }

  const contentType = response.headers.get('content-type') || '';
  if (!contentType.includes('text/event-stream')) {
    const data = await response.json();
    const text = data.choices?.[0]?.message?.content || '';
    if (text) onText(text);
    return text;
  }

  const decoder = new TextDecoder();
  let buffer = '';
  let complete = '';
  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || '';
    for (const line of lines) {
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      let event;
      try { event = JSON.parse(payload); } catch { continue; }
      const text = event.choices?.[0]?.delta?.content || '';
      if (text) {
        complete += text;
        onText(text);
      }
    }
  }
  return complete;
}

async function getOwnedChat(chatId, userId) {
  const { rows } = await query('SELECT * FROM ai_chats WHERE id = $1 AND user_id = $2', [chatId, userId]);
  return rows[0] || null;
}

function modelMessages(rows, systemPrompt) {
  const output = [];
  if (systemPrompt) output.push({ role: 'system', content: systemPrompt });
  let used = systemPrompt.length;
  const selected = [];
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const row = rows[i];
    const content = `${row.content || ''}${row.input_context || ''}`;
    if (selected.length && used + content.length > MAX_CONTEXT_CHARS) break;
    selected.unshift({ role: row.role, content });
    used += content.length;
  }
  return output.concat(selected);
}

export async function setupQwenChatRoutes(app) {
  await loadQwenSettings();
  await query(`
    CREATE TABLE IF NOT EXISTS ai_chat_projects (
      id UUID PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_ai_chat_projects_user ON ai_chat_projects(user_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS ai_chats (
      id UUID PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      project_id UUID REFERENCES ai_chat_projects(id) ON DELETE SET NULL,
      title TEXT NOT NULL DEFAULT 'Новый чат',
      model TEXT NOT NULL,
      parameters JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_ai_chats_user ON ai_chats(user_id, updated_at DESC);

    CREATE TABLE IF NOT EXISTS ai_messages (
      id UUID PRIMARY KEY,
      chat_id UUID NOT NULL REFERENCES ai_chats(id) ON DELETE CASCADE,
      role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
      model TEXT NOT NULL,
      content TEXT NOT NULL,
      input_context TEXT,
      attachments JSONB NOT NULL DEFAULT '[]'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_ai_messages_chat ON ai_messages(chat_id, created_at);

    ALTER TABLE ai_messages ADD COLUMN IF NOT EXISTS model TEXT;
    UPDATE ai_messages AS m
       SET model = c.model
      FROM ai_chats AS c
     WHERE m.chat_id = c.id AND m.model IS NULL;
    ALTER TABLE ai_messages ALTER COLUMN model SET NOT NULL;
  `);

  const auth = requireKbAuth();

  app.get('/api/admin/qwen-settings', requireAdmin(), (req, res) => res.json(getAdminQwenSettings()));
  app.put('/api/admin/qwen-settings', requireAdmin(), async (req, res) => {
    try {
      const result = await saveAdminQwenSettings(req.body || {});
      cachedCookies = null;
      cookieExpiresAt = 0;
      res.json(result);
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });

  app.get('/api/chat/models', auth, (req, res) => res.json({
    models: publicModels(),
    configured: settingsConfigured(),
    file_formats: ['PDF', 'DOCX', 'TXT', 'MD', 'CSV', 'JSON', 'PNG', 'JPEG', 'WEBP'],
    max_files: 5,
    max_file_size_mb: 15
  }));

  app.get('/api/chat/projects', auth, async (req, res) => {
    const { rows } = await query('SELECT id, name, created_at FROM ai_chat_projects WHERE user_id = $1 ORDER BY created_at', [req.user.id]);
    res.json(rows);
  });

  app.post('/api/chat/projects', auth, async (req, res) => {
    const name = String(req.body?.name || '').trim().slice(0, 80);
    if (!name) return res.status(400).json({ error: 'Укажите название проекта.' });
    const id = crypto.randomUUID();
    const { rows } = await query('INSERT INTO ai_chat_projects (id, user_id, name) VALUES ($1, $2, $3) RETURNING id, name, created_at', [id, req.user.id, name]);
    res.status(201).json(rows[0]);
  });

  app.get('/api/chat/sessions', auth, async (req, res) => {
    const { rows } = await query(`
      SELECT c.id, c.project_id, c.title, c.model, c.parameters, c.created_at, c.updated_at,
             (SELECT COUNT(*)::int FROM ai_messages m WHERE m.chat_id = c.id) AS message_count
        FROM ai_chats c
       WHERE c.user_id = $1
       ORDER BY c.updated_at DESC
       LIMIT 200`, [req.user.id]);
    res.json(rows);
  });

  app.post('/api/chat/sessions', auth, async (req, res) => {
    const model = MODEL_DEFINITIONS[req.body?.model] ? req.body.model : 'qwen3.6-27b';
    const projectId = req.body?.project_id || null;
    if (projectId && !isUuid(projectId)) return res.status(400).json({ error: 'Некорректный идентификатор проекта.' });
    if (projectId) {
      const { rows } = await query('SELECT id FROM ai_chat_projects WHERE id = $1 AND user_id = $2', [projectId, req.user.id]);
      if (!rows[0]) return res.status(404).json({ error: 'Проект не найден.' });
    }
    const id = crypto.randomUUID();
    const parameters = normalizedParameters(req.body?.parameters || {});
    const { rows } = await query(
      `INSERT INTO ai_chats (id, user_id, project_id, title, model, parameters)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb) RETURNING *`,
      [id, req.user.id, projectId, String(req.body?.title || 'Новый чат').slice(0, 120), model, JSON.stringify(parameters)]
    );
    res.status(201).json(rows[0]);
  });

  app.get('/api/chat/sessions/:id', auth, async (req, res) => {
    if (!isUuid(req.params.id)) return res.status(400).json({ error: 'Некорректный идентификатор чата.' });
    const chat = await getOwnedChat(req.params.id, req.user.id);
    if (!chat) return res.status(404).json({ error: 'Чат не найден.' });
    const { rows } = await query('SELECT id, role, model, content, attachments, created_at FROM ai_messages WHERE chat_id = $1 ORDER BY created_at, id', [chat.id]);
    res.json({ chat, messages: rows });
  });

  app.patch('/api/chat/sessions/:id', auth, async (req, res) => {
    if (!isUuid(req.params.id)) return res.status(400).json({ error: 'Некорректный идентификатор чата.' });
    const chat = await getOwnedChat(req.params.id, req.user.id);
    if (!chat) return res.status(404).json({ error: 'Чат не найден.' });
    const model = req.body?.model && MODEL_DEFINITIONS[req.body.model] ? req.body.model : chat.model;
    const title = req.body?.title == null ? chat.title : String(req.body.title).trim().slice(0, 120) || 'Новый чат';
    const projectId = Object.hasOwn(req.body || {}, 'project_id') ? (req.body.project_id || null) : chat.project_id;
    if (projectId && !isUuid(projectId)) return res.status(400).json({ error: 'Некорректный идентификатор проекта.' });
    if (projectId) {
      const { rows } = await query('SELECT id FROM ai_chat_projects WHERE id = $1 AND user_id = $2', [projectId, req.user.id]);
      if (!rows[0]) return res.status(404).json({ error: 'Проект не найден.' });
    }
    const parameters = req.body?.parameters ? normalizedParameters(req.body.parameters) : chat.parameters;
    const { rows } = await query(
      `UPDATE ai_chats SET title=$1, model=$2, project_id=$3, parameters=$4::jsonb, updated_at=NOW()
        WHERE id=$5 AND user_id=$6 RETURNING *`,
      [title, model, projectId, JSON.stringify(parameters), chat.id, req.user.id]
    );
    res.json(rows[0]);
  });

  app.delete('/api/chat/sessions/:id', auth, async (req, res) => {
    if (!isUuid(req.params.id)) return res.status(400).json({ error: 'Некорректный идентификатор чата.' });
    await query('DELETE FROM ai_chats WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]);
    res.json({ ok: true });
  });

  app.post('/api/chat/completions', auth, upload.array('files', 5), async (req, res) => {
    let chat;
    try {
      const message = String(req.body?.message || '').trim().slice(0, 50000);
      if (!message && !req.files?.length) return res.status(400).json({ error: 'Введите сообщение или добавьте файл.' });
      if (req.body?.chat_id && !isUuid(req.body.chat_id)) return res.status(400).json({ error: 'Некорректный идентификатор чата.' });

      const requestedModel = MODEL_DEFINITIONS[req.body?.model] ? req.body.model : 'qwen3.6-27b';
      chat = req.body?.chat_id ? await getOwnedChat(req.body.chat_id, req.user.id) : null;
      if (req.body?.chat_id && !chat) return res.status(404).json({ error: 'Чат не найден.' });
      const parameters = normalizedParameters(req.body);

      if (!chat) {
        const id = crypto.randomUUID();
        const title = (message || req.files?.[0]?.originalname || 'Новый чат').split(/\s+/).slice(0, 8).join(' ').slice(0, 120);
        const { rows } = await query(
          `INSERT INTO ai_chats (id, user_id, title, model, parameters) VALUES ($1,$2,$3,$4,$5::jsonb) RETURNING *`,
          [id, req.user.id, title, requestedModel, JSON.stringify(parameters)]
        );
        chat = rows[0];
      } else {
        const { rows } = await query(
          `UPDATE ai_chats SET model=$1, parameters=$2::jsonb, updated_at=NOW() WHERE id=$3 AND user_id=$4 RETURNING *`,
          [requestedModel, JSON.stringify(parameters), chat.id, req.user.id]
        );
        chat = rows[0];
      }

      const attachments = [];
      const contextBlocks = [];
      for (const file of req.files || []) {
        const text = await extractFileText(file);
        attachments.push({ name: file.originalname, type: file.mimetype, size: file.size, extracted_chars: text.length });
        contextBlocks.push(`\n\n<attached_file name="${String(file.originalname).replace(/[<>\"\r\n]/g, '')}">\n${text}\n</attached_file>`);
      }
      const inputContext = contextBlocks.join('');
      if (inputContext.length > MAX_CONTEXT_CHARS) return res.status(413).json({ error: 'Суммарный текст вложений превышает доступный контекст.' });

      await query(
        `INSERT INTO ai_messages (id, chat_id, role, model, content, input_context, attachments)
         VALUES ($1,$2,'user',$3,$4,$5,$6::jsonb)`,
        [crypto.randomUUID(), chat.id, requestedModel, message, inputContext || null, JSON.stringify(attachments)]
      );
      if (chat.title === 'Новый чат') {
        const title = (message || attachments[0]?.name || 'Новый чат').split(/\s+/).slice(0, 8).join(' ').slice(0, 120);
        await query('UPDATE ai_chats SET title=$1 WHERE id=$2', [title, chat.id]);
      }

      const { rows: history } = await query(
        'SELECT role, content, input_context FROM ai_messages WHERE chat_id=$1 ORDER BY created_at, id',
        [chat.id]
      );
      const model = MODEL_DEFINITIONS[requestedModel];
      const payload = {
        model: getQwenSetting(model.modelKey),
        messages: modelMessages(history, parameters.system_prompt),
        max_tokens: parameters.max_tokens,
        temperature: parameters.temperature,
        top_p: parameters.top_p,
        top_k: parameters.top_k,
        min_p: parameters.min_p,
        presence_penalty: parameters.presence_penalty,
        frequency_penalty: parameters.frequency_penalty,
        repetition_penalty: parameters.repetition_penalty,
        n: 1,
        best_of: 1,
        stream: true,
        chat_template_kwargs: { enable_thinking: parameters.enable_thinking }
      };

      res.status(200);
      res.set({
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no'
      });
      res.flushHeaders();
      sse(res, { type: 'meta', chat_id: chat.id, model: requestedModel, thinking: parameters.enable_thinking });

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), Number(getQwenSetting('QWEN_REQUEST_TIMEOUT_MS')) || 2400000);
      let responseFinished = false;
      const abortOnResponseClose = () => {
        if (!responseFinished) controller.abort();
      };
      req.on('aborted', () => controller.abort());
      res.once('close', abortOnResponseClose);
      try {
        const upstream = await requestModel(model, payload, controller.signal);
        const answer = await streamUpstreamResponse(upstream, text => sse(res, { type: 'delta', text }));
        const finalAnswer = answer.trim() || 'Модель завершила рассуждение без отдельного финального ответа. Увеличьте max_tokens или отключите режим рассуждения.';
        if (!answer.trim()) sse(res, { type: 'delta', text: finalAnswer });
        await query(
          `INSERT INTO ai_messages (id, chat_id, role, model, content) VALUES ($1,$2,'assistant',$3,$4)`,
          [crypto.randomUUID(), chat.id, requestedModel, finalAnswer]
        );
        await query('UPDATE ai_chats SET updated_at=NOW() WHERE id=$1', [chat.id]);
        sse(res, { type: 'done', chat_id: chat.id });
        responseFinished = true;
      } finally {
        clearTimeout(timeout);
        if (responseFinished) res.off('close', abortOnResponseClose);
      }
      res.end();
    } catch (error) {
      const message = error.name === 'AbortError' ? 'Превышено время ожидания ответа модели.' : error.message;
      if (res.destroyed || res.writableEnded) return;
      if (res.headersSent) {
        sse(res, { type: 'error', error: message });
        return res.end();
      }
      res.status(error.status || 500).json({ error: message });
    }
  });
}
