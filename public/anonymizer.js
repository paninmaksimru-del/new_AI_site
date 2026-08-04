import * as pdfjsLib from "./vendor/pdf.min.mjs";
import {
  ENTITY_TYPES,
  addManualEntity,
  applyReplacements,
  assignEntityGroups,
  buildEntityRegistry,
  detectEntities,
  entityIdentity,
  fingerprintText,
  restoreWithDiagnostics,
  scanResidual,
  validateIntegrity,
  validateMap
} from "./anonymizer-engine.js";
import { mergeEntityCandidates, pageNeedsOcr } from "./anonymizer-pipeline.js";

pdfjsLib.GlobalWorkerOptions.workerSrc = "/vendor/pdf.worker.min.mjs";

const MAX_FILE_SIZE = 10 * 1024 * 1024;
const SESSION_KEY = "mik-anonymizer-current-v2";
const SAVED_KEY = "mik-anonymizer-sessions-v2";

const state = {
  mode: "anonymize",
  source: null,
  text: "",
  entities: [],
  registry: [],
  result: null,
  integrity: null,
  residual: null,
  tokenAssignments: {},
  canonicalOverrides: {},
  sessionId: null,
  createdAt: null,
  selectedGroups: new Set(),
  manualSelection: null,
  hideOriginals: false,
  uploadedMap: null,
  uploadedMapName: "",
  restoreResult: null,
  ocrPages: [],
  qwenUsed: false,
  qwenModel: null
};

let activeOcrWorker = null;
let qwenConfiguration = { configured: false, model: null, promptVersion: null };

const $ = (id) => document.getElementById(id);
const sleep = (milliseconds) => new Promise((resolve) => window.setTimeout(resolve, milliseconds));
const makeId = () => window.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;

function showToast(message) {
  const toast = $("toast");
  toast.textContent = message;
  toast.classList.add("show");
  window.clearTimeout(showToast.timer);
  showToast.timer = window.setTimeout(() => toast.classList.remove("show"), 3800);
}

function safeBaseName(name) {
  return String(name || "document")
    .replace(/\.[^.]+$/, "")
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, "_")
    .trim() || "document";
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} Б`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} КБ`;
  return `${(bytes / 1024 / 1024).toFixed(1)} МБ`;
}

function downloadBlob(name, blob) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

function downloadFile(name, content, type = "text/plain;charset=utf-8") {
  downloadBlob(name, new Blob([content], { type }));
}

async function copyText(value, successMessage) {
  try {
    await navigator.clipboard.writeText(value);
    showToast(successMessage);
  } catch {
    showToast("Браузер не разрешил доступ к буферу обмена. Скопируйте текст вручную.");
  }
}

function setView(viewName) {
  const names = ["input", "processing", "result", "restore"];
  names.forEach((name) => $(`${name}View`).classList.toggle("hidden", name !== viewName));
  const currentStep = viewName === "processing" ? "process" : viewName;
  const order = { input: 0, process: 1, result: 2, restore: 3 };
  document.querySelectorAll("[data-step]").forEach((step) => {
    const name = step.dataset.step;
    step.classList.toggle("active", name === currentStep);
    step.classList.toggle("done", order[name] < order[currentStep]);
  });
}

function setMode(mode) {
  state.mode = mode;
  const restore = mode === "restore";
  $("anonymizeModeButton").classList.toggle("active", !restore);
  $("restoreModeButton").classList.toggle("active", restore);
  $("anonymizeModeButton").setAttribute("aria-selected", String(!restore));
  $("restoreModeButton").setAttribute("aria-selected", String(restore));
  if (restore) {
    refreshRestoreMapSources();
    setView("restore");
  } else {
    setView(state.result ? "result" : "input");
  }
}

function setInputTab(name) {
  const fileMode = name === "file";
  $("fileInputPanel").classList.toggle("hidden", !fileMode);
  $("textInputPanel").classList.toggle("hidden", fileMode);
  $("fileTabButton").classList.toggle("active", fileMode);
  $("textTabButton").classList.toggle("active", !fileMode);
  $("fileTabButton").setAttribute("aria-selected", String(fileMode));
  $("textTabButton").setAttribute("aria-selected", String(!fileMode));
  if (!fileMode) $("pasteInput").focus();
}

function extractParagraphText(xmlText) {
  const xml = new DOMParser().parseFromString(xmlText, "application/xml");
  if (xml.querySelector("parsererror")) throw new Error("DOCX_PARSE");
  const paragraphs = Array.from(xml.getElementsByTagNameNS("*", "p"));
  return paragraphs.map((paragraph) => {
    const chunks = [];
    paragraph.querySelectorAll("t, tab, br, cr").forEach((node) => {
      if (node.localName === "tab") chunks.push("\t");
      else if (node.localName === "br" || node.localName === "cr") chunks.push("\n");
      else chunks.push(node.textContent || "");
    });
    return chunks.join("");
  }).filter((line) => line.trim()).join("\n");
}

async function extractDocx(file) {
  if (!window.fflate?.unzipSync) throw new Error("DOCX_LIBRARY");
  const archive = window.fflate.unzipSync(new Uint8Array(await file.arrayBuffer()));
  const preferredParts = [
    "word/document.xml",
    ...Object.keys(archive).filter((name) => /^word\/(?:header|footer)\d+\.xml$/i.test(name)).sort(),
    "word/footnotes.xml",
    "word/endnotes.xml",
    "word/comments.xml"
  ];
  const parts = preferredParts.filter((name) => archive[name]);
  if (!parts.length) throw new Error("DOCX_STRUCTURE");
  const text = parts.map((name) => extractParagraphText(window.fflate.strFromU8(archive[name]))).filter(Boolean).join("\n\n");
  if (!text.trim()) throw new Error("EMPTY_DOCUMENT");
  return text;
}

async function getOcrWorker() {
  if (activeOcrWorker) return activeOcrWorker;
  if (!window.Tesseract?.createWorker) throw new Error("OCR_LIBRARY");
  activeOcrWorker = await window.Tesseract.createWorker("rus+eng", 1, {
    workerPath: "/vendor/tesseract/worker.min.js",
    corePath: "/vendor/tesseract/core",
    langPath: "/vendor/tesseract/lang/",
    logger(message) {
      if (message?.status !== "recognizing text") return;
      const progress = Math.max(0, Math.min(1, Number(message.progress) || 0));
      $("progressBar").style.width = `${18 + Math.round(progress * 20)}%`;
    }
  });
  return activeOcrWorker;
}

async function recognizePdfPage(page, pageNumber, totalPages) {
  const viewport = page.getViewport({ scale: 2 });
  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  const context = canvas.getContext("2d", { alpha: false });
  if (!context) throw new Error("OCR_CANVAS");
  $("processingFileMeta").textContent = `OCR: страница ${pageNumber} из ${totalPages}`;
  await page.render({ canvasContext: context, viewport }).promise;
  const worker = await getOcrWorker();
  const result = await worker.recognize(canvas);
  canvas.width = 1;
  canvas.height = 1;
  return String(result?.data?.text || "").trim();
}

async function extractPdf(file) {
  const pdf = await pdfjsLib.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
  const pages = [];
  state.ocrPages = [];
  try {
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
      const page = await pdf.getPage(pageNumber);
      const content = await page.getTextContent();
      const lines = [];
      let currentY = null;
      let currentLine = [];
      for (const item of content.items) {
        const y = Math.round(item.transform?.[5] || 0);
        if (currentY !== null && Math.abs(y - currentY) > 3) {
          if (currentLine.length) lines.push(currentLine.join(" "));
          currentLine = [];
        }
        currentY = y;
        if (item.str) currentLine.push(item.str);
      }
      if (currentLine.length) lines.push(currentLine.join(" "));
      let pageText = lines.join("\n").trim();
      if (pageNeedsOcr(pageText, content.items.length)) {
        pageText = await recognizePdfPage(page, pageNumber, pdf.numPages);
        state.ocrPages.push(pageNumber);
      }
      if (pageText) pages.push(pageText);
    }
  } finally {
    if (activeOcrWorker) await activeOcrWorker.terminate();
    activeOcrWorker = null;
  }
  markTask("ocr");
  const text = pages.join("\n\n");
  if (!text.trim()) throw new Error("PDF_NO_TEXT");
  return text;
}

async function extractText(file) {
  const extension = file.name.split(".").pop()?.toLowerCase();
  if (extension === "txt") {
    const text = await file.text();
    if (!text.trim()) throw new Error("EMPTY_DOCUMENT");
    return text;
  }
  if (extension === "docx") return extractDocx(file);
  if (extension === "pdf") return extractPdf(file);
  throw new Error("UNSUPPORTED_FORMAT");
}

function validateFile(file) {
  const extension = file?.name?.split(".").pop()?.toLowerCase();
  if (!file || !["txt", "docx", "pdf"].includes(extension)) throw new Error("UNSUPPORTED_FORMAT");
  if (file.size > MAX_FILE_SIZE) throw new Error("FILE_TOO_LARGE");
  if (file.size === 0) throw new Error("EMPTY_DOCUMENT");
}

function errorMessage(error) {
  const messages = {
    UNSUPPORTED_FORMAT: "Поддерживаются файлы TXT, DOCX и PDF.",
    FILE_TOO_LARGE: "Файл превышает лимит 10 МБ.",
    EMPTY_DOCUMENT: "В документе не найден текст.",
    PDF_NO_TEXT: "Не удалось извлечь или распознать текст PDF.",
    OCR_LIBRARY: "Не загрузился локальный OCR-модуль. Обновите страницу и повторите попытку.",
    OCR_CANVAS: "Браузер не смог подготовить страницу PDF для OCR.",
    DOCX_STRUCTURE: "В DOCX не найдена читаемая структура документа.",
    DOCX_PARSE: "Не удалось разобрать структуру DOCX.",
    DOCX_LIBRARY: "Не загрузился модуль чтения DOCX. Обновите страницу и повторите попытку."
  };
  return messages[error?.message] || `Не удалось обработать материал: ${error?.message || "неизвестная ошибка"}`;
}

function markTask(name) {
  document.querySelector(`[data-task="${name}"]`)?.classList.add("done");
}

function resetTasks() {
  document.querySelectorAll("[data-task]").forEach((task) => task.classList.remove("done"));
  $("progressBar").style.width = "0%";
}

function prepareProcessing(source) {
  resetTasks();
  state.source = source;
  state.ocrPages = [];
  state.qwenUsed = false;
  state.qwenModel = null;
  $("processingFileName").textContent = source.name;
  $("processingFileMeta").textContent = source.kind === "text" ? "Подготовка текста" : formatBytes(source.size);
  setView("processing");
  $("progressBar").style.width = "8%";
}

async function requestQwenEntities(text, ruleEntities) {
  const response = await fetch("/api/anonymizer/qwen/entities", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-auth-token": localStorage.getItem("auth_token") || ""
    },
    body: JSON.stringify({ text, ruleCandidates: ruleEntities, confirmed: true })
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `QWEN_HTTP_${response.status}`);
  state.qwenUsed = true;
  state.qwenModel = payload.model || qwenConfiguration.model;
  return Array.isArray(payload.entities) ? payload.entities : [];
}

async function loadQwenStatus() {
  try {
    const response = await fetch("/api/anonymizer/qwen/status");
    qwenConfiguration = await response.json();
  } catch {
    qwenConfiguration = { configured: false, model: null, promptVersion: null };
  }
}

function sessionSnapshot() {
  return {
    schema: 2,
    source: state.source,
    text: state.text,
    entities: state.entities,
    tokenAssignments: state.tokenAssignments,
    canonicalOverrides: state.canonicalOverrides,
    sessionId: state.sessionId,
    createdAt: state.createdAt,
    map: state.result?.map || null,
    updatedAt: new Date().toISOString()
  };
}

function autoSaveSession() {
  if (!state.text || !state.result) return;
  try {
    sessionStorage.setItem(SESSION_KEY, JSON.stringify(sessionSnapshot()));
    $("sessionStatus").textContent = "Текущий черновик хранится только до закрытия вкладки.";
  } catch {
    $("sessionStatus").textContent = "Не удалось временно сохранить текущий черновик в браузере.";
  }
}

function getSavedSessions() {
  try {
    const value = JSON.parse(localStorage.getItem(SAVED_KEY) || "{}");
    return value && typeof value === "object" ? value : {};
  } catch {
    return {};
  }
}

function writeSavedSessions(sessions) {
  localStorage.setItem(SAVED_KEY, JSON.stringify(sessions));
  refreshSavedSessions();
  refreshRestoreMapSources();
}

function refreshSavedSessions() {
  const sessions = getSavedSessions();
  const items = Object.values(sessions).sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)));
  const select = $("savedSessionSelect");
  select.innerHTML = '<option value="">Выберите черновик</option>';
  items.forEach((snapshot) => {
    const option = document.createElement("option");
    option.value = snapshot.sessionId;
    option.textContent = `${snapshot.source?.name || "Без названия"} · ${new Date(snapshot.updatedAt).toLocaleString("ru-RU")}`;
    select.appendChild(option);
  });
  $("savedSessionsHint").textContent = items.length
    ? `Сохранено черновиков: ${items.length}. Они содержат исходные данные и доступны только на этом устройстве.`
    : "Черновик содержит исходный документ и данные для восстановления. Не сохраняйте его на чужом компьютере.";
  $("clearSavedSessionsButton").disabled = items.length === 0;
  $("loadSavedSessionButton").disabled = !select.value;
}

function restoreSnapshot(snapshot) {
  if (!snapshot?.text || !Array.isArray(snapshot.entities)) throw new Error("Повреждённый черновик.");
  state.source = snapshot.source || { name: "Восстановленный черновик.txt", size: snapshot.text.length, kind: "text" };
  state.text = snapshot.text;
  state.entities = assignEntityGroups(snapshot.entities);
  state.tokenAssignments = snapshot.tokenAssignments || {};
  state.canonicalOverrides = snapshot.canonicalOverrides || {};
  state.sessionId = snapshot.sessionId || makeId();
  state.createdAt = snapshot.createdAt || new Date().toISOString();
  state.ocrPages = snapshot.source?.analysis?.ocrPages || [];
  state.qwenUsed = Boolean(snapshot.source?.analysis?.qwenUsed);
  state.qwenModel = snapshot.source?.analysis?.qwenModel || null;
  state.selectedGroups.clear();
  recalculate(false);
  renderResult();
  setMode("anonymize");
  showToast("Черновик открыт.");
}

function savePersistentSession() {
  if (!state.result) return;
  if (!window.confirm("Сохранить черновик на этом устройстве? Он содержит исходный текст и данные для восстановления.")) return;
  try {
    const sessions = getSavedSessions();
    sessions[state.sessionId] = sessionSnapshot();
    writeSavedSessions(sessions);
    $("sessionStatus").textContent = "Черновик сохранён на этом устройстве до ручного удаления.";
    showToast("Черновик сохранён на этом устройстве.");
  } catch {
    showToast("Не удалось сохранить черновик: хранилище браузера недоступно или переполнено.");
  }
}

function deletePersistentSession() {
  const sessions = getSavedSessions();
  if (!sessions[state.sessionId]) return showToast("Этот черновик не был сохранён на устройстве.");
  if (!window.confirm("Удалить сохранённый черновик с этого устройства?")) return;
  delete sessions[state.sessionId];
  writeSavedSessions(sessions);
  $("sessionStatus").textContent = "Сохранённая копия удалена. Черновик останется открыт до закрытия вкладки.";
  showToast("Сохранённый черновик удалён.");
}

function recalculate(save = true) {
  const registryResult = buildEntityRegistry(state.entities, {
    tokenAssignments: state.tokenAssignments,
    canonicalOverrides: state.canonicalOverrides
  });
  state.registry = registryResult.registry;
  state.tokenAssignments = registryResult.tokenAssignments;
  state.result = applyReplacements(state.text, state.entities, {
    tokenAssignments: state.tokenAssignments,
    canonicalOverrides: state.canonicalOverrides,
    sessionId: state.sessionId,
    createdAt: state.createdAt
  });
  state.tokenAssignments = state.result.tokenAssignments;
  state.integrity = validateIntegrity(state.text, state.result.text, state.result.replacements);
  state.residual = scanResidual(state.result.text);
  if (save) autoSaveSession();
}

async function processSource(text, source, options = {}) {
  if (!String(text || "").trim()) return showToast("Добавьте непустой текст.");
  if (!options.prepared) prepareProcessing(source);
  state.source = source;
  state.text = text;
  state.entities = [];
  state.registry = [];
  state.tokenAssignments = {};
  state.canonicalOverrides = {};
  state.selectedGroups.clear();
  state.manualSelection = null;
  state.sessionId = makeId();
  state.createdAt = new Date().toISOString();
  $("processingFileName").textContent = source.name;
  $("processingFileMeta").textContent = source.kind === "text" ? `${text.length.toLocaleString("ru-RU")} знаков` : formatBytes(source.size);

  $("progressBar").style.width = "20%";
  markTask("read");
  if (source.kind === "text" || !String(source.name || "").toLowerCase().endsWith(".pdf")) markTask("ocr");
  await sleep(120);
  $("progressBar").style.width = "48%";
  const ruleEntities = detectEntities(text);
  state.entities = ruleEntities;
  markTask("detect");
  await sleep(140);
  $("progressBar").style.width = "66%";
  if (qwenConfiguration.configured) {
    try {
      const qwenEntities = await requestQwenEntities(text, ruleEntities);
      state.entities = assignEntityGroups(mergeEntityCandidates(ruleEntities, qwenEntities));
    } catch (error) {
      console.error("Qwen entity search failed:", error?.message);
      showToast("Дополнительная проверка временно недоступна. Документ обработан основным способом.");
    }
  }
  markTask("qwen");
  state.source.analysis = { ocrPages: state.ocrPages, qwenUsed: state.qwenUsed, qwenModel: state.qwenModel };
  $("progressBar").style.width = "82%";
  recalculate();
  markTask("replace");
  await sleep(140);
  $("progressBar").style.width = "100%";
  markTask("validate");
  await sleep(160);
  renderResult();
  setView("result");
}

async function processFile(file) {
  try {
    validateFile(file);
    const source = { name: file.name, size: file.size, kind: "file", mime: file.type || "" };
    prepareProcessing(source);
    const text = await extractText(file);
    await processSource(text, source, { prepared: true });
  } catch (error) {
    console.error(error);
    setView("input");
    showToast(errorMessage(error));
  }
}

function renderEntityTypes() {
  const options = Object.entries(ENTITY_TYPES).map(([value, config]) => `<option value="${value}">${config.label}</option>`).join("");
  $("manualType").innerHTML = options;
}

function setGroupAction(groupId, action) {
  state.entities.forEach((entity) => {
    if (entity.groupId === groupId) entity.action = action;
  });
  state.selectedGroups.clear();
  $("warningOverrideCheckbox").checked = false;
  recalculate();
  renderResult();
}

function setGroupType(groupId, type) {
  state.entities.forEach((entity) => {
    if (entity.groupId === groupId) entity.type = type;
  });
  delete state.tokenAssignments[groupId];
  state.selectedGroups.clear();
  recalculate();
  renderResult();
}

function splitGroup(group) {
  if (group.aliases.length < 2) return showToast("У этих данных только один вариант написания.");
  const stamp = Date.now();
  group.aliases.forEach((alias, index) => {
    state.entities.forEach((entity) => {
      if (entity.groupId === group.id && entity.value === alias.value) entity.groupId = `${group.id}-split-${stamp}-${index + 1}`;
    });
  });
  delete state.tokenAssignments[group.id];
  delete state.canonicalOverrides[group.id];
  state.selectedGroups.clear();
  recalculate();
  renderResult();
  showToast("Для разных вариантов теперь используются разные замены.");
}

function focusOccurrence(group) {
  const occurrence = group.occurrences[0];
  if (!occurrence) return;
  const textarea = $("sourcePreview");
  textarea.focus();
  textarea.setSelectionRange(occurrence.start, occurrence.end);
  const lineHeight = 20;
  textarea.scrollTop = Math.max(0, state.text.slice(0, occurrence.start).split("\n").length * lineHeight - 80);
}

function renderAliasDetails(group) {
  const details = document.createElement("details");
  details.className = "alias-details";
  const summary = document.createElement("summary");
  summary.textContent = group.aliases.length > 1 ? `Вариантов написания: ${group.aliases.length}` : "Показать места в документе";
  const list = document.createElement("ul");
  list.className = "alias-list";
  group.aliases.forEach((alias) => {
    const item = document.createElement("li");
    item.textContent = `${alias.value} — ${alias.count}`;
    list.appendChild(item);
  });
  details.append(summary, list);
  return details;
}

function renderEntityRows() {
  const rows = $("entityRows");
  rows.innerHTML = "";
  if (!state.registry.length) {
    const row = document.createElement("tr");
    const cell = document.createElement("td");
    cell.colSpan = 7;
    cell.className = "muted";
    cell.textContent = "Чувствительные данные не найдены. Если сервис что-то пропустил, выделите фрагмент в документе и добавьте его вручную.";
    row.appendChild(cell);
    rows.appendChild(row);
    return;
  }

  state.registry.forEach((group) => {
    const row = document.createElement("tr");

    const selectCell = document.createElement("td");
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = state.selectedGroups.has(group.id);
    checkbox.setAttribute("aria-label", `Выбрать данные ${group.original}`);
    checkbox.addEventListener("change", () => {
      if (checkbox.checked) state.selectedGroups.add(group.id);
      else state.selectedGroups.delete(group.id);
      $("mergeEntitiesButton").disabled = state.selectedGroups.size < 2;
    });
    selectCell.appendChild(checkbox);

    const originalCell = document.createElement("td");
    originalCell.className = "entity-value";
    const editor = document.createElement("div");
    editor.className = "original-editor";
    const originalInput = document.createElement("input");
    originalInput.value = state.canonicalOverrides[group.id] || group.original;
    originalInput.setAttribute("aria-label", `Что скрыто для ${group.token || group.label}`);
    originalInput.addEventListener("change", () => {
      const value = originalInput.value.trim();
      if (!value) return renderResult();
      state.canonicalOverrides[group.id] = value;
      recalculate();
      renderResult();
    });
    editor.appendChild(originalInput);
    originalCell.append(editor, renderAliasDetails(group));

    const tokenCell = document.createElement("td");
    const token = document.createElement("code");
    token.className = "token-code";
    token.textContent = group.token || "после подтверждения";
    tokenCell.appendChild(token);

    const typeCell = document.createElement("td");
    const typeSelect = document.createElement("select");
    typeSelect.className = "category-select";
    Object.entries(ENTITY_TYPES).forEach(([value, config]) => {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = config.label;
      typeSelect.appendChild(option);
    });
    typeSelect.value = group.type;
    typeSelect.addEventListener("change", () => setGroupType(group.id, typeSelect.value));
    typeCell.appendChild(typeSelect);

    const countCell = document.createElement("td");
    countCell.textContent = String(group.occurrences.length);

    const actionCell = document.createElement("td");
    const actionSelect = document.createElement("select");
    actionSelect.className = "action-select";
    actionSelect.innerHTML = '<option value="MASK">Скрыть</option><option value="KEEP">Не скрывать</option><option value="REVIEW">Решить позже</option>';
    actionSelect.value = group.action;
    actionSelect.addEventListener("change", () => setGroupAction(group.id, actionSelect.value));
    actionCell.appendChild(actionSelect);

    const editCell = document.createElement("td");
    const buttons = document.createElement("div");
    buttons.className = "row-buttons";
    const locateButton = document.createElement("button");
    locateButton.type = "button";
    locateButton.className = "row-button";
    locateButton.textContent = "Показать в документе";
    locateButton.addEventListener("click", () => focusOccurrence(group));
    const splitButton = document.createElement("button");
    splitButton.type = "button";
    splitButton.className = "row-button";
    splitButton.textContent = "Использовать разные замены";
    splitButton.disabled = group.aliases.length < 2;
    splitButton.addEventListener("click", () => splitGroup(group));
    buttons.append(locateButton, splitButton);
    editCell.appendChild(buttons);

    row.append(selectCell, originalCell, tokenCell, typeCell, countCell, actionCell, editCell);
    rows.appendChild(row);
  });
  $("mergeEntitiesButton").disabled = state.selectedGroups.size < 2;
}

function renderIntegrityNotice() {
  const notice = $("resultNotice");
  const actions = $("integrityActions");
  const override = $("warningOverrideLabel");
  const review = state.registry.filter((group) => group.action === "REVIEW");
  actions.classList.toggle("hidden", state.integrity.ok);
  override.classList.toggle("hidden", state.integrity.ok);

  if (!state.integrity.ok) {
    notice.className = "notice error";
    notice.textContent = "При проверке результата обнаружено отличие. Пересчитайте документ или откройте расширенные настройки.";
    $("integrityDetails").textContent = `Первое отличие: позиция ${state.integrity.firstDifference}\n\nОжидалось:\n${state.integrity.expectedSnippet}\n\nПолучено:\n${state.integrity.actualSnippet}`;
  } else if (state.residual.critical > 0) {
    notice.className = "notice";
    notice.textContent = `В защищённой копии могут остаться чувствительные данные: ${state.residual.critical}. Откройте расширенные настройки и проверьте результат.`;
  } else if (review.length > 0) {
    notice.className = "notice";
    notice.textContent = `Некоторые данные ожидают решения: ${review.length}. Откройте расширенные настройки.`;
  } else {
    notice.className = "notice success";
    notice.textContent = "Готово: защищённая копия создана и проверена автоматически.";
  }
}

function renderResult(renderRows = true) {
  const categories = new Set(state.registry.map((group) => group.type));
  const review = state.registry.filter((group) => group.action === "REVIEW");
  const methods = ["обработано автоматически"];
  if (state.ocrPages.length) methods.push(`OCR: ${state.ocrPages.length} стр.`);
  $("resultFileName").textContent = `${state.source?.name || "Материал"} · ${methods.join(" · ")}`;
  $("foundCount").textContent = state.entities.length;
  $("entityCount").textContent = state.registry.length;
  $("reviewCount").textContent = review.length;
  $("categoryCount").textContent = categories.size;
  $("sourceLength").textContent = `${state.text.length.toLocaleString("ru-RU")} знаков`;
  $("safeLength").textContent = `${state.result.text.length.toLocaleString("ru-RU")} знаков`;
  $("sourcePreview").value = state.text;
  $("safePreview").value = state.result.text;
  $("mapSection").classList.toggle("hide-originals", state.hideOriginals);
  $("toggleOriginalsButton").textContent = state.hideOriginals ? "Показать исходные данные" : "Скрыть исходные данные";
  renderIntegrityNotice();
  if (renderRows) renderEntityRows();
  updateDownloadState();
  refreshRestoreMapSources();
  autoSaveSession();
}

function updateDownloadState() {
  const warningAccepted = state.integrity?.ok || $("warningOverrideCheckbox").checked;
  const enabled = Boolean(state.result) && warningAccepted;
  $("downloadTextButton").disabled = !enabled;
  $("copyTextButton").disabled = !enabled;
  $("downloadMapButton").disabled = !enabled || !state.result?.map?.entries?.length;
  $("downloadBundleButton").disabled = !enabled;
}

function resetApplication() {
  state.source = null;
  state.text = "";
  state.entities = [];
  state.registry = [];
  state.result = null;
  state.integrity = null;
  state.residual = null;
  state.tokenAssignments = {};
  state.canonicalOverrides = {};
  state.sessionId = null;
  state.createdAt = null;
  state.selectedGroups.clear();
  state.manualSelection = null;
  state.ocrPages = [];
  state.qwenUsed = false;
  state.qwenModel = null;
  $("fileInput").value = "";
  $("pasteInput").value = "";
  $("pasteCharCount").textContent = "0 знаков";
  $("manualValue").value = "";
  $("warningOverrideCheckbox").checked = false;
  sessionStorage.removeItem(SESSION_KEY);
  setMode("anonymize");
  setView("input");
}

function selectedManualEntity(value, type) {
  const selection = state.manualSelection;
  if (!selection || selection.source !== "source" || selection.value !== value) return [];
  const entity = {
    id: `manual-${type}-${selection.start}-${Date.now()}`,
    type,
    value,
    start: selection.start,
    end: selection.end,
    action: "MASK",
    confidence: "confirmed",
    source: "manual-selection"
  };
  return assignEntityGroups([entity]);
}

function appendNewEntities(additions) {
  const occupied = new Set(state.entities.map((item) => `${item.start}:${item.end}`));
  let added = 0;
  additions.forEach((item) => {
    if (!occupied.has(`${item.start}:${item.end}`)) {
      state.entities.push(item);
      occupied.add(`${item.start}:${item.end}`);
      added += 1;
    }
  });
  state.entities.sort((left, right) => left.start - right.start);
  return added;
}

function addManualValue() {
  const value = $("manualValue").value.trim();
  const type = $("manualType").value;
  const scope = $("manualScope").value;
  if (!value) return showToast("Выделите или введите фрагмент, который нужно скрыть.");
  let additions = scope === "one" ? selectedManualEntity(value, type) : [];
  if (!additions.length) additions = addManualEntity(state.text, value, type, scope);
  if (!additions.length) return showToast("Такой фрагмент не найден в исходном тексте.");
  const added = appendNewEntities(additions);
  $("manualValue").value = "";
  state.manualSelection = null;
  recalculate();
  renderResult();
  showToast(added ? `Фрагмент скрыт в местах: ${added}.` : "Все такие фрагменты уже скрыты.");
}

function findSimilarValues() {
  const value = $("manualValue").value.trim();
  const type = $("manualType").value;
  if (!value) return showToast("Сначала выделите или введите значение.");
  const identity = entityIdentity({ type, value });
  const matches = detectEntities(state.text).filter((item) => item.type === type && entityIdentity(item) === identity);
  if (!matches.length) return showToast("Похожие написания не найдены автоматическими правилами.");
  const added = appendNewEntities(matches);
  recalculate();
  renderResult();
  showToast(added ? `Добавлено похожих вариантов: ${added}.` : "Все похожие варианты уже учтены.");
}

function captureSelection(textarea, source) {
  const start = textarea.selectionStart;
  const end = textarea.selectionEnd;
  if (!Number.isInteger(start) || end <= start) return;
  let value = textarea.value.slice(start, end).trim();
  if (!value || value.length > 250) return;
  if (source === "safe") {
    const entry = state.result?.map?.entries?.find((candidate) => candidate.token === value);
    if (entry) value = entry.original;
    else if (!state.text.includes(value)) return showToast("Выделите значение в исходном документе или целое обозначение в защищённой копии.");
  }
  $("manualValue").value = value;
  state.manualSelection = { source, start, end, value };
  $("selectionBanner").textContent = `Выбрано: «${value}». Укажите категорию и добавьте в карту.`;
  $("manualValue").scrollIntoView({ behavior: "smooth", block: "center" });
}

function mergeSelectedEntities() {
  const groups = state.registry.filter((group) => state.selectedGroups.has(group.id));
  if (groups.length < 2) return;
  if (new Set(groups.map((group) => group.type)).size > 1) return showToast("Сначала выберите для этих данных один тип.");
  const target = groups[0];
  const sourceIds = new Set(groups.slice(1).map((group) => group.id));
  state.entities.forEach((entity) => {
    if (sourceIds.has(entity.groupId)) entity.groupId = target.id;
  });
  sourceIds.forEach((id) => {
    delete state.tokenAssignments[id];
    delete state.canonicalOverrides[id];
  });
  state.selectedGroups.clear();
  recalculate();
  renderResult();
  showToast(`Теперь для выбранных данных используется одна замена: ${state.tokenAssignments[target.id]}.`);
}

function currentMap() {
  return state.result?.map || null;
}

function mapFromSnapshot(snapshot) {
  if (snapshot?.map) return snapshot.map;
  if (!snapshot?.text || !Array.isArray(snapshot.entities)) return null;
  return applyReplacements(snapshot.text, snapshot.entities, {
    tokenAssignments: snapshot.tokenAssignments || {},
    canonicalOverrides: snapshot.canonicalOverrides || {},
    sessionId: snapshot.sessionId,
    createdAt: snapshot.createdAt
  }).map;
}

function refreshRestoreMapSources() {
  const select = $("restoreMapSelect");
  const previous = select.value;
  select.innerHTML = '<option value="current">Ключ текущего документа</option>';
  const sessions = getSavedSessions();
  Object.values(sessions).forEach((snapshot) => {
    const option = document.createElement("option");
    option.value = `saved:${snapshot.sessionId}`;
    option.textContent = `Из черновика: ${snapshot.source?.name || snapshot.sessionId}`;
    select.appendChild(option);
  });
  if (state.uploadedMap) {
    const option = document.createElement("option");
    option.value = "uploaded";
    option.textContent = `Загруженный ключ: ${state.uploadedMapName}`;
    select.appendChild(option);
  }
  if ([...select.options].some((option) => option.value === previous)) select.value = previous;
  updateRestoreMapStatus();
}

function selectedRestoreMap() {
  const value = $("restoreMapSelect").value;
  if (value === "current") return currentMap();
  if (value === "uploaded") return state.uploadedMap;
  if (value.startsWith("saved:")) return mapFromSnapshot(getSavedSessions()[value.slice(6)]);
  return null;
}

function updateRestoreMapStatus() {
  const map = selectedRestoreMap();
  const status = $("restoreMapStatus");
  if (!map) {
    status.textContent = "Ключ восстановления недоступен. Загрузите ключ или сначала создайте защищённую копию.";
    return;
  }
  const validation = validateMap(map);
  status.textContent = validation.ok
    ? `Ключ готов: сохранено значений — ${map.entries.length}.`
    : validation.errors.join(" ");
}

async function loadRestoreMap(file) {
  try {
    const map = JSON.parse(await file.text());
    const validation = validateMap(map);
    if (!validation.ok) throw new Error(validation.errors.join(" "));
    state.uploadedMap = map;
    state.uploadedMapName = file.name;
    refreshRestoreMapSources();
    $("restoreMapSelect").value = "uploaded";
    updateRestoreMapStatus();
    showToast("Ключ восстановления загружен.");
  } catch (error) {
    showToast(`Не удалось загрузить ключ: ${error.message}`);
  }
}

function runRestoration() {
  const text = $("restoreInput").value;
  const map = selectedRestoreMap();
  if (!text.trim()) return showToast("Вставьте или загрузите защищённый текст.");
  if (!map) return showToast("Выберите или загрузите ключ восстановления.");
  const result = restoreWithDiagnostics(text, map);
  state.restoreResult = result;
  $("restoreNotice").classList.remove("hidden");
  $("restoreMetrics").classList.remove("hidden");
  $("restorePreviewGrid").classList.remove("hidden");
  $("restoreActions").classList.remove("hidden");
  $("restoreBeforePreview").value = text;
  $("restoreAfterPreview").value = result.restored;
  $("restoredCount").textContent = result.replacedCount || 0;
  $("unknownTokenCount").textContent = result.unknownTokens.length;
  $("unusedTokenCount").textContent = result.unusedTokens.length;
  $("mapEntryCount").textContent = map.entries.length;
  const notice = $("restoreNotice");
  if (result.errors.length) {
    notice.className = "notice error";
    notice.textContent = result.errors.join(" ");
  } else if (!result.usedTokens.length) {
    notice.className = "notice error";
    notice.textContent = "В тексте не найдено обозначений из выбранного ключа. Проверьте, что ключ относится к этому документу.";
  } else if (result.unknownTokens.length) {
    notice.className = "notice";
    notice.textContent = `Часть данных восстановлена, но неизвестные обозначения оставлены без изменения: ${result.unknownTokens.join(", ")}.`;
  } else {
    notice.className = "notice success";
    notice.textContent = "Все найденные обозначения распознаны, исходные данные восстановлены.";
  }
}

function downloadBundle() {
  if (!window.fflate?.zipSync || !window.fflate?.strToU8) return showToast("Модуль упаковки ZIP не загружен.");
  if (!window.confirm("ZIP содержит ключ восстановления с исходными данными. Скачать его и хранить в защищённом месте?")) return;
  const base = safeBaseName(state.source?.name);
  const manifest = {
    format: "mik-anonymizer-session",
    version: 2,
    sessionId: state.sessionId,
    createdAt: state.createdAt,
    sourceName: state.source?.name,
    sourceFingerprint: fingerprintText(state.text),
    safeFingerprint: fingerprintText(state.result.text),
    warning: "Ключ восстановления содержит исходные чувствительные данные. Храните его отдельно от защищённого документа."
  };
  const archive = window.fflate.zipSync({
    [`${base}_безопасный.txt`]: window.fflate.strToU8(state.result.text),
    [`${base}_ключ_восстановления.json`]: window.fflate.strToU8(JSON.stringify(state.result.map, null, 2)),
    "информация_о_черновике.json": window.fflate.strToU8(JSON.stringify(manifest, null, 2))
  }, { level: 6 });
  downloadBlob(`${base}_комплект.zip`, new Blob([archive], { type: "application/zip" }));
  showToast("ZIP с защищённым текстом и ключом восстановления скачан.");
}

function bindUpload() {
  const dropzone = $("dropzone");
  $("fileInput").addEventListener("change", (event) => processFile(event.target.files?.[0]));
  ["dragenter", "dragover"].forEach((name) => dropzone.addEventListener(name, (event) => {
    event.preventDefault();
    dropzone.classList.add("dragging");
  }));
  ["dragleave", "drop"].forEach((name) => dropzone.addEventListener(name, (event) => {
    event.preventDefault();
    dropzone.classList.remove("dragging");
  }));
  dropzone.addEventListener("drop", (event) => processFile(event.dataTransfer?.files?.[0]));
}

function bindActions() {
  $("anonymizeModeButton").addEventListener("click", () => setMode("anonymize"));
  $("restoreModeButton").addEventListener("click", () => setMode("restore"));
  $("openRestoreButton").addEventListener("click", () => setMode("restore"));
  $("backToAnonymizeButton").addEventListener("click", () => setMode("anonymize"));
  $("fileTabButton").addEventListener("click", () => setInputTab("file"));
  $("textTabButton").addEventListener("click", () => setInputTab("text"));
  $("pasteInput").addEventListener("input", () => {
    $("pasteCharCount").textContent = `${$("pasteInput").value.length.toLocaleString("ru-RU")} знаков`;
  });
  $("processTextButton").addEventListener("click", () => {
    const text = $("pasteInput").value;
    processSource(text, { name: "Вставленный текст.txt", size: new Blob([text]).size, kind: "text", mime: "text/plain" });
  });
  $("newDocumentButton").addEventListener("click", resetApplication);
  $("addManualButton").addEventListener("click", addManualValue);
  $("findSimilarButton").addEventListener("click", findSimilarValues);
  $("manualValue").addEventListener("keydown", (event) => {
    if (event.key === "Enter") addManualValue();
  });
  $("mergeEntitiesButton").addEventListener("click", mergeSelectedEntities);
  $("toggleOriginalsButton").addEventListener("click", () => {
    state.hideOriginals = !state.hideOriginals;
    renderResult(false);
  });
  ["mouseup", "keyup", "select"].forEach((name) => {
    $("sourcePreview").addEventListener(name, () => captureSelection($("sourcePreview"), "source"));
    $("safePreview").addEventListener(name, () => captureSelection($("safePreview"), "safe"));
  });
  $("warningOverrideCheckbox").addEventListener("change", updateDownloadState);
  $("recalculateButton").addEventListener("click", () => {
    recalculate();
    renderResult();
    showToast("Результат пересчитан из исходного текста и текущей карты.");
  });
  $("downloadTextButton").addEventListener("click", () => {
    downloadFile(`${safeBaseName(state.source?.name)}_обезличено.txt`, state.result.text);
    showToast("Безопасный текст скачан.");
  });
  $("copyTextButton").addEventListener("click", () => copyText(state.result.text, "Безопасный текст скопирован."));
  $("downloadMapButton").addEventListener("click", () => {
    if (!window.confirm("Ключ восстановления содержит исходные данные. Скачать его отдельно от защищённого документа?")) return;
    downloadFile(`${safeBaseName(state.source?.name)}_ключ_восстановления.json`, JSON.stringify(state.result.map, null, 2), "application/json;charset=utf-8");
    showToast("Ключ восстановления скачан.");
  });
  $("downloadBundleButton").addEventListener("click", downloadBundle);
  $("saveSessionButton").addEventListener("click", savePersistentSession);
  $("deleteCurrentSessionButton").addEventListener("click", deletePersistentSession);
  $("savedSessionSelect").addEventListener("change", () => {
    $("loadSavedSessionButton").disabled = !$("savedSessionSelect").value;
  });
  $("loadSavedSessionButton").addEventListener("click", () => {
    const snapshot = getSavedSessions()[$("savedSessionSelect").value];
    if (snapshot) restoreSnapshot(snapshot);
  });
  $("clearSavedSessionsButton").addEventListener("click", () => {
    if (!window.confirm("Удалить все сохранённые черновики с этого устройства?")) return;
    localStorage.removeItem(SAVED_KEY);
    refreshSavedSessions();
    refreshRestoreMapSources();
    showToast("Все сохранённые черновики удалены.");
  });

  $("restoreInput").addEventListener("input", () => {
    $("restoreCharCount").textContent = `${$("restoreInput").value.length.toLocaleString("ru-RU")} знаков`;
  });
  $("restoreFileInput").addEventListener("change", async (event) => {
    try {
      const file = event.target.files?.[0];
      validateFile(file);
      $("restoreInput").value = await extractText(file);
      $("restoreCharCount").textContent = `${$("restoreInput").value.length.toLocaleString("ru-RU")} знаков`;
      showToast("Текст для восстановления загружен.");
    } catch (error) {
      showToast(errorMessage(error));
    }
  });
  $("restoreMapFileInput").addEventListener("change", (event) => loadRestoreMap(event.target.files?.[0]));
  $("restoreMapSelect").addEventListener("change", updateRestoreMapStatus);
  $("restoreRunButton").addEventListener("click", runRestoration);
  $("downloadRestoredButton").addEventListener("click", () => {
    downloadFile("восстановленный_текст.txt", state.restoreResult?.restored || "");
    showToast("Восстановленный текст скачан.");
  });
  $("copyRestoredButton").addEventListener("click", () => copyText(state.restoreResult?.restored || "", "Восстановленный текст скопирован."));
}

function bindNavigation() {
  $("burgerButton").addEventListener("click", () => {
    const menu = $("mobileMenu");
    const opened = menu.classList.toggle("show");
    $("burgerButton").setAttribute("aria-expanded", String(opened));
  });
  const auth = (() => {
    try { return JSON.parse(localStorage.getItem("mikAuth")); } catch { return null; }
  })();
  const fullName = localStorage.getItem("auth_full_name") || auth?.full_name;
  if (fullName && auth?.isAuthorized) $("profileLink").textContent = fullName;
}

function loadCurrentSession() {
  try {
    const snapshot = JSON.parse(sessionStorage.getItem(SESSION_KEY) || "null");
    if (snapshot?.schema === 2 && snapshot.text && Array.isArray(snapshot.entities)) restoreSnapshot(snapshot);
  } catch {
    sessionStorage.removeItem(SESSION_KEY);
  }
}

renderEntityTypes();
loadQwenStatus();
bindUpload();
bindActions();
bindNavigation();
refreshSavedSessions();
refreshRestoreMapSources();
setInputTab("file");
setView("input");
loadCurrentSession();
