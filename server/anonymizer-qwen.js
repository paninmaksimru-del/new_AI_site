import { randomUUID } from 'node:crypto';
import {
  ANONYMIZER_QWEN_PROMPT_VERSION,
  ANONYMIZER_QWEN_SYSTEM_PROMPT
} from './prompts/anonymizer-qwen-v2.js';
import { getQwenSetting } from './qwen-settings.js';

const ALLOWED_TYPES = new Set([
  'PERSON', 'ADDRESS', 'PHONE', 'EMAIL', 'PASSPORT', 'SNILS', 'INN',
  'BANK_ACCOUNT', 'BIK', 'CARD', 'CONTRACT_NUMBER', 'ORGANIZATION',
  'MONEY', 'BIRTH_DATE', 'OTHER'
]);
const ALLOWED_CONFIDENCE = new Set(['high', 'medium', 'low']);
const MAX_TEXT_LENGTH = 60_000;
const MAX_ENTITIES = 500;
const MAX_OCCURRENCES_PER_VALUE = 1_000;
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

function exactOccurrences(text, value) {
  const starts = [];
  if (!value) return { starts, truncated: false };
  let offset = 0;
  while (offset <= text.length - value.length) {
    const start = text.indexOf(value, offset);
    if (start < 0) break;
    starts.push(start);
    if (starts.length >= MAX_OCCURRENCES_PER_VALUE) return { starts, truncated: true };
    offset = start + Math.max(1, value.length);
  }
  return { starts, truncated: false };
}

function resolvedCandidateRange(sourceText, value, type, reportedStart, reportedEnd, seen) {
  const reportedRangeIsExact = Number.isInteger(reportedStart)
    && Number.isInteger(reportedEnd)
    && reportedStart >= 0
    && reportedEnd > reportedStart
    && reportedEnd <= sourceText.length
    && sourceText.slice(reportedStart, reportedEnd) === value;
  if (reportedRangeIsExact) {
    return { start: reportedStart, end: reportedEnd, repaired: false };
  }

  const occurrences = exactOccurrences(sourceText, value);
  if (occurrences.truncated) return { ambiguous: true };
  const available = occurrences.starts
    .map((start) => ({ start, end: start + value.length }))
    .filter(({ start, end }) => !seen.has(`${start}:${end}:${type}`));
  if (!available.length) return occurrences.starts.length ? { duplicate: true } : null;
  if (available.length === 1) return { ...available[0], repaired: true };
  if (!Number.isInteger(reportedStart)) return { ambiguous: true };

  available.sort((left, right) => {
    const distance = Math.abs(left.start - reportedStart) - Math.abs(right.start - reportedStart);
    return distance || left.start - right.start;
  });
  return { ...available[0], repaired: true };
}

export function inspectQwenEntities(text, payload) {
  const sourceText = String(text || '');
  const hasEntityArray = Array.isArray(payload?.entities);
  const entities = hasEntityArray ? payload.entities : [];
  const accepted = [];
  const seen = new Set();
  const diagnostics = {
    returned: entities.length,
    located: 0,
    repaired: 0,
    accepted: 0,
    rejected: 0,
    reasons: {}
  };

  if (!hasEntityArray) diagnostics.responseIssues = ['entities_not_array'];
  if (entities.length > MAX_ENTITIES) {
    countRejection(diagnostics, 'entity_limit_exceeded', entities.length - MAX_ENTITIES);
  }

  for (const candidate of entities.slice(0, MAX_ENTITIES)) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
      countRejection(diagnostics, 'invalid_candidate');
      continue;
    }
    const type = String(candidate.type || '').toUpperCase();
    const reportedStart = Number(candidate.start);
    const reportedEnd = Number(candidate.end);
    const value = String(candidate.value || '');
    if (!ALLOWED_TYPES.has(type)) {
      countRejection(diagnostics, 'type_not_allowed');
      continue;
    }
    if (!value) {
      countRejection(diagnostics, 'value_missing');
      continue;
    }
    const range = resolvedCandidateRange(sourceText, value, type, reportedStart, reportedEnd, seen);
    if (range?.duplicate) {
      countRejection(diagnostics, 'duplicate');
      continue;
    }
    if (range?.ambiguous) {
      countRejection(diagnostics, 'occurrence_ambiguous');
      continue;
    }
    if (!range) {
      countRejection(diagnostics, 'value_not_found');
      continue;
    }
    const { start, end } = range;
    const key = `${start}:${end}:${type}`;
    if (seen.has(key)) {
      countRejection(diagnostics, 'duplicate');
      continue;
    }
    seen.add(key);
    diagnostics.located += 1;
    if (range.repaired) diagnostics.repaired += 1;
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

function overlaps(left, right) {
  return Number.isInteger(left?.start)
    && Number.isInteger(left?.end)
    && Number.isInteger(right?.start)
    && Number.isInteger(right?.end)
    && left.start < right.end
    && right.start < left.end;
}

function selectQwenAdditions(entities, ruleCandidates, diagnostics) {
  const additions = [];
  let overlappingRuleCandidates = 0;
  let overlappingQwenCandidates = 0;
  for (const candidate of entities) {
    if (ruleCandidates.some((ruleCandidate) => overlaps(ruleCandidate, candidate))) {
      overlappingRuleCandidates += 1;
      continue;
    }
    if (additions.some((current) => overlaps(current, candidate))) {
      overlappingQwenCandidates += 1;
      continue;
    }
    additions.push(candidate);
  }
  diagnostics.overlappingRuleCandidates = overlappingRuleCandidates;
  diagnostics.overlappingQwenCandidates = overlappingQwenCandidates;
  diagnostics.addedToResult = additions.length;
  return additions;
}

function normalizeDocumentContext(value) {
  const format = String(value?.format || 'text').toLowerCase();
  const allowedFormat = ['text', 'txt', 'docx', 'pdf'].includes(format) ? format : 'unknown';
  const size = Number(value?.size);
  return {
    format: allowedFormat,
    size: Number.isFinite(size) && size >= 0 ? Math.round(size) : null
  };
}

export async function findEntitiesWithQwen(text, ruleCandidates, config = anonymizerQwenConfig(), documentContext = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs);
  const document = normalizeDocumentContext(documentContext);
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
              task: 'find_additional_sensitive_entities',
              document: { format: document.format, text },
              ruleCandidates: ruleCandidates.map(({ type, value, start, end }) => ({ type, value, start, end }))
            })
          }
        ]
      })
    });
    if (!response.ok) throw new Error(`QWEN_HTTP_${response.status}`);
    const inspected = inspectQwenEntities(text, parseQwenResponse(await response.json()));
    const entities = selectQwenAdditions(inspected.entities, ruleCandidates, inspected.diagnostics);
    return { entities, diagnostics: inspected.diagnostics, upstreamStatus: response.status, document };
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
    const requestId = randomUUID();
    const startedAt = Date.now();
    res.setHeader('X-Anonymizer-Request-Id', requestId);
    const config = anonymizerQwenConfig();
    if (!isQwenConfigured(config)) return res.status(503).json({ error: 'QWEN_NOT_CONFIGURED' });
    if (req.body?.confirmed !== true) return res.status(400).json({ error: 'QWEN_CONSENT_REQUIRED' });
    const text = String(req.body?.text || '');
    if (!text.trim()) return res.status(400).json({ error: 'TEXT_REQUIRED' });
    if (text.length > MAX_TEXT_LENGTH) return res.status(413).json({ error: 'TEXT_TOO_LARGE', limit: MAX_TEXT_LENGTH });
    const ruleCandidates = Array.isArray(req.body?.ruleCandidates) ? req.body.ruleCandidates.slice(0, MAX_ENTITIES) : [];
    const document = normalizeDocumentContext(req.body?.document);
    try {
      const result = await findEntitiesWithQwen(text, ruleCandidates, config, document);
      const trace = {
        requestId,
        completed: true,
        model: config.model,
        promptVersion: ANONYMIZER_QWEN_PROMPT_VERSION,
        documentFormat: result.document.format,
        documentSize: result.document.size,
        textLength: text.length,
        ruleCandidatesSent: ruleCandidates.length,
        upstreamStatus: result.upstreamStatus,
        durationMs: Date.now() - startedAt
      };
      console.info('Qwen anonymizer completed:', JSON.stringify({
        ...trace,
        returned: result.diagnostics.returned,
        repaired: result.diagnostics.repaired,
        accepted: result.diagnostics.accepted,
        addedToResult: result.diagnostics.addedToResult,
        rejected: result.diagnostics.rejected
      }));
      res.json({
        entities: result.entities,
        diagnostics: result.diagnostics,
        trace,
        model: config.model,
        promptVersion: ANONYMIZER_QWEN_PROMPT_VERSION
      });
    } catch (error) {
      const code = error?.name === 'AbortError' ? 'QWEN_TIMEOUT' : String(error?.message || 'QWEN_FAILED');
      console.error('Qwen anonymizer failed:', JSON.stringify({
        requestId,
        completed: false,
        model: config.model,
        promptVersion: ANONYMIZER_QWEN_PROMPT_VERSION,
        documentFormat: document.format,
        textLength: text.length,
        ruleCandidatesSent: ruleCandidates.length,
        durationMs: Date.now() - startedAt,
        error: code
      }));
      res.status(502).json({ error: code, requestId });
    }
  });
}
