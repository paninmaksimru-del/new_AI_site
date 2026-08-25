export const DEFAULT_WHISPERX_BASE_URL = 'https://i.moscow/api/dit/proxy/operation/dud-ds-whisperx-server-l40';

export function whisperXUrl(pathname, { baseUrl = DEFAULT_WHISPERX_BASE_URL, token = '' } = {}) {
  const normalizedBase = String(baseUrl || DEFAULT_WHISPERX_BASE_URL).replace(/\/$/, '');
  const normalizedPath = String(pathname || '').replace(/^\/+/, '');
  const url = new URL(`${normalizedBase}/${normalizedPath}`.replace(/\/$/, ''));
  if (token) url.searchParams.set('token', token);
  return url;
}

function findPayloadWithSegments(value, depth = 0) {
  if (!value || typeof value !== 'object' || depth > 8) return null;
  if (Array.isArray(value.segments)) return value;
  for (const key of ['data', 'result', 'output', 'response']) {
    const found = findPayloadWithSegments(value[key], depth + 1);
    if (found) return found;
  }
  return null;
}

export function normalizeWhisperXSegments(body) {
  const payload = findPayloadWithSegments(body);
  if (!payload) return [];
  return payload.segments.map(item => ({
    text: String(item?.text || '').trim(),
    start_seconds: Number.isFinite(Number(item?.start)) ? Number(item.start) : null,
    end_seconds: Number.isFinite(Number(item?.end)) ? Number(item.end) : null,
    speaker: item?.speaker == null ? null : String(item.speaker)
  })).filter(item => item.text);
}

export function parseWhisperXCombinedResponse(body) {
  const payload = findPayloadWithSegments(body);
  if (!payload) return null;
  const segments = normalizeWhisperXSegments(payload);
  const transcript = String(payload.text || '').trim() || segments.map(segment => segment.text).join('\n');
  return {
    transcript,
    language: payload.language || payload.detected_language || null,
    segments
  };
}

function findHealthPayload(value, depth = 0) {
  if (!value || typeof value !== 'object' || depth > 5) return {};
  if (value.status != null || value.models_loaded != null) return value;
  for (const key of ['data', 'result', 'response']) {
    const found = findHealthPayload(value[key], depth + 1);
    if (found.status != null || found.models_loaded != null) return found;
  }
  return {};
}

export function parseWhisperXHealth(body, responseOk = true) {
  const payload = findHealthPayload(body);
  const status = String(payload.status || '').toLowerCase();
  const modelsLoaded = payload.models_loaded && typeof payload.models_loaded === 'object'
    ? payload.models_loaded
    : {};
  const modelsReady = modelsLoaded.whisper === true && modelsLoaded.diarization === true;
  return {
    healthy: Boolean(responseOk && status === 'healthy' && modelsReady),
    status: status || (responseOk ? 'unknown' : 'unavailable'),
    device: payload.device || null,
    models_loaded: {
      whisper: modelsLoaded.whisper === true,
      diarization: modelsLoaded.diarization === true
    }
  };
}
