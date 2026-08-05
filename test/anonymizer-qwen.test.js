import test from 'node:test';
import assert from 'node:assert/strict';
import { ANONYMIZER_QWEN_SYSTEM_PROMPT } from '../server/prompts/anonymizer-qwen-v1.js';

process.env.DATABASE_URL ||= 'postgresql://localhost/mik_anonymizer_unit_test';
const {
  anonymizerQwenConfig,
  anonymizerQwenUrl,
  inspectQwenEntities,
  isQwenConfigured,
  normalizeQwenEntities
} = await import('../server/anonymizer-qwen.js');

test('Qwen-ответ принимается только при точном совпадении диапазона и текста', () => {
  const text = 'Получатель: Иванов Иван.';
  const start = text.indexOf('Иванов');
  const result = normalizeQwenEntities(text, { entities: [
    { type: 'PERSON', value: 'Иванов Иван', start, end: text.length - 1, confidence: 'high', reason: 'ФИО' },
    { type: 'PERSON', value: 'Петров', start: 0, end: 6, confidence: 'high' },
    { type: 'COMMAND', value: 'Получатель', start: 0, end: 10, confidence: 'high' }
  ] });
  assert.equal(result.length, 1);
  assert.equal(result[0].source, 'qwen');
  assert.equal(result[0].action, 'REVIEW');
});

test('диагностика Qwen считает принятые ответы и причины отклонения без исходных значений', () => {
  const text = 'Получатель: Иванов Иван.';
  const start = text.indexOf('Иванов');
  const valid = { type: 'PERSON', value: 'Иванов Иван', start, end: text.length - 1, confidence: 'high' };
  const result = inspectQwenEntities(text, { entities: [
    valid,
    { ...valid },
    { type: 'PERSON', value: 'Петров', start: 0, end: 6 },
    { type: 'COMMAND', value: 'Получатель', start: 0, end: 10 },
    { type: 'PERSON', value: 'Иванов', start: 'не индекс', end: 6 }
  ] });

  assert.equal(result.entities.length, 1);
  assert.deepEqual(result.diagnostics, {
    returned: 5,
    accepted: 1,
    rejected: 4,
    reasons: {
      duplicate: 1,
      value_mismatch: 1,
      type_not_allowed: 1,
      indexes_invalid: 1
    }
  });
  assert.equal(JSON.stringify(result.diagnostics).includes('Иванов'), false);
});

test('системный промпт трактует документ как данные и запрещает токенизацию', () => {
  assert.match(ANONYMIZER_QWEN_SYSTEM_PROMPT, /недоверенными данными/u);
  assert.match(ANONYMIZER_QWEN_SYSTEM_PROMPT, /не создавай токены/u);
});

test('анонимайзер использует профиль Qwen Chat из настроек администратора', () => {
  const values = {
    QWEN_PROXY_TOKEN: 'server-secret',
    QWEN_27B_BASE_URL: 'https://i.moscow/api/dit/proxy/operation/openqwen/model-v43/v1',
    QWEN_27B_MODEL: 'local_huggingface/Qwen3.6-27B',
    QWEN_REQUEST_TIMEOUT_MS: '2400000'
  };
  const config = anonymizerQwenConfig((key) => values[key]);
  assert.equal(config.profile, 'qwen3.6-27b');
  assert.equal(config.model, values.QWEN_27B_MODEL);
  assert.equal(config.timeoutMs, 2_400_000);
  assert.equal(isQwenConfigured(config), true);

  const url = anonymizerQwenUrl(config);
  assert.equal(url.pathname, '/api/dit/proxy/operation/openqwen/model-v43/v1/chat/completions');
  assert.equal(url.searchParams.get('token'), values.QWEN_PROXY_TOKEN);
});

test('анонимайзер считается выключенным без серверного токена Qwen Chat', () => {
  const config = anonymizerQwenConfig((key) => ({
    QWEN_27B_BASE_URL: 'https://i.moscow/api/dit/proxy/operation/openqwen/model-v43/v1',
    QWEN_27B_MODEL: 'local_huggingface/Qwen3.6-27B'
  })[key]);
  assert.equal(isQwenConfigured(config), false);
});
