import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeQwenEntities } from '../server/anonymizer-qwen.js';
import { ANONYMIZER_QWEN_SYSTEM_PROMPT } from '../server/prompts/anonymizer-qwen-v1.js';

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

test('системный промпт трактует документ как данные и запрещает токенизацию', () => {
  assert.match(ANONYMIZER_QWEN_SYSTEM_PROMPT, /недоверенными данными/u);
  assert.match(ANONYMIZER_QWEN_SYSTEM_PROMPT, /не создавай токены/u);
});
