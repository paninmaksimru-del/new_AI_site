import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  DEFAULT_WHISPERX_BASE_URL,
  parseWhisperXCombinedResponse,
  parseWhisperXHealth,
  whisperXUrl
} from '../server/whisperx.js';
import { MAX_AUDIO_UPLOAD_BYTES } from '../server/audio-media.js';

const root = new URL('../', import.meta.url);

test('WhisperX использует новый combined endpoint i.moscow', () => {
  const url = whisperXUrl('api/v1/combined');
  assert.equal(DEFAULT_WHISPERX_BASE_URL, 'https://i.moscow/api/dit/proxy/operation/dud-ds-whisperx-server-l40');
  assert.equal(url.toString(), 'https://i.moscow/api/dit/proxy/operation/dud-ds-whisperx-server-l40/api/v1/combined');
});

test('combined-ответ преобразуется в расшифровку с таймкодами и спикерами', () => {
  const result = parseWhisperXCombinedResponse({
    segments: [
      { start: 0, end: 2.5, text: 'Привет, это тестовое сообщение', speaker: 'SPEAKER_01' },
      { start: 2.5, end: 5, text: 'Я отвечаю на ваш вопрос', speaker: 'SPEAKER_02' }
    ],
    num_speakers: 2,
    processing_time: 5.55,
    file_name: 'meeting.mp3'
  });

  assert.equal(result.transcript, 'Привет, это тестовое сообщение\nЯ отвечаю на ваш вопрос');
  assert.deepEqual(result.segments[1], {
    text: 'Я отвечаю на ваш вопрос',
    start_seconds: 2.5,
    end_seconds: 5,
    speaker: 'SPEAKER_02'
  });
});

test('health считается успешным только при загрузке обеих моделей', () => {
  assert.equal(parseWhisperXHealth({
    status: 'healthy',
    device: 'cuda',
    models_loaded: { whisper: true, diarization: true }
  }).healthy, true);
  assert.equal(parseWhisperXHealth({
    status: 'healthy',
    models_loaded: { whisper: true, diarization: false }
  }).healthy, false);
});

test('страница показывает форматы файлов и состояние реального health-check', async () => {
  const [routes, html, script, envExample, compose] = await Promise.all([
    readFile(new URL('server/audio-routes.js', root), 'utf8'),
    readFile(new URL('public/audio-assistant.html', root), 'utf8'),
    readFile(new URL('public/audio-assistant.js', root), 'utf8'),
    readFile(new URL('.env.example', root), 'utf8'),
    readFile(new URL('docker-compose.yml', root), 'utf8')
  ]);

  assert.match(routes, /transcriptionServiceUrl\('api\/v1\/combined'\)/);
  assert.match(routes, /transcriptionServiceUrl\('health'\)/);
  assert.doesNotMatch(routes, /voice-log-server/);
  assert.equal(MAX_AUDIO_UPLOAD_BYTES, 1000 * 1024 * 1024);
  assert.match(envExample, /AUDIO_ASSISTANT_MAX_UPLOAD_BYTES=1048576000/);
  assert.match(compose, /AUDIO_ASSISTANT_MAX_UPLOAD_BYTES=\$\{AUDIO_ASSISTANT_MAX_UPLOAD_BYTES:-1048576000\}/);
  assert.match(compose, /AUDIO_ASSISTANT_COMPRESSED_BITRATES=\$\{AUDIO_ASSISTANT_COMPRESSED_BITRATES:-32k,24k,16k\}/);
  assert.match(html, /Максимальный размер — 1 000 МБ \(1 ГБ\)/);
  assert.match(html, /Все файлы сжимаются перед отправкой/);
  assert.match(script, /каждый файл сжимается перед отправкой/);
  assert.doesNotMatch(script, /compressionThresholdBytes|compression_threshold_bytes/);
  assert.match(script, /maxUploadBytes = 1000 \* 1024 \* 1024/);
  assert.match(html, /WAV, MP3, MP4, AVI, MOV, MKV, WEBM и др\./);
  assert.match(html, /язык, таймкоды и спикеры определяются автоматически/);
  assert.doesNotMatch(html, /id="language"|id="timestamps"|id="speakers"|id="contextHint"/);
  assert.doesNotMatch(script, /data\.append\("(?:language|timestamp_granularity|speaker_labels|context_hint)"/);
  assert.match(script, /health\.transcription_service\?\.healthy===true/);
  assert.match(script, /mode==="real"\?"Работает":"Недоступен"/);
});
