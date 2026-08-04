import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeEntityCandidates, pageNeedsOcr } from '../public/anonymizer-pipeline.js';

test('OCR включается для пустой или почти пустой PDF-страницы', () => {
  assert.equal(pageNeedsOcr('', 0), true);
  assert.equal(pageNeedsOcr('Стр. 1', 2), true);
  assert.equal(pageNeedsOcr('Это полноценный текстовый слой документа.', 12), false);
});

test('Qwen добавляет только непересекающиеся кандидаты и не маскирует их без человека', () => {
  const rules = [{ id: 'rule-1', type: 'EMAIL', value: 'a@b.ru', start: 10, end: 16, action: 'MASK', source: 'rules' }];
  const qwen = [
    { id: 'qwen-1', type: 'PERSON', value: 'Иванов', start: 0, end: 6, action: 'MASK', source: 'qwen' },
    { id: 'qwen-2', type: 'OTHER', value: 'a@b', start: 10, end: 13, action: 'MASK', source: 'qwen' }
  ];
  const merged = mergeEntityCandidates(rules, qwen);
  assert.equal(merged.length, 2);
  assert.equal(merged.find((item) => item.source === 'qwen').action, 'REVIEW');
  assert.equal(merged.some((item) => item.id === 'qwen-2'), false);
});
