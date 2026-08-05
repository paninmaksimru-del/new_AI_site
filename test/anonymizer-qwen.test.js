import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ANONYMIZER_QWEN_PROMPT_VERSION,
  ANONYMIZER_QWEN_SYSTEM_PROMPT
} from '../server/prompts/anonymizer-qwen-v2.js';

process.env.DATABASE_URL ||= 'postgresql://localhost/mik_anonymizer_unit_test';
const {
  anonymizerQwenConfig,
  anonymizerQwenUrl,
  findEntitiesWithQwen,
  inspectQwenEntities,
  isQwenConfigured,
  normalizeQwenEntities
} = await import('../server/anonymizer-qwen.js');

test('сервер восстанавливает диапазон Qwen по точному значению из исходного текста', () => {
  const text = 'Получатель: Иванов Иван.';
  const start = text.indexOf('Иванов');
  const inspected = inspectQwenEntities(text, { entities: [
    { type: 'PERSON', value: 'Иванов Иван', start: 0, end: 5, confidence: 'high', reason: 'ФИО' }
  ] });
  assert.equal(inspected.entities.length, 1);
  assert.equal(inspected.entities[0].start, start);
  assert.equal(inspected.entities[0].end, text.length - 1);
  assert.equal(inspected.entities[0].source, 'qwen');
  assert.equal(inspected.entities[0].action, 'REVIEW');
  assert.equal(inspected.diagnostics.repaired, 1);
  assert.equal(normalizeQwenEntities(text, { entities: [{ type: 'PERSON', value: 'Петров', start: 0, end: 6 }] }).length, 0);
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
    { type: 'PERSON', value: '', start: 'не индекс', end: 6 }
  ] });

  assert.equal(result.entities.length, 1);
  assert.deepEqual(result.diagnostics, {
    returned: 5,
    located: 1,
    repaired: 0,
    accepted: 1,
    rejected: 4,
    reasons: {
      duplicate: 1,
      value_not_found: 1,
      type_not_allowed: 1,
      value_missing: 1
    }
  });
  assert.equal(JSON.stringify(result.diagnostics).includes('Иванов'), false);
});

test('приблизительные позиции связывают повторяющиеся значения с разными вхождениями', () => {
  const text = 'Согласовала Анна Смирнова. Получатель — Анна Смирнова.';
  const starts = [];
  let offset = 0;
  while ((offset = text.indexOf('Анна Смирнова', offset)) >= 0) {
    starts.push(offset);
    offset += 1;
  }
  const result = inspectQwenEntities(text, { entities: [
    { type: 'PERSON', value: 'Анна Смирнова', start: starts[0] + 5, end: starts[0] + 8 },
    { type: 'PERSON', value: 'Анна Смирнова', start: starts[1] + 5, end: starts[1] + 8 }
  ] });

  assert.deepEqual(result.entities.map((entity) => entity.start), starts);
  assert.equal(result.diagnostics.repaired, 2);
  assert.equal(result.diagnostics.rejected, 0);
});

test('сервер ждёт Qwen и отправляет модели задачу, промпт, формат и текст документа', async () => {
  const originalFetch = globalThis.fetch;
  const text = 'Получатель выплаты — Анна Смирнова.';
  const config = {
    proxyToken: 'server-secret',
    baseUrl: 'https://i.moscow/api/dit/proxy/operation/openqwen/model-v43/v1',
    model: 'local_huggingface/Qwen3.6-27B',
    timeoutMs: 5_000
  };
  let resolveFetch;
  let upstreamRequest;
  try {
    globalThis.fetch = async (url, options) => {
      upstreamRequest = { url: String(url), options };
      return new Promise((resolve) => { resolveFetch = resolve; });
    };
    let settled = false;
    const pending = findEntitiesWithQwen(text, [], config, { format: 'docx', size: 3210 });
    pending.finally(() => { settled = true; });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(settled, false);

    const body = JSON.parse(upstreamRequest.options.body);
    const userPayload = JSON.parse(body.messages[1].content);
    assert.match(upstreamRequest.url, /\/chat\/completions\?token=server-secret$/u);
    assert.equal(upstreamRequest.options.method, 'POST');
    assert.equal(body.model, config.model);
    assert.deepEqual(body.response_format, { type: 'json_object' });
    assert.equal(body.messages[0].content, ANONYMIZER_QWEN_SYSTEM_PROMPT);
    assert.equal(userPayload.task, 'find_additional_sensitive_entities');
    assert.equal(userPayload.document.format, 'docx');
    assert.equal(userPayload.document.text, text);
    assert.deepEqual(userPayload.ruleCandidates, []);

    resolveFetch({
      ok: true,
      status: 200,
      async json() {
        return { choices: [{ message: { content: JSON.stringify({ entities: [
          { type: 'PERSON', value: 'Анна Смирнова', start: 0, end: 4, confidence: 'high' }
        ] }) } }] };
      }
    });
    const result = await pending;
    assert.equal(result.upstreamStatus, 200);
    assert.equal(result.attempts, 1);
    assert.equal(result.entities.length, 1);
    assert.equal(result.diagnostics.repaired, 1);
    assert.equal(result.diagnostics.addedToResult, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('временный 504 от прокси повторяется один раз перед успешным ответом', async () => {
  const originalFetch = globalThis.fetch;
  const config = {
    proxyToken: 'server-secret',
    baseUrl: 'https://i.moscow/api/dit/proxy/operation/openqwen/model-v43/v1',
    model: 'local_huggingface/Qwen3.6-27B',
    timeoutMs: 5_000,
    retryDelayMs: 0
  };
  let calls = 0;
  try {
    globalThis.fetch = async () => {
      calls += 1;
      if (calls === 1) return { ok: false, status: 504 };
      return {
        ok: true,
        status: 200,
        async json() {
          return { choices: [{ message: { content: '{"entities":[]}' } }] };
        }
      };
    };
    const result = await findEntitiesWithQwen('Документ без новых данных.', [], config, { format: 'docx' });
    assert.equal(calls, 2);
    assert.equal(result.attempts, 2);
    assert.equal(result.upstreamStatus, 200);
    assert.equal(result.diagnostics.returned, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('системный промпт трактует документ как данные и запрещает токенизацию', () => {
  assert.equal(ANONYMIZER_QWEN_PROMPT_VERSION, 'anonymizer-ner-v2');
  assert.match(ANONYMIZER_QWEN_SYSTEM_PROMPT, /недоверенными данными/u);
  assert.match(ANONYMIZER_QWEN_SYSTEM_PROMPT, /не создавай токены/u);
  assert.match(ANONYMIZER_QWEN_SYSTEM_PROMPT, /Сервер самостоятельно проверит и уточнит диапазон/u);
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
