import {
  ANONYMIZER_QWEN_PROMPT_VERSION,
  ANONYMIZER_QWEN_SYSTEM_PROMPT
} from './prompts/anonymizer-qwen-v1.js';

const ALLOWED_TYPES = new Set([
  'PERSON', 'ADDRESS', 'PHONE', 'EMAIL', 'PASSPORT', 'SNILS', 'INN',
  'BANK_ACCOUNT', 'BIK', 'CARD', 'CONTRACT_NUMBER', 'ORGANIZATION',
  'MONEY', 'BIRTH_DATE', 'OTHER'
]);
const ALLOWED_CONFIDENCE = new Set(['high', 'medium', 'low']);
const MAX_TEXT_LENGTH = 60_000;
const MAX_ENTITIES = 500;

function qwenConfig() {
  return {
    apiKey: String(process.env.QWEN_API_KEY || '').trim(),
    baseUrl: String(process.env.QWEN_BASE_URL || '').trim().replace(/\/+$/, ''),
    model: String(process.env.QWEN_MODEL || 'qwen3.7-plus').trim(),
    timeoutMs: Math.max(5_000, Math.min(120_000, Number(process.env.QWEN_TIMEOUT_MS) || 60_000))
  };
}

export function isQwenConfigured(config = qwenConfig()) {
  return Boolean(config.apiKey && config.baseUrl && config.model);
}

export function normalizeQwenEntities(text, payload) {
  const sourceText = String(text || '');
  const entities = Array.isArray(payload?.entities) ? payload.entities : [];
  const accepted = [];
  const seen = new Set();

  for (const candidate of entities.slice(0, MAX_ENTITIES)) {
    const type = String(candidate?.type || '').toUpperCase();
    const start = Number(candidate?.start);
    const end = Number(candidate?.end);
    const value = String(candidate?.value || '');
    if (!ALLOWED_TYPES.has(type) || !Number.isInteger(start) || !Number.isInteger(end)) continue;
    if (start < 0 || end <= start || end > sourceText.length || sourceText.slice(start, end) !== value) continue;
    const key = `${start}:${end}:${type}`;
    if (seen.has(key)) continue;
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
  return accepted.sort((left, right) => left.start - right.start || left.end - right.end);
}

function parseQwenResponse(data) {
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content !== 'string') throw new Error('QWEN_RESPONSE_FORMAT');
  const cleaned = content.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  return JSON.parse(cleaned);
}

async function findEntitiesWithQwen(text, ruleCandidates, config = qwenConfig()) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs);
  try {
    const response = await fetch(`${config.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`
      },
      signal: controller.signal,
      body: JSON.stringify({
        model: config.model,
        temperature: 0,
        response_format: { type: 'json_object' },
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
    return normalizeQwenEntities(text, parseQwenResponse(await response.json()));
  } finally {
    clearTimeout(timeout);
  }
}

export function setupAnonymizerQwen(app, authMiddleware) {
  app.get('/api/anonymizer/qwen/status', (_req, res) => {
    const config = qwenConfig();
    res.json({
      configured: isQwenConfigured(config),
      model: isQwenConfigured(config) ? config.model : null,
      promptVersion: ANONYMIZER_QWEN_PROMPT_VERSION
    });
  });

  app.post('/api/anonymizer/qwen/entities', authMiddleware, async (req, res) => {
    const config = qwenConfig();
    if (!isQwenConfigured(config)) return res.status(503).json({ error: 'QWEN_NOT_CONFIGURED' });
    if (req.body?.confirmed !== true) return res.status(400).json({ error: 'QWEN_CONSENT_REQUIRED' });
    const text = String(req.body?.text || '');
    if (!text.trim()) return res.status(400).json({ error: 'TEXT_REQUIRED' });
    if (text.length > MAX_TEXT_LENGTH) return res.status(413).json({ error: 'TEXT_TOO_LARGE', limit: MAX_TEXT_LENGTH });
    const ruleCandidates = Array.isArray(req.body?.ruleCandidates) ? req.body.ruleCandidates.slice(0, MAX_ENTITIES) : [];
    try {
      const entities = await findEntitiesWithQwen(text, ruleCandidates, config);
      res.json({ entities, model: config.model, promptVersion: ANONYMIZER_QWEN_PROMPT_VERSION });
    } catch (error) {
      const code = error?.name === 'AbortError' ? 'QWEN_TIMEOUT' : String(error?.message || 'QWEN_FAILED');
      console.error('Qwen anonymizer request failed:', code);
      res.status(502).json({ error: code });
    }
  });
}
