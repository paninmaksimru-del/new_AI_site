import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyReplacements,
  assignEntityGroups,
  restoreText,
  scanResidual
} from '../public/anonymizer-engine.js';
import {
  mapAnalysisEntitiesToWorkingText,
  mergeEntityCandidates,
  prepareAnonymizerAnalysis
} from '../public/anonymizer-pipeline.js';

test('сквозной OCR-сценарий: нормализация → скрипты → обезличивание → контроль → восстановление', () => {
  const source = [
    'ОБРАЩЕНИЕ',
    'Заявитель: И в а н о в а Мария Александровна',
    'Дата рождения: 7 ноября 1989 года',
    'Телефон: +7 (9З5) 12З-45-67',
    'Почта: maria.ivanova @ example.ru',
    'Адрес: 123456, г. Москва, ул. Тверская, д. 12, кв. 45',
    'Полис ОМС № 1234 5678901234',
    'Договор № МИК-2026/17 на сумму 15 000 рублей.'
  ].join('\n');

  const prepared = prepareAnonymizerAnalysis(source, { ocr: true });
  const result = applyReplacements(prepared.workingText, prepared.ruleEntities);
  const residual = scanResidual(result.text, { map: result.map });

  assert.match(prepared.workingText, /Иванова/u);
  assert.match(prepared.workingText, /\+7 \(935\) 123-45-67/u);
  assert.match(result.text, /\[\[ФИО_001\]\]/u);
  assert.match(result.text, /\[\[ТЕЛЕФОН_001\]\]/u);
  assert.match(result.text, /\[\[EMAIL_001\]\]/u);
  assert.match(result.text, /\[\[АДРЕС_001\]\]/u);
  assert.equal(residual.passed, true);
  assert.equal(restoreText(result.text, result.map), prepared.workingText);
});

test('сквозной DOCX-подход сохраняет исходные координаты и точное восстановление', () => {
  const source = 'Получатель И в а н о в а Мария Александровна, телефон +7 (9З5) 12З-45-67.';
  const prepared = prepareAnonymizerAnalysis(source, { ocr: true, preserveSource: true });
  const result = applyReplacements(prepared.workingText, prepared.ruleEntities);
  assert.doesNotMatch(result.text, /И в а н о в а|9З5/u);
  assert.equal(restoreText(result.text, result.map), source);
});

test('Qwen-связка объединяет сокращённую и полную форму ФИО в один токен', () => {
  const source = 'Иванов Иван Иванович подал заявление. Ответ направлен Иванову И.И.';
  const prepared = prepareAnonymizerAnalysis(source, { preserveSource: true });
  const aliasStart = prepared.analysisText.indexOf('Иванову И.И.');
  const qwenAnalysis = [{
    id: 'qwen-alias', type: 'PERSON', value: 'Иванову И.И.',
    start: aliasStart, end: aliasStart + 'Иванову И.И.'.length,
    source: 'qwen', action: 'REVIEW', confidence: 'high',
    canonicalValue: 'Иванов Иван Иванович'
  }];
  const qwenSource = mapAnalysisEntitiesToWorkingText(qwenAnalysis, prepared);
  const entities = assignEntityGroups(mergeEntityCandidates(prepared.ruleEntities, qwenSource));
  const result = applyReplacements(source, entities);
  assert.equal(result.map.entries.filter((entry) => entry.type === 'PERSON').length, 1);
  assert.equal(result.text.match(/\[\[ФИО_001\]\]/g)?.length, 2);
});
