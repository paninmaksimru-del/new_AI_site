const HORIZONTAL_SPACE = /[ \t\f\v\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000]/u;
const ZERO_WIDTH = /[\u200B\u200C\u200D\u2060\uFEFF]/u;
const CYRILLIC_LETTER = /[А-ЯЁа-яё]/u;
const LOWER_CYRILLIC = /[а-яё]/u;
const UPPER_CYRILLIC = /[А-ЯЁ]/u;
const OCR_DIGIT_MAP = Object.freeze({
  O: '0', o: '0', О: '0', о: '0',
  I: '1', l: '1', i: '1', І: '1', і: '1',
  З: '3', з: '3',
  Ч: '4', ч: '4',
  Б: '6', б: '6',
  В: '8', в: '8'
});

function unit(char, start, end = start + 1) {
  return { char, start, end };
}

function sourceUnits(input) {
  const source = String(input || '');
  const units = [];
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (char === '\r' && source[index + 1] === '\n') {
      units.push(unit('\n', index, index + 2));
      index += 1;
      continue;
    }
    if (char === '\r') {
      units.push(unit('\n', index, index + 1));
      continue;
    }
    if (ZERO_WIDTH.test(char)) continue;
    if (HORIZONTAL_SPACE.test(char)) {
      units.push(unit(' ', index, index + 1));
      continue;
    }
    if (/[‐‑‒–—−]/u.test(char)) {
      units.push(unit('-', index, index + 1));
      continue;
    }
    units.push(unit(char, index, index + 1));
  }
  return { source, units };
}

function textOf(units) {
  return units.map((entry) => entry.char).join('');
}

function mergeSpan(units, start, end, replacement) {
  const slice = units.slice(start, end);
  const sourceStart = slice[0]?.start ?? units[start - 1]?.end ?? 0;
  const sourceEnd = slice.at(-1)?.end ?? sourceStart;
  return [...String(replacement || '')].map((char) => unit(char, sourceStart, sourceEnd));
}

function normalizeWhitespace(units, corrections) {
  const output = [];
  for (let index = 0; index < units.length; index += 1) {
    const current = units[index];
    if (current.char !== ' ') {
      output.push(current);
      continue;
    }
    let end = index + 1;
    while (end < units.length && units[end].char === ' ') end += 1;
    const previous = output.at(-1)?.char || '';
    const next = units[end]?.char || '';
    if (!previous || previous === '\n' || next === '\n' || /[,.!?;:%)\]}]/u.test(next)) {
      corrections.removedWhitespace += end - index;
    } else {
      output.push(unit(' ', current.start, units[end - 1].end));
      if (end - index > 1) corrections.collapsedWhitespace += end - index - 1;
    }
    index = end - 1;
  }
  return output;
}

function collapseBlankLines(units, corrections) {
  const output = [];
  let newlineRun = 0;
  for (const current of units) {
    if (current.char === '\n') {
      newlineRun += 1;
      if (newlineRun <= 2) output.push(current);
      else corrections.collapsedBlankLines += 1;
    } else {
      newlineRun = 0;
      output.push(current);
    }
  }
  return output;
}

function joinHyphenatedLineBreaks(units, corrections) {
  const output = [];
  for (let index = 0; index < units.length; index += 1) {
    const current = units[index];
    if (current.char !== '-' || units[index + 1]?.char !== '\n') {
      output.push(current);
      continue;
    }
    const previous = output.at(-1)?.char || '';
    const next = units[index + 2]?.char || '';
    if (CYRILLIC_LETTER.test(previous) && LOWER_CYRILLIC.test(next)) {
      corrections.joinedLineBreaks += 1;
      index += 1;
      continue;
    }
    output.push(current);
  }
  return output;
}

function collapseSpacedWords(units, corrections) {
  const text = textOf(units);
  const pattern = /(?<![А-ЯЁа-яё])(?:[А-ЯЁа-яё][ \n]){4,}[А-ЯЁа-яё](?![А-ЯЁа-яё])/gu;
  const replacements = [];
  let match;
  while ((match = pattern.exec(text)) !== null) {
    const letters = [...match[0]].filter((char) => CYRILLIC_LETTER.test(char));
    const titleCase = UPPER_CYRILLIC.test(letters[0]) && letters.slice(1).every((char) => LOWER_CYRILLIC.test(char));
    const upperCase = letters.every((char) => UPPER_CYRILLIC.test(char));
    const lowerCase = letters.every((char) => LOWER_CYRILLIC.test(char));
    if (!titleCase && !upperCase && !lowerCase) continue;
    replacements.push({ start: match.index, end: match.index + match[0].length, letters });
  }
  if (!replacements.length) return units;
  const output = [];
  let cursor = 0;
  for (const replacement of replacements) {
    output.push(...units.slice(cursor, replacement.start));
    for (let index = replacement.start; index < replacement.end; index += 1) {
      if (CYRILLIC_LETTER.test(units[index].char)) output.push(units[index]);
    }
    corrections.joinedSpacedWords += 1;
    cursor = replacement.end;
  }
  output.push(...units.slice(cursor));
  return output;
}

function normalizeEmailSpacing(units, corrections) {
  let output = [...units];
  const compactAround = (symbol) => {
    const next = [];
    for (let index = 0; index < output.length; index += 1) {
      if (output[index].char !== symbol) {
        next.push(output[index]);
        continue;
      }
      while (next.at(-1)?.char === ' ') {
        next.pop();
        corrections.contactSpacing += 1;
      }
      next.push(output[index]);
      while (output[index + 1]?.char === ' ') {
        index += 1;
        corrections.contactSpacing += 1;
      }
    }
    output = next;
  };
  compactAround('@');

  // Dots are compacted only inside a token that already contains @.
  const text = textOf(output);
  const emailWindow = /[^\s<>;,]+@[^\s<>;,]+/gu;
  const ranges = [];
  let match;
  while ((match = emailWindow.exec(text)) !== null) ranges.push({ start: match.index, end: match.index + match[0].length });
  if (!ranges.length) return output;
  const next = [];
  for (let index = 0; index < output.length; index += 1) {
    const inEmail = ranges.some((range) => index >= range.start && index < range.end);
    if (inEmail && output[index].char === ' ' && (output[index - 1]?.char === '.' || output[index + 1]?.char === '.')) {
      corrections.contactSpacing += 1;
      continue;
    }
    next.push(output[index]);
  }
  return next;
}

function normalizeOcrDigitConfusables(units, corrections) {
  const text = textOf(units);
  const pattern = /(?<![\p{L}])[0-9OОoоIІilіЗзЧчБбВв()\- +]{6,}(?![\p{L}])/gu;
  const output = [...units];
  let match;
  while ((match = pattern.exec(text)) !== null) {
    const value = match[0];
    const digitCount = (value.match(/\d/g) || []).length;
    const mappedCount = [...value].filter((char) => OCR_DIGIT_MAP[char]).length;
    if (digitCount < 4 || mappedCount === 0 || mappedCount > 4) continue;
    for (let offset = 0; offset < value.length; offset += 1) {
      const mapped = OCR_DIGIT_MAP[value[offset]];
      if (!mapped) continue;
      output[match.index + offset] = { ...output[match.index + offset], char: mapped };
      corrections.ocrDigitCorrections += 1;
    }
  }
  return output;
}

function trimEdges(units, corrections) {
  let start = 0;
  let end = units.length;
  while (start < end && /[ \n]/u.test(units[start].char)) start += 1;
  while (end > start && /[ \n]/u.test(units[end - 1].char)) end -= 1;
  corrections.trimmedCharacters += start + (units.length - end);
  return units.slice(start, end);
}

export function mapNormalizedRange(normalization, start, end) {
  const units = normalization?.units || [];
  const safeStart = Math.max(0, Math.min(units.length, Number(start) || 0));
  const safeEnd = Math.max(safeStart, Math.min(units.length, Number(end) || 0));
  if (safeStart === safeEnd) {
    const point = units[safeStart]?.start ?? units[safeStart - 1]?.end ?? 0;
    return { start: point, end: point };
  }
  return {
    start: units[safeStart]?.start ?? 0,
    end: units[safeEnd - 1]?.end ?? normalization.source.length
  };
}

export function mapEntityToSource(entity, normalization) {
  const range = mapNormalizedRange(normalization, entity?.start, entity?.end);
  return {
    ...entity,
    start: range.start,
    end: range.end,
    value: normalization.source.slice(range.start, range.end),
    normalizedValue: String(entity?.value || '')
  };
}

export function normalizeTextWithMap(input, options = {}) {
  const initial = sourceUnits(input);
  const corrections = {
    collapsedWhitespace: 0,
    removedWhitespace: 0,
    collapsedBlankLines: 0,
    joinedLineBreaks: 0,
    joinedSpacedWords: 0,
    contactSpacing: 0,
    ocrDigitCorrections: 0,
    trimmedCharacters: 0
  };
  let units = initial.units;
  units = joinHyphenatedLineBreaks(units, corrections);
  units = normalizeWhitespace(units, corrections);
  units = collapseBlankLines(units, corrections);
  units = collapseSpacedWords(units, corrections);
  units = normalizeEmailSpacing(units, corrections);
  // Консервативное исправление букв внутри цифровых последовательностей безопасно
  // и полезно для любого источника, не только для явно запущенного OCR.
  units = normalizeOcrDigitConfusables(units, corrections);
  units = trimEdges(units, corrections);
  const text = textOf(units);
  return {
    source: initial.source,
    text,
    units,
    changed: text !== initial.source,
    corrections,
    correctionCount: Object.values(corrections).reduce((sum, count) => sum + count, 0),
    mode: options.ocr ? 'ocr' : 'standard'
  };
}
