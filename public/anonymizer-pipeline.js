const OCR_MIN_TEXT_LENGTH = 24;

export function pageNeedsOcr(text, itemCount = 0) {
  const compact = String(text || '').replace(/\s+/g, '');
  return compact.length < OCR_MIN_TEXT_LENGTH || Number(itemCount) < 3;
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
