const OCR_MIN_TEXT_LENGTH = 24;

const LATIN_LETTER_PATTERN = /[A-Za-z]/g;
const CYRILLIC_LETTER_PATTERN = /[А-ЯЁа-яё]/g;
const OCR_TOKEN_PATTERN = /[A-Za-z0-9[\]{}|\\]{3,}/g;

function matchCount(value, pattern) {
  return String(value || '').match(pattern)?.length || 0;
}

// Some scanner OCR layers contain Cyrillic-shaped ASCII (for example, "Mocxnu")
// and are long enough to pass the usual "text exists" check.
export function looksLikeBrokenOcrText(text) {
  const value = String(text || '');
  const latinLetters = matchCount(value, LATIN_LETTER_PATTERN);
  const cyrillicLetters = matchCount(value, CYRILLIC_LETTER_PATTERN);
  const letterCount = latinLetters + cyrillicLetters;
  if (letterCount < 80 || latinLetters / letterCount < 0.7 || cyrillicLetters / letterCount > 0.2) return false;

  const tokens = value.match(OCR_TOKEN_PATTERN) || [];
  if (tokens.length < 12) return false;

  let malformedTokens = 0;
  let mixedCaseTokens = 0;
  let substitutedTokens = 0;
  for (const token of tokens) {
    const plainLatin = /^[A-Za-z]+$/.test(token);
    const hasMixedCase = plainLatin
      && /[A-Z]/.test(token)
      && /[a-z]/.test(token)
      && !/^[A-Z][a-z]+$/.test(token);
    const hasSubstitution = /(?:[A-Za-z][0-9[\]{}|\\]|[0-9[\]{}|\\][A-Za-z])/.test(token);
    if (hasMixedCase) mixedCaseTokens += 1;
    if (hasSubstitution) substitutedTokens += 1;
    if (hasMixedCase || hasSubstitution) malformedTokens += 1;
  }

  return malformedTokens >= 8
    && malformedTokens / tokens.length >= 0.14
    && mixedCaseTokens >= 5
    && substitutedTokens >= 2;
}

export function pageNeedsOcr(text, itemCount = 0) {
  const compact = String(text || '').replace(/\s+/g, '');
  return compact.length < OCR_MIN_TEXT_LENGTH
    || Number(itemCount) < 3
    || looksLikeBrokenOcrText(text);
}

function overlaps(left, right) {
  return left.start < right.end && right.start < left.end;
}

const QWEN_AUTO_MASK_TYPES = new Set([
  'PERSON', 'ADDRESS', 'PHONE', 'EMAIL', 'PASSPORT', 'SNILS', 'INN',
  'BANK_ACCOUNT', 'BIK', 'CARD', 'BIRTH_DATE'
]);

export function qwenCandidateAction(candidate) {
  const confidence = String(candidate?.confidence || '').toLowerCase();
  const type = String(candidate?.type || '').toUpperCase();
  return confidence === 'high' && QWEN_AUTO_MASK_TYPES.has(type) ? 'MASK' : 'REVIEW';
}

export function mergeEntityCandidates(ruleEntities = [], qwenEntities = []) {
  const merged = [...ruleEntities];
  for (const candidate of qwenEntities) {
    if (!candidate || !Number.isInteger(candidate.start) || !Number.isInteger(candidate.end)) continue;
    if (merged.some((current) => overlaps(current, candidate))) continue;
    // Низкая уверенность слишком шумная для пользовательского реестра. Средняя
    // остаётся REVIEW, а автоматически меняют документ только high-confidence
    // находки по типам персональных данных с понятной семантикой.
    if (String(candidate.confidence || '').toLowerCase() === 'low') continue;
    merged.push({ ...candidate, action: qwenCandidateAction(candidate), source: 'qwen' });
  }
  return merged.sort((left, right) => left.start - right.start || left.end - right.end);
}

export function splitDetectionContributions(entities = []) {
  const system = [];
  const ai = [];

  for (const entity of entities) {
    if (!entity || typeof entity !== 'object') continue;
    const source = String(entity.source || 'rules').toLowerCase();
    if (source === 'qwen') ai.push(entity);
    else if (source === 'rules' || source.startsWith('rules-')) system.push(entity);
  }

  return { system, ai };
}

import { analyzeEntities, assignEntityGroups } from './anonymizer-engine.js';
import { mapEntityToSource } from './anonymizer-normalize.js';

export function prepareAnonymizerAnalysis(input, options = {}) {
  const sourceText = String(input || '');
  const preserveSource = Boolean(options.preserveSource);
  const analysis = analyzeEntities(sourceText, { ocr: Boolean(options.ocr) });

  if (preserveSource) {
    return {
      workingText: sourceText,
      analysisText: analysis.normalization.text,
      ruleEntities: analysis.sourceEntities,
      ruleCandidates: analysis.normalizedEntities,
      normalization: analysis.normalization,
      preserveSource: true
    };
  }

  return {
    workingText: analysis.normalization.text,
    analysisText: analysis.normalization.text,
    ruleEntities: assignEntityGroups(analysis.normalizedEntities),
    ruleCandidates: assignEntityGroups(analysis.normalizedEntities),
    normalization: analysis.normalization,
    preserveSource: false
  };
}

export function mapAnalysisEntitiesToWorkingText(entities = [], prepared) {
  if (!prepared?.preserveSource) return assignEntityGroups(entities);
  return assignEntityGroups(entities.map((entity) => mapEntityToSource(entity, prepared.normalization)));
}
