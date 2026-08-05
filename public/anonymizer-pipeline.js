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

export function mergeEntityCandidates(ruleEntities = [], qwenEntities = []) {
  const merged = [...ruleEntities];
  for (const candidate of qwenEntities) {
    if (!candidate || !Number.isInteger(candidate.start) || !Number.isInteger(candidate.end)) continue;
    if (merged.some((current) => overlaps(current, candidate))) continue;
    merged.push({ ...candidate, action: 'MASK', source: 'qwen' });
  }
  return merged.sort((left, right) => left.start - right.start || left.end - right.end);
}
