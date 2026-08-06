import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mapEntityToSource,
  mapNormalizedRange,
  normalizeTextWithMap
} from '../public/anonymizer-normalize.js';

test('нормализация удаляет невидимые и лишние пробелы, сохраняя абзацы', () => {
  const result = normalizeTextWithMap('  Иванов\u00A0\u00A0Иван  ,\n\n\nтелефон  ');
  assert.equal(result.text, 'Иванов Иван,\n\nтелефон');
  assert.ok(result.correctionCount >= 5);
});

test('побуквенно разорванная OCR-фамилия собирается обратно', () => {
  const result = normalizeTextWithMap('Получатель: И в а н о в а Мария.');
  assert.equal(result.text, 'Получатель: Иванова Мария.');
  assert.equal(result.corrections.joinedSpacedWords, 1);
});

test('перенос слова с дефисом склеивается без потери координат', () => {
  const source = 'персо-\nнальные данные';
  const result = normalizeTextWithMap(source);
  assert.equal(result.text, 'персональные данные');
  const range = mapNormalizedRange(result, 0, 'персональные'.length);
  assert.equal(source.slice(range.start, range.end), 'персо-\nнальные');
});

test('OCR-путаница букв и цифр исправляется внутри длинного номера', () => {
  const result = normalizeTextWithMap('Телефон +7 (9З5) 12З-45-67', { ocr: true });
  assert.equal(result.text, 'Телефон +7 (935) 123-45-67');
  assert.equal(result.corrections.ocrDigitCorrections, 2);
});

test('пробелы вокруг @ удаляются для поиска электронной почты', () => {
  const result = normalizeTextWithMap('Почта: ivanov @ example.ru');
  assert.equal(result.text, 'Почта: ivanov@example.ru');
});

test('сущность из нормализованного текста возвращается к исходному диапазону', () => {
  const source = 'ФИО: И в а н о в а Мария';
  const result = normalizeTextWithMap(source);
  const start = result.text.indexOf('Иванова');
  const mapped = mapEntityToSource({ type: 'PERSON', value: 'Иванова', start, end: start + 7 }, result);
  assert.equal(mapped.value, 'И в а н о в а');
  assert.equal(mapped.normalizedValue, 'Иванова');
});

test('обычный грамотный текст не переписывается', () => {
  const source = 'Иванов Иван Иванович подписал договор № 17.';
  const result = normalizeTextWithMap(source, { ocr: false });
  assert.equal(result.text, source);
  assert.equal(result.changed, false);
});

test('консервативное исправление OCR-цифр работает и в стандартном режиме', () => {
  const result = normalizeTextWithMap('Телефон +7 (9З5) 12З-45-67', { ocr: false });
  assert.equal(result.text, 'Телефон +7 (935) 123-45-67');
});
