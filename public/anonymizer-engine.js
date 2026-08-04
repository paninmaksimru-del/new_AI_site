const TYPE_DEFINITIONS = {
  PERSON: { label: "ФИО", token: "ФИО", defaultAction: "MASK", critical: true, priority: 100 },
  ADDRESS: { label: "Адрес", token: "АДРЕС", defaultAction: "MASK", critical: true, priority: 95 },
  PHONE: { label: "Телефон", token: "ТЕЛЕФОН", defaultAction: "MASK", critical: true, priority: 120 },
  EMAIL: { label: "Электронная почта", token: "EMAIL", defaultAction: "MASK", critical: true, priority: 125 },
  PASSPORT: { label: "Паспорт", token: "ПАСПОРТ", defaultAction: "MASK", critical: true, priority: 150 },
  SNILS: { label: "СНИЛС", token: "СНИЛС", defaultAction: "MASK", critical: true, priority: 145 },
  INN: { label: "ИНН", token: "ИНН", defaultAction: "MASK", critical: true, priority: 140 },
  BANK_ACCOUNT: { label: "Банковский счёт", token: "СЧЁТ", defaultAction: "MASK", critical: true, priority: 135 },
  BIK: { label: "БИК", token: "БИК", defaultAction: "MASK", critical: true, priority: 130 },
  CARD: { label: "Номер карты", token: "КАРТА", defaultAction: "MASK", critical: true, priority: 132 },
  CONTRACT_NUMBER: { label: "Номер договора", token: "ДОГОВОР", defaultAction: "MASK", critical: false, priority: 85 },
  ORGANIZATION: { label: "Организация", token: "ОРГ", defaultAction: "REVIEW", critical: false, priority: 60 },
  MONEY: { label: "Сумма", token: "СУММА", defaultAction: "REVIEW", critical: false, priority: 55 },
  BIRTH_DATE: { label: "Дата рождения", token: "ДАТА", defaultAction: "MASK", critical: true, priority: 90 },
  OTHER: { label: "Другое", token: "ДАННЫЕ", defaultAction: "REVIEW", critical: false, priority: 10 }
};

const PUBLIC_ORGANIZATIONS = [
  /правительство\s+москвы/iu,
  /правительство\s+российской\s+федерации/iu,
  /верховн(?:ый|ого)\s+суд/iu,
  /конституционн(?:ый|ого)\s+суд/iu,
  /департамент\s+предпринимательства\s+и\s+инновационного\s+развития/iu,
  /аппарат\s+мэра\s+и\s+правительства\s+москвы/iu
];

const TOKEN_PATTERN = /\[\[[А-ЯЁA-Z_]+_\d{3,}\]\]/gu;

const normalizeValue = (value) => String(value || "")
  .trim()
  .toLocaleLowerCase("ru-RU")
  .replace(/[«»“”„"]/g, "")
  .replace(/\s+/g, " ");

const onlyDigits = (value) => String(value || "").replace(/\D/g, "");

function hashString(value) {
  let hash = 0x811c9dc5;
  const input = String(value || "");
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export function fingerprintText(value) {
  const text = String(value || "");
  return `fnv1a32:${hashString(text)}:${text.length}`;
}

export function validInn(value) {
  const digits = onlyDigits(value).split("").map(Number);
  if (digits.length === 10) {
    const weights = [2, 4, 10, 3, 5, 9, 4, 6, 8];
    return weights.reduce((sum, weight, index) => sum + weight * digits[index], 0) % 11 % 10 === digits[9];
  }
  if (digits.length === 12) {
    const weights11 = [7, 2, 4, 10, 3, 5, 9, 4, 6, 8];
    const weights12 = [3, 7, 2, 4, 10, 3, 5, 9, 4, 6, 8];
    const digit11 = weights11.reduce((sum, weight, index) => sum + weight * digits[index], 0) % 11 % 10;
    const digit12 = weights12.reduce((sum, weight, index) => sum + weight * digits[index], 0) % 11 % 10;
    return digit11 === digits[10] && digit12 === digits[11];
  }
  return false;
}

export function validSnils(value) {
  const digits = onlyDigits(value);
  if (digits.length !== 11) return false;
  if (Number(digits.slice(0, 9)) <= 1001998) return true;
  let sum = 0;
  for (let index = 0; index < 9; index += 1) sum += Number(digits[index]) * (9 - index);
  let control = sum < 100 ? sum : (sum === 100 || sum === 101 ? 0 : sum % 101);
  if (control === 100) control = 0;
  return control === Number(digits.slice(9));
}

function isPublicOrganization(value) {
  return PUBLIC_ORGANIZATIONS.some((pattern) => pattern.test(value));
}

function addMatches(text, type, regex, output, options = {}) {
  let match;
  regex.lastIndex = 0;
  while ((match = regex.exec(text)) !== null) {
    const captured = options.group ? match[options.group] : match[0];
    if (!captured || (options.validate && !options.validate(captured)) || (options.reject && options.reject(captured))) {
      if (match[0].length === 0) regex.lastIndex += 1;
      continue;
    }
    const relative = match[0].indexOf(captured);
    const start = match.index + Math.max(0, relative);
    output.push({
      id: `${type}-${start}-${output.length}`,
      type,
      value: captured,
      start,
      end: start + captured.length,
      action: options.action || TYPE_DEFINITIONS[type]?.defaultAction || "REVIEW",
      confidence: options.confidence || "medium",
      source: options.source || "rules"
    });
    if (match[0].length === 0) regex.lastIndex += 1;
  }
}

function overlaps(left, right) {
  return left.start < right.end && right.start < left.end;
}

function resolveOverlaps(items) {
  const ordered = [...items].sort((left, right) => {
    const leftPriority = TYPE_DEFINITIONS[left.type]?.priority || 0;
    const rightPriority = TYPE_DEFINITIONS[right.type]?.priority || 0;
    return rightPriority - leftPriority || (right.end - right.start) - (left.end - left.start) || left.start - right.start;
  });
  const accepted = [];
  for (const item of ordered) {
    if (!accepted.some((current) => overlaps(item, current))) accepted.push(item);
  }
  return accepted.sort((left, right) => left.start - right.start);
}

function personIdentity(value) {
  const compact = String(value || "")
    .trim()
    .toLocaleLowerCase("ru-RU")
    .replace(/\s+/g, " ");
  let match = compact.match(/^([а-яё])\.\s*([а-яё])\.\s*([а-яё-]{2,})$/u);
  if (match) return `${match[3]}|${match[1]}|${match[2]}`;
  match = compact.match(/^([а-яё-]{2,})\s+([а-яё])\.\s*([а-яё])\.$/u);
  if (match) return `${match[1]}|${match[2]}|${match[3]}`;
  const words = compact.replace(/[.]/g, " ").split(/\s+/u).filter(Boolean);
  if (words.length >= 3) return `${words[0]}|${words[1][0]}|${words[2][0]}`;
  return compact.replace(/[.\s]/g, "");
}

export function entityIdentity(item) {
  const type = TYPE_DEFINITIONS[item?.type] ? item.type : "OTHER";
  const value = String(item?.value || "");
  if (type === "PERSON") return `${type}\u0000${personIdentity(value)}`;
  if (["PHONE", "PASSPORT", "SNILS", "INN", "BANK_ACCOUNT", "BIK", "CARD"].includes(type)) {
    return `${type}\u0000${onlyDigits(value)}`;
  }
  return `${type}\u0000${normalizeValue(value)}`;
}

function automaticGroupId(item) {
  return `group-${item.type}-${hashString(entityIdentity(item))}`;
}

export function assignEntityGroups(entities) {
  return (entities || []).map((item) => ({
    ...item,
    groupId: item.groupId || automaticGroupId(item)
  }));
}

export function detectEntities(input) {
  const text = String(input || "");
  const found = [];

  addMatches(text, "EMAIL", /[A-ZА-ЯЁ0-9._%+-]+@[A-ZА-ЯЁ0-9.-]+\.[A-ZА-ЯЁ]{2,}/giu, found, { confidence: "high" });
  addMatches(text, "PHONE", /(?<!\d)(?:\+7|8)[ \t\-(]*(?:\d[ \t\-()]*){10}(?!\d)/g, found, { confidence: "high" });
  addMatches(text, "PASSPORT", /(?:паспорт(?:\s+гражданина)?(?:\s+РФ)?|серия)\s*[:№]?\s*((?:\d{2}\s*\d{2}|\d{4})\s*№?\s*\d{6})/giu, found, { group: 1, confidence: "high" });
  addMatches(text, "SNILS", /(?:СНИЛС\s*[:№]?\s*)?(?<!\d)(\d{3}[\s-]?\d{3}[\s-]?\d{3}[\s-]?\d{2})(?!\d)/giu, found, { group: 1, validate: validSnils, confidence: "high" });
  addMatches(text, "INN", /(?:ИНН\s*[:№]?\s*)?(\d{10}|\d{12})(?!\d)/giu, found, { group: 1, validate: validInn, confidence: "high" });
  addMatches(text, "BANK_ACCOUNT", /(?:р\/?с|к\/?с|расч[её]тный\s+сч[её]т|корр(?:еспондентский)?\s+сч[её]т|сч[её]т)\s*[:№]?\s*(\d{20})(?!\d)/giu, found, { group: 1, confidence: "high" });
  addMatches(text, "BIK", /(?:БИК)\s*[:№]?\s*(\d{9})(?!\d)/giu, found, { group: 1, confidence: "high" });
  addMatches(text, "CARD", /(?:карта|номер\s+карты)\s*[:№]?\s*((?:\d[ -]?){15}\d)(?!\d)/giu, found, { group: 1, confidence: "medium" });
  addMatches(text, "BIRTH_DATE", /(?:дата\s+рождения|родил(?:ся|ась))\s*[:\-]?\s*((?:0?[1-9]|[12]\d|3[01])[.\/-](?:0?[1-9]|1[0-2])[.\/-](?:19|20)\d{2})/giu, found, { group: 1, confidence: "high" });

  addMatches(text, "PERSON", /(?<![А-ЯЁа-яё-])([А-ЯЁ][а-яё-]{2,30}\s+[А-ЯЁ][а-яё-]{2,30}\s+(?:[А-ЯЁ][а-яё-]{1,24}(?:ович|евич|ич|овна|евна|ична|инична)|[А-ЯЁ][а-яё-]{1,24}\s+(?:оглы|кызы)))(?![А-ЯЁа-яё-])/gu, found, { group: 1, confidence: "medium" });
  addMatches(text, "PERSON", /(?<![А-ЯЁа-яё-])([А-ЯЁ]\.\s*[А-ЯЁ]\.\s*[А-ЯЁ][а-яё-]{2,30})(?![А-ЯЁа-яё-])/gu, found, { group: 1, confidence: "medium" });
  addMatches(text, "PERSON", /(?<![А-ЯЁа-яё-])([А-ЯЁ][а-яё-]{2,30}\s+[А-ЯЁ]\.\s*[А-ЯЁ]\.)(?![А-ЯЁа-яё-])/gu, found, { group: 1, confidence: "medium" });
  addMatches(text, "PERSON", /(?:ФИО|заявитель|гражданин(?:ка)?|представитель|директор|подписант)\s*[:\-]?\s*([А-ЯЁ][а-яё-]{1,30}\s+[А-ЯЁ][а-яё-]{1,30}(?:\s+[А-ЯЁ][а-яё-]{1,30})?)/gu, found, { group: 1, confidence: "medium" });
  addMatches(text, "ADDRESS", /(?:адрес(?:\s+регистрации|\s+места\s+жительства)?|прожива(?:ет|ющий)|зарегистрирован(?:а)?)\s*[:\-]?\s*([^\n;]{8,160})/giu, found, { group: 1, confidence: "medium" });

  addMatches(text, "CONTRACT_NUMBER", /(?:договор[а-яё]*|контракт[а-яё]*|соглашени[а-яё]*|доверенност[а-яё]*)\s*(?:от\s*\d{1,2}[.\/-]\d{1,2}[.\/-]\d{2,4}\s*)?№\s*([A-ZА-ЯЁ0-9](?:[A-ZА-ЯЁ0-9_.\/-]{0,39}[A-ZА-ЯЁ0-9])?)/giu, found, { group: 1, confidence: "medium" });
  addMatches(text, "MONEY", /(?<!\w)(\d{1,3}(?:[ \u00a0]\d{3})*(?:[.,]\d{1,2})?|\d+)(?:\s*)(?:₽|руб(?:\.|лей|ля)?)/giu, found, { confidence: "medium" });
  addMatches(text, "ORGANIZATION", /(?:ООО|АО|ПАО|НКО|Фонд|ГБУ|ГКУ)\s+[«"][^»"\n]{2,70}[»"]/g, found, {
    confidence: "medium",
    reject: isPublicOrganization
  });
  addMatches(text, "ORGANIZATION", /(?:ООО|АО|ПАО|НКО|Фонд|ГБУ|ГКУ)\s+[А-ЯЁA-Z0-9][А-ЯЁа-яёA-Z0-9 .&-]{1,60}(?=[,;\n]|$)/g, found, {
    confidence: "low",
    reject: isPublicOrganization
  });

  return assignEntityGroups(resolveOverlaps(found));
}

export function addManualEntity(text, value, type = "OTHER", scope = "all") {
  const needle = String(value || "").trim();
  if (!needle) return [];
  const safeType = TYPE_DEFINITIONS[type] ? type : "OTHER";
  const items = [];
  let offset = 0;
  while ((offset = String(text || "").indexOf(needle, offset)) !== -1) {
    const entity = {
      id: `manual-${safeType}-${offset}-${items.length}`,
      type: safeType,
      value: needle,
      start: offset,
      end: offset + needle.length,
      action: "MASK",
      confidence: "confirmed",
      source: "manual"
    };
    entity.groupId = automaticGroupId(entity);
    items.push(entity);
    offset += needle.length;
    if (scope === "one") break;
  }
  return items;
}

function preferredOriginal(current, candidate) {
  if (!current) return candidate;
  const score = (value) => String(value).replace(/[.\s]/g, "").length + (String(value).includes(".") ? 0 : 20);
  return score(candidate) > score(current) ? candidate : current;
}

function tokenNumber(token) {
  const match = String(token || "").match(/_(\d+)\]\]$/u);
  return match ? Number(match[1]) : 0;
}

function tokenFor(type, number) {
  const prefix = TYPE_DEFINITIONS[type]?.token || TYPE_DEFINITIONS.OTHER.token;
  return `[[${prefix}_${String(number).padStart(3, "0")}]]`;
}

export function buildEntityRegistry(entities, options = {}) {
  const grouped = new Map();
  const canonicalOverrides = options.canonicalOverrides || {};
  const tokenAssignments = { ...(options.tokenAssignments || {}) };

  for (const item of assignEntityGroups(entities)) {
    const groupId = item.groupId;
    if (!grouped.has(groupId)) {
      grouped.set(groupId, {
        id: groupId,
        type: item.type,
        label: TYPE_DEFINITIONS[item.type]?.label || "Другое",
        action: item.action,
        original: "",
        aliases: [],
        occurrences: [],
        sources: [],
        firstStart: item.start,
        confidence: item.confidence
      });
    }
    const group = grouped.get(groupId);
    group.original = preferredOriginal(group.original, item.value);
    group.firstStart = Math.min(group.firstStart, item.start);
    group.occurrences.push({ id: item.id, start: item.start, end: item.end, original: item.value, source: item.source || "rules" });
    if (!group.sources.includes(item.source || "rules")) group.sources.push(item.source || "rules");
    let alias = group.aliases.find((candidate) => candidate.value === item.value);
    if (!alias) {
      alias = { value: item.value, count: 0 };
      group.aliases.push(alias);
    }
    alias.count += 1;
  }

  const registry = [...grouped.values()].sort((left, right) => left.firstStart - right.firstStart);
  const counters = {};
  Object.values(tokenAssignments).forEach((token) => {
    for (const [type, definition] of Object.entries(TYPE_DEFINITIONS)) {
      if (String(token).startsWith(`[[${definition.token}_`)) {
        counters[type] = Math.max(counters[type] || 0, tokenNumber(token));
      }
    }
  });

  registry.forEach((group) => {
    group.original = canonicalOverrides[group.id] || group.original;
    if (group.action !== "MASK") return;
    let token = tokenAssignments[group.id];
    const expectedPrefix = `[[${TYPE_DEFINITIONS[group.type]?.token || TYPE_DEFINITIONS.OTHER.token}_`;
    if (!String(token || "").startsWith(expectedPrefix)) {
      counters[group.type] = (counters[group.type] || 0) + 1;
      token = tokenFor(group.type, counters[group.type]);
      tokenAssignments[group.id] = token;
    }
    group.token = token;
  });

  return { registry, tokenAssignments };
}

function replaceRanges(text, replacements) {
  let output = String(text || "");
  [...replacements].sort((left, right) => right.start - left.start).forEach((item) => {
    output = output.slice(0, item.start) + item.token + output.slice(item.end);
  });
  return output;
}

export function applyReplacements(input, entities, options = {}) {
  const text = String(input || "");
  const selected = resolveOverlaps(assignEntityGroups(entities).filter((item) => item.action === "MASK"));
  const { registry, tokenAssignments } = buildEntityRegistry(selected, options);
  const groupById = new Map(registry.map((group) => [group.id, group]));
  const replacements = selected.map((item) => ({ ...item, token: groupById.get(item.groupId).token }));
  const output = replaceRanges(text, replacements);
  const entries = registry.map(({ firstStart, confidence, action, ...entry }) => entry);
  const sessionId = options.sessionId || `session-${Date.now()}-${hashString(text).slice(0, 6)}`;

  return {
    text: output,
    replacements,
    registry,
    tokenAssignments,
    map: {
      format: "mik-anonymizer-map",
      version: 2,
      sessionId,
      createdAt: options.createdAt || new Date().toISOString(),
      sourceFingerprint: fingerprintText(text),
      safeFingerprint: fingerprintText(output),
      entries
    }
  };
}

export function extractTokens(input) {
  return [...new Set(String(input || "").match(TOKEN_PATTERN) || [])];
}

export function validateMap(map) {
  const errors = [];
  if (!map || map.format !== "mik-anonymizer-map") errors.push("Неизвестный формат карты.");
  if (!Array.isArray(map?.entries)) errors.push("В карте отсутствует список замен.");
  const tokens = new Set();
  for (const entry of map?.entries || []) {
    if (!entry.token || !entry.original) errors.push("В карте есть неполная запись.");
    if (tokens.has(entry.token)) errors.push(`Токен ${entry.token} указан несколько раз.`);
    tokens.add(entry.token);
  }
  return { ok: errors.length === 0, errors };
}

export function restoreWithDiagnostics(input, map) {
  const text = String(input || "");
  const validation = validateMap(map);
  if (!validation.ok) return { ok: false, text, restored: text, errors: validation.errors, unknownTokens: [], unusedTokens: [] };
  const entriesByToken = new Map(map.entries.map((entry) => [entry.token, entry]));
  const foundTokens = extractTokens(text);
  const unknownTokens = foundTokens.filter((token) => !entriesByToken.has(token));
  const usedTokens = foundTokens.filter((token) => entriesByToken.has(token));
  const unusedTokens = map.entries.map((entry) => entry.token).filter((token) => !foundTokens.includes(token));
  let restored = text;
  [...map.entries].sort((left, right) => right.token.length - left.token.length).forEach((entry) => {
    restored = restored.split(entry.token).join(entry.original);
  });
  return {
    ok: unknownTokens.length === 0,
    text,
    restored,
    errors: [],
    unknownTokens,
    usedTokens,
    unusedTokens,
    replacedCount: usedTokens.reduce((sum, token) => sum + text.split(token).length - 1, 0),
    sourceMatchesMap: !map.safeFingerprint || map.safeFingerprint === fingerprintText(text)
  };
}

export function restoreText(input, map) {
  return restoreWithDiagnostics(input, map).restored;
}

export function validateIntegrity(original, anonymized, replacements) {
  const expected = replaceRanges(String(original || ""), replacements || []);
  const actual = String(anonymized || "");
  if (expected === actual) {
    return { ok: true, status: "passed", message: "Изменены только подтверждённые фрагменты.", firstDifference: -1 };
  }
  let firstDifference = 0;
  const limit = Math.min(expected.length, actual.length);
  while (firstDifference < limit && expected[firstDifference] === actual[firstDifference]) firstDifference += 1;
  const from = Math.max(0, firstDifference - 35);
  const to = firstDifference + 70;
  return {
    ok: false,
    status: "failed",
    message: "Результат отличается от рассчитанного текста вне подтверждённых замен.",
    firstDifference,
    expectedSnippet: expected.slice(from, to),
    actualSnippet: actual.slice(from, to),
    expectedLength: expected.length,
    actualLength: actual.length
  };
}

export function scanResidual(input) {
  const remaining = detectEntities(String(input || ""));
  return {
    critical: remaining.filter((item) => TYPE_DEFINITIONS[item.type]?.critical).length,
    warnings: remaining.filter((item) => !TYPE_DEFINITIONS[item.type]?.critical).length,
    items: remaining
  };
}

export const ENTITY_TYPES = TYPE_DEFINITIONS;
