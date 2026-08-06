import { mapEntityToSource, normalizeTextWithMap } from "./anonymizer-normalize.js";

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
  ORGANIZATION: { label: "Организация", token: "ОРГ", defaultAction: "MASK", critical: false, priority: 60 },
  MONEY: { label: "Сумма", token: "СУММА", defaultAction: "MASK", critical: false, priority: 55 },
  BIRTH_DATE: { label: "Дата рождения", token: "ДАТА", defaultAction: "MASK", critical: true, priority: 90 },
  FRAGMENT: { label: "Фрагмент текста", token: "ФРАГМЕНТ", defaultAction: "MASK", critical: false, priority: 12 },
  OTHER: { label: "Другое", token: "ДАННЫЕ", defaultAction: "MASK", critical: false, priority: 10 }
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
      action: options.action || TYPE_DEFINITIONS[type]?.defaultAction || "MASK",
      confidence: options.confidence || "medium",
      source: options.source || "rules",
      priority: Number.isFinite(options.priority) ? options.priority : undefined
    });
    if (match[0].length === 0) regex.lastIndex += 1;
  }
}

function overlaps(left, right) {
  return left.start < right.end && right.start < left.end;
}

function resolveOverlaps(items) {
  const ordered = [...items].sort((left, right) => {
    const leftPriority = Number.isFinite(left.priority) ? left.priority : (TYPE_DEFINITIONS[left.type]?.priority || 0);
    const rightPriority = Number.isFinite(right.priority) ? right.priority : (TYPE_DEFINITIONS[right.type]?.priority || 0);
    return rightPriority - leftPriority || (right.end - right.start) - (left.end - left.start) || left.start - right.start;
  });
  const accepted = [];
  for (const item of ordered) {
    if (!accepted.some((current) => overlaps(item, current))) accepted.push(item);
  }
  return accepted.sort((left, right) => left.start - right.start);
}

function normalizeSurnameForm(value) {
  const surname = String(value || "")
    .trim()
    .toLocaleLowerCase("ru-RU")
    .replace(/[‐‑‒–—]/gu, "-");

  // Притяжательные русские фамилии: Дерюгин, Дерюгина, Дерюгиным,
  // Сергунина, Сергуниной. Сначала сохраняем значимую часть -ов/-ев/-ин,
  // затем отбрасываем только падежное/родовое окончание.
  let match = surname.match(/^(.{2,}?)(ов|ев|ёв|ин|ын)(?:а|у|ым|им|ом|е|ой|ою)?$/u);
  if (match) return `${match[1]}${match[2]}#possessive`;

  // Прилагательные фамилии: Ивановский, Ивановского, Ивановским и т. п.
  match = surname.match(/^(.{2,}?)(?:ский|ская|ское|ского|ской|скому|ским|ском|ские|ских|скими)$/u);
  if (match) return `${match[1]}ск#adjective`;

  // Ограниченная модель фамилий на -а/-я. Она нужна для форм вроде
  // Кострома / Костромы / Костроме / Костромой и применяется только вместе
  // с совпадающими инициалами, поэтому не объединяет однофамильцев вслепую.
  match = surname.match(/^(.{3,}?)(?:а|ы|у|е|ой|ою)$/u);
  if (match) return `${match[1]}#a-family`;
  match = surname.match(/^(.{3,}?)(?:я|и|ю|ей|ею)$/u);
  if (match) return `${match[1]}#ya-family`;

  return surname;
}

function personIdentity(value) {
  const compact = String(value || "")
    .trim()
    .toLocaleLowerCase("ru-RU")
    .replace(/[\u00A0\u202F]/gu, " ")
    .replace(/\s+/g, " ");
  let match = compact.match(/^([а-яё])\.\s*([а-яё])\.\s*([а-яё-]{2,})$/u);
  if (match) return `${normalizeSurnameForm(match[3])}|${match[1]}|${match[2]}`;
  match = compact.match(/^([а-яё-]{2,})\s+([а-яё])\.\s*([а-яё])\.$/u);
  if (match) return `${normalizeSurnameForm(match[1])}|${match[2]}|${match[3]}`;
  const words = compact.replace(/[.]/g, " ").split(/\s+/u).filter(Boolean);
  if (words.length >= 3) return `${normalizeSurnameForm(words[0])}|${words[1][0]}|${words[2][0]}`;
  return compact.replace(/[.\s]/g, "");
}

export function entityIdentity(item) {
  const type = TYPE_DEFINITIONS[item?.type] ? item.type : "OTHER";
  const value = String(item?.canonicalValue || item?.normalizedValue || item?.value || "");
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

function validLuhn(value) {
  const digits = onlyDigits(value);
  if (digits.length < 13 || digits.length > 19 || /^(\d)\1+$/u.test(digits)) return false;
  let sum = 0;
  let alternate = false;
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    let digit = Number(digits[index]);
    if (alternate) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    alternate = !alternate;
  }
  return sum % 10 === 0;
}

function detectEntitiesRaw(input) {
  const text = String(input || "");
  const found = [];

  // Контакты: после нормализации поддерживаются пробелы вокруг @, переносы и OCR-цифры.
  addMatches(text, "EMAIL", /[A-ZА-ЯЁ0-9._%+-]+@[A-ZА-ЯЁ0-9-]+(?:\s*\.\s*[A-ZА-ЯЁ0-9-]+)+/giu, found, { confidence: "high" });
  addMatches(text, "PHONE", /(?<!\d)(?:\+?7|8)(?:[\s\-()]{0,4}\d){10}(?:\s*(?:доб\.?|добавочный)\s*\d{1,6})?(?!\d)/giu, found, { confidence: "high" });
  addMatches(text, "PHONE", /(?:тел(?:ефон)?|моб(?:ильный)?|контактный\s+телефон)\s*[:№]?\s*((?:\d[\s\-()]{0,4}){9,11}\d)/giu, found, { group: 1, confidence: "high" });

  // Документы и идентификаторы.
  addMatches(text, "PASSPORT", /(?:паспорт(?:\s+гражданина)?(?:\s+РФ)?|серия(?:\s+паспорта)?)\s*[:№]?\s*((?:\d{2}\s*\d{2}|\d{4})\s*№?\s*\d{6})/giu, found, { group: 1, confidence: "high" });
  addMatches(text, "SNILS", /(?:СНИЛС\s*[:№]?\s*)?(?<!\d)(\d{3}[\s-]?\d{3}[\s-]?\d{3}[\s-]?\d{2})(?!\d)/giu, found, { group: 1, validate: validSnils, confidence: "high" });
  addMatches(text, "INN", /(?:ИНН\s*[:№]?\s*)?((?:\d[\s-]?){12}|(?:\d[\s-]?){10})(?![\s-]?\d)/giu, found, { group: 1, validate: validInn, confidence: "high" });
  addMatches(text, "OTHER", /(?:полис(?:\s+(?:ОМС|ДМС))?|водительск(?:ое|ого)\s+удостоверени[ея]|свидетельство\s+о\s+рождении|заграничный\s+паспорт|вид\s+на\s+жительство)\s*[:№]?\s*([A-ZА-ЯЁ0-9][A-ZА-ЯЁ0-9\s-]{4,30})/giu, found, { group: 1, confidence: "high", source: "rules-document", priority: 160 });
  addMatches(text, "OTHER", /(?:гос(?:ударственный)?\s*(?:регистрационный)?\s*номер|госномер)\s*[:№]?\s*([А-ЯЁA-Z]\s*\d{3}\s*[А-ЯЁA-Z]{2}\s*\d{2,3})/giu, found, { group: 1, confidence: "medium", source: "rules-document", priority: 160 });
  addMatches(text, "OTHER", /(?:кадастровый\s+номер)\s*[:№]?\s*(\d{2}:\d{2}:\d{6,7}:\d+)/giu, found, { group: 1, confidence: "high", source: "rules-document", priority: 160 });
  addMatches(text, "OTHER", /(?:IP(?:-адрес)?|айпи(?:-адрес)?)\s*[:№]?\s*((?:\d{1,3}\.){3}\d{1,3})/giu, found, { group: 1, confidence: "medium", source: "rules-digital", priority: 160 });
  addMatches(text, "OTHER", /(?:логин|имя\s+пользователя|уч[её]тная\s+запись)\s*[:№]?\s*([A-ZА-ЯЁ0-9._-]{3,64})/giu, found, { group: 1, confidence: "medium", source: "rules-digital", priority: 160 });
  addMatches(text, "OTHER", /(?:MAC(?:-адрес)?|мак(?:-адрес)?)\s*[:№]?\s*((?:[0-9A-F]{2}[:-]){5}[0-9A-F]{2})/giu, found, { group: 1, confidence: "medium", source: "rules-digital", priority: 160 });
  addMatches(text, "OTHER", /(?:IMEI|идентификатор\s+устройства)\s*[:№]?\s*(\d{14,16})/giu, found, { group: 1, confidence: "medium", source: "rules-digital", priority: 160 });

  // Платёжные реквизиты.
  addMatches(text, "BANK_ACCOUNT", /(?:р\/?с|к\/?с|расч[её]тный\s+сч[её]т|корр(?:еспондентский)?\s+сч[её]т|банковский\s+сч[её]т|сч[её]т)\s*[:№]?\s*((?:\d[\s-]?){20})(?!\d)/giu, found, { group: 1, confidence: "high" });
  addMatches(text, "BIK", /(?:БИК)\s*[:№]?\s*((?:\d[\s-]?){9})(?!\d)/giu, found, { group: 1, confidence: "high" });
  addMatches(text, "CARD", /(?:карта|номер\s+карты|банковская\s+карта)\s*[:№]?\s*((?:\d[ -]?){15}\d)(?!\d)/giu, found, { group: 1, validate: validLuhn, confidence: "high" });
  addMatches(text, "CARD", /(?<!\d)((?:\d[ -]?){15}\d)(?!\d)/g, found, { group: 1, validate: validLuhn, confidence: "medium" });

  // Даты рождения — цифровые и словесные.
  addMatches(text, "BIRTH_DATE", /(?:дата\s+рождения|родил(?:ся|ась)|г\.\s*р\.)\s*[:\-]?\s*((?:0?[1-9]|[12]\d|3[01])[.\/-](?:0?[1-9]|1[0-2])[.\/-](?:19|20)\d{2})/giu, found, { group: 1, confidence: "high" });
  addMatches(text, "BIRTH_DATE", /(?:дата\s+рождения|родил(?:ся|ась)|г\.\s*р\.)\s*[:\-]?\s*((?:0?[1-9]|[12]\d|3[01])\s+(?:января|февраля|марта|апреля|мая|июня|июля|августа|сентября|октября|ноября|декабря)\s+(?:19|20)\d{2}(?:\s+года|\s+г\.)?)/giu, found, { group: 1, confidence: "high" });

  // ФИО: полная форма, инициалы, двойные фамилии/имена и частицы иностранных фамилий.
  const personWord = "[А-ЯЁ][а-яё]{1,30}(?:-[А-ЯЁ]?[а-яё]{1,30})?";
  const surname = `(?:${personWord}|(?:де|да|ди|дос|ду|дель|делла|ла|ле|ван|фон|дер|ден|тер)(?:\\s+(?:де|ла|дер))?\\s+${personWord})`;
  const patronymic = `(?:${personWord}(?:ович|евич|ич|овна|евна|ична|инична)|${personWord}\\s+(?:оглы|кызы))`;
  addMatches(text, "PERSON", new RegExp(`(?<![А-ЯЁа-яё-])(${surname}\\s+${personWord}\\s+${patronymic})(?![А-ЯЁа-яё-])`, "gu"), found, { group: 1, confidence: "high" });
  addMatches(text, "PERSON", /(?<![А-ЯЁа-яё-])([А-ЯЁ]{2,30}(?:-[А-ЯЁ]{2,30})?\s+[А-ЯЁ]{2,30}(?:-[А-ЯЁ]{2,30})?\s+[А-ЯЁ]{2,30}(?:ОВИЧ|ЕВИЧ|ИЧ|ОВНА|ЕВНА|ИЧНА|ИНИЧНА))(?![А-ЯЁа-яё-])/gu, found, { group: 1, confidence: "medium", source: "rules-ocr" });
  addMatches(text, "PERSON", new RegExp(`(?<![А-ЯЁа-яё-])([А-ЯЁ]\\.\\s*[А-ЯЁ]\\.\\s*${surname})(?![А-ЯЁа-яё-])`, "gu"), found, { group: 1, confidence: "high" });
  addMatches(text, "PERSON", new RegExp(`(?<![А-ЯЁа-яё-])(${surname}\\s+[А-ЯЁ]\\.\\s*[А-ЯЁ]\\.)(?![А-ЯЁа-яё-])`, "gu"), found, { group: 1, confidence: "high" });
  addMatches(text, "PERSON", new RegExp(`(?<![А-ЯЁа-яё-])([А-ЯЁ]\\.[А-ЯЁ]\\.\\s*${surname})(?![А-ЯЁа-яё-])`, "gu"), found, { group: 1, confidence: "high" });
  addMatches(text, "PERSON", new RegExp(`(?<![А-ЯЁа-яё-])(${surname}\\s+[А-ЯЁ]\\.[А-ЯЁ]\\.)(?![А-ЯЁа-яё-])`, "gu"), found, { group: 1, confidence: "high" });
  addMatches(text, "PERSON", new RegExp(`(?:ФИО|заявитель|гражданин(?:ка)?|представитель|директор|подписант|руководитель|начальник|получатель|отправитель|обратившийся)\\s*[:\\-]?\\s*(${surname}\\s+${personWord}(?:\\s+${personWord}(?:\\s+(?:оглы|кызы))?)?)`, "giu"), found, { group: 1, confidence: "medium" });
  addMatches(text, "PERSON", /(?:ФИО|заявитель|гражданин(?:ка)?|представитель|директор|подписант|руководитель|начальник|получатель|отправитель)\s*[:\-]?\s*([А-ЯЁ]\.?\s*[А-ЯЁ]\.?\s*[А-ЯЁ][а-яё-]{2,30}|[А-ЯЁ][а-яё-]{2,30}\s+[А-ЯЁ]\.?\s*[А-ЯЁ]\.?)\b/giu, found, { group: 1, confidence: "medium", source: "rules-ocr" });
  addMatches(text, "PERSON", /(?:ФИО|заявитель|гражданин(?:ка)?|представитель|получатель)\s*[:\-]?\s*([A-Z][A-Za-z'-]{1,30}\s+[A-Z][A-Za-z'-]{1,30}(?:\s+[A-Z][A-Za-z'-]{1,30})?)/gu, found, { group: 1, confidence: "medium", source: "rules-latin" });

  // Адреса: с явной меткой и типовой структурой без метки.
  addMatches(text, "ADDRESS", /(?<![-А-ЯЁа-яё])(?:адрес(?:\s+регистрации|\s+места\s+жительства|\s+проживания|\s+корреспонденции)?|прожива(?:ет|ющий)|зарегистрирован(?:а)?|место\s+жительства|место\s+рождения)\s*[:\-]?\s*([^\n;]{8,180})/giu, found, { group: 1, confidence: "high" });
  addMatches(text, "ADDRESS", /(?<!\d)(\d{6},?\s+(?:г\.?\s*)?[А-ЯЁ][А-ЯЁа-яё .-]{2,50},?\s+(?:ул\.?|улица|пр-т|проспект|пер\.?|переулок|ш\.?|шоссе|наб\.?|набережная)\s+[А-ЯЁ0-9][А-ЯЁа-яё0-9 .-]{1,60},?\s+(?:д\.?|дом)\s*\d+[А-ЯЁа-яё]?(?:\s*,?\s*(?:корп\.?|корпус|стр\.?|строение|кв\.?|квартира)\s*\d+[А-ЯЁа-яё]?)*)/giu, found, { group: 1, confidence: "medium" });

  // Номера документов, суммы и организации сохраняются как отдельные чувствительные категории.
  addMatches(text, "CONTRACT_NUMBER", /(?:договор[а-яё]*|контракт[а-яё]*|соглашени[а-яё]*|доверенност[а-яё]*|обращени[а-яё]*|заявлени[а-яё]*)\s*(?:от\s*\d{1,2}[.\/-]\d{1,2}[.\/-]\d{2,4}\s*)?№\s*([A-ZА-ЯЁ0-9](?:[A-ZА-ЯЁ0-9_.\/-]{0,39}[A-ZА-ЯЁ0-9])?)/giu, found, { group: 1, confidence: "medium" });
  addMatches(text, "MONEY", /(?<!\w)(\d{1,3}(?:[ \u00a0]\d{3})*(?:[.,]\d{1,2})?|\d+)(?:\s*)(?:₽|руб(?:\.|лей|ля)?)/giu, found, { confidence: "medium" });
  addMatches(text, "ORGANIZATION", /(?:ООО|АО|ПАО|НКО|Фонд|ГБУ|ГКУ|ИП)\s+[«"][^»"\n]{2,70}[»"]/g, found, {
    confidence: "medium",
    reject: isPublicOrganization
  });
  addMatches(text, "ORGANIZATION", /(?:ООО|АО|ПАО|НКО|Фонд|ГБУ|ГКУ|ИП)\s+[А-ЯЁA-Z0-9][А-ЯЁа-яёA-Z0-9 .&-]{1,60}(?=[,;\n]|$)/g, found, {
    confidence: "low",
    reject: isPublicOrganization
  });

  return assignEntityGroups(resolveOverlaps(found));
}

export function analyzeEntities(input, options = {}) {
  const source = String(input || "");
  const normalization = normalizeTextWithMap(source, { ocr: Boolean(options.ocr) });
  const normalizedEntities = detectEntitiesRaw(normalization.text);
  const sourceEntities = assignEntityGroups(resolveOverlaps(
    normalizedEntities.map((entity) => mapEntityToSource(entity, normalization))
  ));
  return { source, normalization, normalizedEntities, sourceEntities };
}

export function detectEntities(input, options = {}) {
  return analyzeEntities(input, options).sourceEntities;
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

export function inferEntityType(value) {
  const text = String(value || "").trim();
  if (!text || /^\[\[[А-ЯЁA-Z_]+_\d{3,}\]\]$/u.test(text)) return null;
  const exact = detectEntities(text).find((item) => item.start === 0 && item.end === text.length);
  if (exact) return exact.type;
  if (/^(?:ООО|АО|ПАО|НКО|Фонд|ГБУ|ГКУ)\b/iu.test(text)) return "ORGANIZATION";
  if (/^[А-ЯЁ][а-яё-]{1,30}(?:\s+[А-ЯЁ][а-яё-]{1,30}){1,2}$/u.test(text)) return "PERSON";
  if (/^\d{1,3}(?:[ \u00a0]\d{3})*(?:[.,]\d{1,2})?\s*(?:₽|руб)/iu.test(text)) return "MONEY";
  return "OTHER";
}

export function appendUniqueEntities(existing, additions) {
  const entities = [...(existing || [])];
  const occupied = new Set(entities.map((item) => `${item.start}:${item.end}`));
  let added = 0;
  for (const item of additions || []) {
    const key = `${item.start}:${item.end}`;
    if (occupied.has(key)) continue;
    entities.push(item);
    occupied.add(key);
    added += 1;
  }
  entities.sort((left, right) => left.start - right.start);
  return { entities, added };
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
    if (group.action === "KEEP") return;
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
  // Безопасность по умолчанию: REVIEW — только отметка уверенности, а не разрешение
  // оставить исходные данные. Не маскируется только явное действие KEEP.
  const selected = resolveOverlaps(assignEntityGroups(entities).filter((item) => item.action !== "KEEP"));
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

export function tokenType(token) {
  const prefix = String(token || "").match(/^\[\[([А-ЯЁA-Z_]+)_\d{3,}\]\]$/u)?.[1] || "";
  return Object.entries(TYPE_DEFINITIONS).find(([, definition]) => definition.token === prefix)?.[0] || "OTHER";
}

export function splitTokenizedText(input) {
  const text = String(input || "");
  const parts = [];
  let cursor = 0;
  for (const match of text.matchAll(new RegExp(TOKEN_PATTERN.source, TOKEN_PATTERN.flags))) {
    if (match.index > cursor) parts.push({ text: text.slice(cursor, match.index), token: false, type: null });
    parts.push({ text: match[0], token: true, type: tokenType(match[0]) });
    cursor = match.index + match[0].length;
  }
  if (cursor < text.length) parts.push({ text: text.slice(cursor), token: false, type: null });
  return parts;
}

export function resultSafetyStatus(sourceLength, replacementCount) {
  if (Number(sourceLength) >= 500 && Number(replacementCount) === 0) {
    return { level: "warning", title: "Нужна проверка", message: "Документ обработан, но чувствительные данные не найдены. Проверьте безопасную копию и при необходимости выделите пропущенный фрагмент." };
  }
  return { level: "success", title: "Готово", message: "Безопасная копия создана и проверена автоматически." };
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
  if (!validation.ok) return { ok: false, text, restored: text, replacements: [], errors: validation.errors, unknownTokens: [], unusedTokens: [] };
  const entriesByToken = new Map(map.entries.map((entry) => [entry.token, entry]));
  const foundTokens = extractTokens(text);
  const unknownTokens = foundTokens.filter((token) => !entriesByToken.has(token));
  const usedTokens = foundTokens.filter((token) => entriesByToken.has(token));
  const unusedTokens = map.entries.map((entry) => entry.token).filter((token) => !foundTokens.includes(token));
  const sourceMatchesMap = !map.safeFingerprint || map.safeFingerprint === fingerprintText(text);
  const occurrenceIndexes = new Map();
  const replacements = [];
  const restored = text.replace(new RegExp(TOKEN_PATTERN.source, TOKEN_PATTERN.flags), (token, offset) => {
    const entry = entriesByToken.get(token);
    if (!entry) return token;
    const index = occurrenceIndexes.get(token) || 0;
    occurrenceIndexes.set(token, index + 1);
    const occurrences = [...(entry.occurrences || [])].sort((left, right) => left.start - right.start);
    const replacement = sourceMatchesMap ? (occurrences[index]?.original || entry.original) : entry.original;
    replacements.push({ token, replacement, start: offset, end: offset + token.length, entryId: entry.id || null });
    return replacement;
  });
  return {
    ok: unknownTokens.length === 0,
    text,
    restored,
    replacements,
    errors: [],
    unknownTokens,
    usedTokens,
    unusedTokens,
    replacedCount: usedTokens.reduce((sum, token) => sum + text.split(token).length - 1, 0),
    sourceMatchesMap
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

function normalizedContains(haystack, needle) {
  const source = String(haystack || "");
  const target = String(needle || "");
  if (target.length < 3) return false;
  let offset = 0;
  while ((offset = source.indexOf(target, offset)) !== -1) {
    const before = source[offset - 1] || "";
    const after = source[offset + target.length] || "";
    const startsWithWord = /^[\p{L}\p{N}]/u.test(target);
    const endsWithWord = /[\p{L}\p{N}]$/u.test(target);
    if ((!startsWithWord || !/[\p{L}\p{N}]/u.test(before))
      && (!endsWithWord || !/[\p{L}\p{N}]/u.test(after))) return true;
    offset += Math.max(1, target.length);
  }
  return false;
}

function mapLeakCandidates(text, map) {
  const normalizedSafe = normalizeTextWithMap(text, { ocr: true }).text.toLocaleLowerCase("ru-RU");
  const leaks = [];
  const seen = new Set();
  for (const entry of map?.entries || []) {
    const values = [entry.original, ...(entry.aliases || []).map((alias) => alias?.value)].filter(Boolean);
    for (const value of values) {
      const normalizedValue = normalizeTextWithMap(value, { ocr: true }).text.toLocaleLowerCase("ru-RU");
      if (!normalizedContains(normalizedSafe, normalizedValue)) continue;
      const key = `${entry.type}\u0000${normalizedValue}`;
      if (seen.has(key)) continue;
      seen.add(key);
      leaks.push({
        id: `residual-map-${leaks.length}`,
        type: TYPE_DEFINITIONS[entry.type] ? entry.type : "OTHER",
        value: "",
        start: -1,
        end: -1,
        action: "REVIEW",
        confidence: "high",
        source: "residual-map",
        token: entry.token || null
      });
    }
  }
  return leaks;
}

export function scanResidual(input, options = {}) {
  const text = String(input || "");
  // Context rules may rediscover a placeholder after labels such as "адрес:".
  // Ignore it when removing placeholders leaves only punctuation or a short
  // grammatical tail (for example "по адресу [[EMAIL_001]]" -> "у").
  const detected = detectEntities(text, { ocr: true }).filter((item) => {
    const withoutTokens = item.value.replace(new RegExp(TOKEN_PATTERN.source, TOKEN_PATTERN.flags), "");
    if (withoutTokens === item.value) return true;
    return withoutTokens.replace(/[^\p{L}\p{N}]/gu, "").length >= 4;
  });
  const mapLeaks = mapLeakCandidates(text, options.map);
  const combined = [...detected];
  for (const leak of mapLeaks) {
    if (!combined.some((item) => item.type === leak.type && item.source === "residual-map")) combined.push(leak);
  }

  const hasMap = Boolean(options.map && Array.isArray(options.map.entries));
  const knownTokens = new Set((options.map?.entries || []).map((entry) => entry.token).filter(Boolean));
  const unknownTokens = hasMap ? extractTokens(text).filter((token) => !knownTokens.has(token)) : [];
  const criticalItems = combined.filter((item) => TYPE_DEFINITIONS[item.type]?.critical);
  return {
    critical: criticalItems.length + unknownTokens.length,
    warnings: combined.length - criticalItems.length,
    items: combined,
    mapLeaks,
    unknownTokens,
    passed: criticalItems.length === 0 && mapLeaks.length === 0 && unknownTokens.length === 0
  };
}

export const ENTITY_TYPES = TYPE_DEFINITIONS;
