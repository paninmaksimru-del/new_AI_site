import {
  ANONYMIZER_QWEN_PROMPT_VERSION,
  ANONYMIZER_QWEN_SYSTEM_PROMPT
} from './prompts/anonymizer-qwen-v1.js';
import { getQwenSetting } from './qwen-settings.js';

const ALLOWED_TYPES = new Set([
  'PERSON', 'ADDRESS', 'PHONE', 'EMAIL', 'PASSPORT', 'SNILS', 'INN',
  'BANK_ACCOUNT', 'BIK', 'CARD', 'CONTRACT_NUMBER', 'ORGANIZATION',
  'MONEY', 'BIRTH_DATE', 'OTHER'
]);
const ALLOWED_CONFIDENCE = new Set(['high', 'medium', 'low']);
const MAX_TEXT_LENGTH = 60_000;
const MAX_ENTITIES = 500;
const ANONYMIZER_MODEL_PROFILE = Object.freeze({
  id: 'qwen3.6-27b',
  endpointKey: 'QWEN_27B_BASE_URL',
  modelKey: 'QWEN_27B_MODEL'
});

export function anonymizerQwenConfig(readSetting = getQwenSetting) {
  return {
    profile: ANONYMIZER_MODEL_PROFILE.id,
    proxyToken: String(readSetting('QWEN_PROXY_TOKEN') || '').trim(),
    baseUrl: String(readSetting(ANONYMIZER_MODEL_PROFILE.endpointKey) || '').trim().replace(/\/+$/, ''),
    model: String(readSetting(ANONYMIZER_MODEL_PROFILE.modelKey) || '').trim(),
    timeoutMs: Math.max(5_000, Math.min(2_400_000, Number(readSetting('QWEN_REQUEST_TIMEOUT_MS')) || 60_000))
  };
}

export function isQwenConfigured(config = anonymizerQwenConfig()) {
  return Boolean(config.proxyToken && config.baseUrl && config.model);
}

export function anonymizerQwenUrl(config) {
  const url = new URL(config.baseUrl);
  if (url.origin !== 'https://i.moscow' || !url.pathname.startsWith('/api/dit/proxy/operation/openqwen/')) {
    throw new Error('QWEN_ENDPOINT_INVALID');
  }
  const pathname = url.pathname.replace(/\/+$/, '');
  if (!pathname.endsWith('/chat/completions')) url.pathname = `${pathname}/chat/completions`;
  url.search = '';
  url.hash = '';
  url.searchParams.set('token', config.proxyToken);
  return url;
}

function countRejection(diagnostics, reason, count = 1) {
  diagnostics.reasons[reason] = (diagnostics.reasons[reason] || 0) + count;
}

export function inspectQwenEntities(text, payload) {
  const sourceText = String(text || '');
  const hasEntityArray = Array.isArray(payload?.entities);
  const entities = hasEntityArray ? payload.entities : [];
  const accepted = [];
  const seen = new Set();
  const diagnostics = {
    returned: entities.length,
    accepted: 0,
    rejected: 0,
    reasons: {}
  };

  if (!hasEntityArray) diagnostics.responseIssues = ['entities_not_array'];
  if (entities.length > MAX_ENTITIES) {
    countRejection(diagnostics, 'entity_limit_exceeded', entities.length - MAX_ENTITIES);
  }

  for (const candidate of entities.slice(0, MAX_ENTITIES)) {
    const type = String(candidate?.type || '').toUpperCase();
    const start = Number(candidate?.start);
    const end = Number(candidate?.end);
    const value = String(candidate?.value || '');
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
      countRejection(diagnostics, 'invalid_candidate');
      continue;
    }
    if (!ALLOWED_TYPES.has(type)) {
      countRejection(diagnostics, 'type_not_allowed');
      continue;
    }
    if (!Number.isInteger(start) || !Number.isInteger(end)) {
      countRejection(diagnostics, 'indexes_invalid');
      continue;
    }
    if (start < 0 || end <= start || end > sourceText.length) {
      countRejection(diagnostics, 'range_invalid');
      continue;
    }
    if (sourceText.slice(start, end) !== value) {
      countRejection(diagnostics, 'value_mismatch');
      continue;
    }
    const key = `${start}:${end}:${type}`;
    if (seen.has(key)) {
      countRejection(diagnostics, 'duplicate');
      continue;
    }
    seen.add(key);
    accepted.push({
      id: `qwen-${type}-${start}-${accepted.length}`,
      type,
      value,
      start,
      end,
      action: 'REVIEW',
      confidence: ALLOWED_CONFIDENCE.has(candidate.confidence) ? candidate.confidence : 'low',
      reason: String(candidate?.reason || '').slice(0, 240),
      source: 'qwen'
    });
  }
  diagnostics.accepted = accepted.length;
  diagnostics.rejected = diagnostics.returned - diagnostics.accepted;
  return {
    entities: accepted.sort((left, right) => left.start - right.start || left.end - right.end),
    diagnostics
  };
}

export function normalizeQwenEntities(text, payload) {
  return inspectQwenEntities(text, payload).entities;
}

function parseQwenResponse(data) {
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content !== 'string') throw new Error('QWEN_RESPONSE_FORMAT');
  const cleaned = content.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  return JSON.parse(cleaned);
}

async function findEntitiesWithQwen(text, ruleCandidates, config = anonymizerQwenConfig()) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs);
  try {
    const response = await fetch(anonymizerQwenUrl(config), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      signal: controller.signal,
      body: JSON.stringify({
        model: config.model,
        temperature: 0,
        max_tokens: 4096,
        response_format: { type: 'json_object' },
        chat_template_kwargs: { enable_thinking: false },
        messages: [
          { role: 'system', content: ANONYMIZER_QWEN_SYSTEM_PROMPT },
          {
            role: 'user',
            content: JSON.stringify({
              text,
              ruleCandidates: ruleCandidates.map(({ type, value, start, end }) => ({ type, value, start, end }))
            })
          }
        ]
      })
    });
    if (!response.ok) throw new Error(`QWEN_HTTP_${response.status}`);
    return inspectQwenEntities(text, parseQwenResponse(await response.json()));
  } finally {
    clearTimeout(timeout);
  }
}

export function setupAnonymizerQwen(app, authMiddleware) {
  app.get('/api/anonymizer/qwen/status', (_req, res) => {
    const config = anonymizerQwenConfig();
    res.json({
      configured: isQwenConfigured(config),
      model: isQwenConfigured(config) ? config.model : null,
      profile: config.profile,
      maxTextLength: MAX_TEXT_LENGTH,
      promptVersion: ANONYMIZER_QWEN_PROMPT_VERSION
    });
  });

  app.post('/api/anonymizer/qwen/entities', authMiddleware, async (req, res) => {
    const config = anonymizerQwenConfig();
    if (!isQwenConfigured(config)) return res.status(503).json({ error: 'QWEN_NOT_CONFIGURED' });
    if (req.body?.confirmed !== true) return res.status(400).json({ error: 'QWEN_CONSENT_REQUIRED' });
    const text = String(req.body?.text || '');
    if (!text.trim()) return res.status(400).json({ error: 'TEXT_REQUIRED' });
    if (text.length > MAX_TEXT_LENGTH) return res.status(413).json({ error: 'TEXT_TOO_LARGE', limit: MAX_TEXT_LENGTH });
    const ruleCandidates = Array.isArray(req.body?.ruleCandidates) ? req.body.ruleCandidates.slice(0, MAX_ENTITIES) : [];
    try {
      const result = await findEntitiesWithQwen(text, ruleCandidates, config);
      res.json({
        entities: result.entities,
        diagnostics: result.diagnostics,
        model: config.model,
        promptVersion: ANONYMIZER_QWEN_PROMPT_VERSION
      });
    } catch (error) {
      const code = error?.name === 'AbortError' ? 'QWEN_TIMEOUT' : String(error?.message || 'QWEN_FAILED');
      console.error('Qwen anonymizer request failed:', code);
      res.status(502).json({ error: code });
    }
  });
}
