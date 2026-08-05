import test from 'node:test';
import assert from 'node:assert/strict';
import {
  looksLikeBrokenOcrText,
  mergeEntityCandidates,
  pageNeedsOcr,
  splitDetectionContributions
} from '../public/anonymizer-pipeline.js';

test('OCR включается для пустой или почти пустой PDF-страницы', () => {
  assert.equal(pageNeedsOcr('', 0), true);
  assert.equal(pageNeedsOcr('Стр. 1', 2), true);
  assert.equal(pageNeedsOcr('Это полноценный текстовый слой документа.', 12), false);
});

test('OCR повторяется для длинного, но повреждённого латинского OCR-слоя', () => {
  const brokenOcr = `
    rx peanl{3allurc [por,r3BeAeHHbrx Ha reppHTopr{Ll Poccuficxofi (De4epaqul'I
    roBapoB 3a rlpeAenbr repprlropl.ru Poccuficxofi- <Deaepaqru, 31crropr
    pe3yJrbraroB prHrenJreKryalruofi Aef,TeJrbHocrH u (utu) ycnyf B rlenrx
    rIpeAocraBJIeHI{, rpaHToB us 6loAxera ropoAa Mocxnu, rrpereHAyrouux
    Ha rrpeAocraBJreHr,re cy6cuauir t43 6roAxera ropoAa MocxsH.
  `;

  assert.equal(looksLikeBrokenOcrText(brokenOcr), true);
  assert.equal(pageNeedsOcr(brokenOcr, 120), true);
});

test('обычный русский и английский текст не считается повреждённым OCR-слоем', () => {
  const russian = 'В соответствии с постановлением Правительства Москвы объявлен отбор получателей финансовой поддержки из бюджета города.';
  const english = 'The department published a complete document with normal English sentences, readable words, application dates, contact details, and several paragraphs for review.';

  assert.equal(looksLikeBrokenOcrText(russian), false);
  assert.equal(looksLikeBrokenOcrText(english), false);
  assert.equal(pageNeedsOcr(russian, 30), false);
  assert.equal(pageNeedsOcr(english, 30), false);
});

test('Qwen добавляет только непересекающиеся кандидаты в автоматическую маскировку', () => {
  const rules = [{ id: 'rule-1', type: 'EMAIL', value: 'a@b.ru', start: 10, end: 16, action: 'MASK', source: 'rules' }];
  const qwen = [
    { id: 'qwen-1', type: 'PERSON', value: 'Иванов', start: 0, end: 6, action: 'MASK', source: 'qwen' },
    { id: 'qwen-2', type: 'OTHER', value: 'a@b', start: 10, end: 13, action: 'MASK', source: 'qwen' }
  ];
  const merged = mergeEntityCandidates(rules, qwen);
  assert.equal(merged.length, 2);
  assert.equal(merged.find((item) => item.source === 'qwen').action, 'MASK');
  assert.equal(merged.some((item) => item.id === 'qwen-2'), false);
});

test('вклад системы и ИИ считается по источнику без ручных объектов', () => {
  const contributions = splitDetectionContributions([
    { id: 'rule-1', source: 'rules' },
    { id: 'ocr-1', source: 'rules-ocr' },
    { id: 'legacy-rule' },
    { id: 'qwen-1', source: 'qwen' },
    { id: 'manual-1', source: 'manual' },
    { id: 'manual-2', source: 'manual-selection' }
  ]);

  assert.deepEqual(contributions.system.map((item) => item.id), ['rule-1', 'ocr-1', 'legacy-rule']);
  assert.deepEqual(contributions.ai.map((item) => item.id), ['qwen-1']);
});
