import * as pdfjsLib from "./vendor/pdf.min.mjs";
import {
  ENTITY_TYPES,
  addManualEntity,
  appendUniqueEntities,
  applyReplacements,
  assignEntityGroups,
  buildEntityRegistry,
  detectEntities,
  entityIdentity,
  fingerprintText,
  inferEntityType,
  resultSafetyStatus,
  restoreWithDiagnostics,
  scanResidual,
  splitTokenizedText,
  validateIntegrity,
  validateMap
} from "./anonymizer-engine.js";
import { mergeEntityCandidates, pageNeedsOcr, splitDetectionContributions } from "./anonymizer-pipeline.js";
import {
  createAnonymizedDocx,
  createClassicDocx,
  locateDocxRange,
  parseClassicDocument,
  parseDocxPackage
} from "./anonymizer-docx.js";
import {
  deleteDraftRecord,
  getDraftRecord,
  listDraftRecords,
  migrateLegacyDrafts,
  saveDraftRecord
} from "./anonymizer-storage.js";

pdfjsLib.GlobalWorkerOptions.workerSrc = "/vendor/pdf.worker.min.mjs";

const MAX_FILE_SIZE = 10 * 1024 * 1024;
const MAX_MANUAL_SELECTION = 20_000;
const DEFAULT_QWEN_TEXT_LIMIT = 60_000;
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
  draftName: "",
  selectedGroups: new Set(),
  manualSelection: null,
  lastManualChange: null,
  suppressNextPersistentAutoSave: false,
  hideOriginals: false,
  uploadedMap: null,
  uploadedMapName: "",
  restoreResult: null,
  restoreSourceName: "",
  restoreSourceFormat: "text",
  ocrPages: [],
  qwenUsed: false,
  qwenModel: null,
  qwenStatus: "idle",
  qwenDiagnostics: null,
  qwenTrace: null,
  sourceBinary: null,
  docxModel: null
};

let activeOcrWorker = null;
let qwenConfiguration = { configured: false, model: null, promptVersion: null, maxTextLength: DEFAULT_QWEN_TEXT_LIMIT, localOnly: true };
let qwenStatusPromise = null;
let savedSessionsCache = {};
let occurrenceNavigation = null;
const sourceRangeByTextNode = new WeakMap();

const $ = (id) => document.getElementById(id);
const sleep = (milliseconds) => new Promise((resolve) => window.setTimeout(resolve, milliseconds));
const makeId = () => window.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;

function qwenTextLimit() {
  const configuredLimit = Number(qwenConfiguration.maxTextLength);
  return Number.isInteger(configuredLimit) && configuredLimit > 0 ? configuredLimit : DEFAULT_QWEN_TEXT_LIMIT;
}

function qwenCounterText(length) {
  return `${Number(length || 0).toLocaleString("ru-RU")} / ${qwenTextLimit().toLocaleString("ru-RU")}`;
}

function updatePasteCounter() {
  const counter = $("pasteCharCount");
  if (!counter) return;
  const length = $("pasteInput")?.value.length || 0;
  counter.textContent = `${qwenCounterText(length)} знаков для Qwen`;
  counter.classList.toggle("over-limit", length > qwenTextLimit());
}

function renderQwenCharacterMetric() {
  const metric = $("qwenCharacterMetric");
  if (!metric) return;
  const length = state.text.length;
  const overLimit = length > qwenTextLimit();
  $("qwenCharacterCount").textContent = qwenCounterText(length);
  const status = $("qwenCharacterStatus");
  const details = $("qwenDiagnosticsDetails");
  status.removeAttribute("title");
  details.textContent = "";
  details.classList.add("hidden");
  details.classList.remove("has-warning");
  metric.classList.toggle("warning", overLimit || state.qwenStatus === "error");
  metric.classList.toggle("ok", state.qwenUsed);
  if (overLimit) {
    status.textContent = "лимит Qwen превышен — применены локальные правила";
  } else if (state.qwenUsed) {
    const diagnostics = state.qwenDiagnostics;
    status.textContent = diagnostics
      ? `Qwen: вернул ${diagnostics.returned}, исправлено ${diagnostics.repaired || 0}, добавлено ${diagnostics.addedToResult ?? diagnostics.accepted}, отклонено ${diagnostics.rejected}`
      : "весь текст дополнительно проверен Qwen";
    if (diagnostics) {
      const labels = {
        invalid_candidate: "некорректный объект",
        type_not_allowed: "неизвестный тип",
        value_missing: "пустое значение",
        value_not_found: "значение отсутствует в тексте",
        occurrence_ambiguous: "неоднозначное вхождение",
        duplicate: "дубликат",
        entity_limit_exceeded: "превышен лимит сущностей"
      };
      const rejectionReasons = Object.entries(diagnostics.reasons || {})
        .map(([reason, count]) => `${labels[reason] || reason}: ${count}`)
        .join("; ");
      const responseIssues = diagnostics.responseIssues?.includes("entities_not_array")
        ? "ответ не содержит массив entities"
        : (diagnostics.responseIssues || []).join("; ");
      const contribution = [
        `прошли проверку: ${diagnostics.accepted || 0}`,
        `совпали с локальными: ${diagnostics.overlappingRuleCandidates || 0}`,
        diagnostics.promptInjectionSegmentsRemoved
          ? `до ИИ вырезано опасных инструкций: ${diagnostics.promptInjectionSegmentsRemoved}`
          : ""
      ].filter(Boolean).join("; ");
      const trace = state.qwenTrace
        ? `запрос ${state.qwenTrace.requestId}; ответ за ${state.qwenTrace.durationMs} мс`
        : "";
      details.textContent = [contribution, rejectionReasons, responseIssues, trace].filter(Boolean).join("; ");
      details.classList.remove("hidden");
      details.classList.toggle("has-warning", Boolean(diagnostics.rejected || diagnostics.responseIssues?.length));
      status.title = details.textContent;
    }
  } else if (!qwenConfiguration.configured) {
    status.textContent = "Qwen не настроен — применены локальные правила";
  } else {
    status.textContent = "Qwen недоступен — применены локальные правила";
    if (state.qwenStatus === "error" && state.qwenTrace) {
      const upstream = state.qwenTrace.upstreamStatus ? ` · upstream ${state.qwenTrace.upstreamStatus}` : "";
      const attempts = state.qwenTrace.attempts ? ` · попыток: ${state.qwenTrace.attempts}` : "";
      details.textContent = `запрос ${state.qwenTrace.requestId}${upstream}${attempts} · ${state.qwenTrace.durationMs} мс`;
      details.classList.remove("hidden");
      details.classList.add("has-warning");
    }
  }
}

function setDetectionDetailsExpanded(expanded) {
  const button = $("detectionDetailsButton");
  const panel = $("detectionDetailsPanel");
  if (!button || !panel) return;
  button.setAttribute("aria-expanded", String(expanded));
  button.textContent = expanded ? "Скрыть подробности" : "Подробнее";
  panel.classList.toggle("hidden", !expanded);
}

function renderDetectionEntityList(element, entities, emptyMessage) {
  element.innerHTML = "";
  if (!entities.length) {
    const item = document.createElement("li");
    item.className = "detection-empty";
    item.textContent = emptyMessage;
    element.appendChild(item);
    return;
  }

  entities.forEach((entity) => {
    const item = document.createElement("li");
    const type = document.createElement("span");
    type.className = "entity-type";
    type.textContent = ENTITY_TYPES[entity.type]?.label || entity.type || "Другое";
    const value = document.createElement("code");
    value.textContent = entity.value || state.text.slice(entity.start, entity.end);
    item.append(type, value);
    element.appendChild(item);
  });
}

function renderDetectionContributions() {
  const { system, ai } = splitDetectionContributions(state.entities);
  $("systemDetectedCount").textContent = system.length.toLocaleString("ru-RU");
  $("aiAddedCount").textContent = ai.length.toLocaleString("ru-RU");
  $("systemDetectedDetailsCount").textContent = system.length.toLocaleString("ru-RU");
  $("aiAddedDetailsCount").textContent = ai.length.toLocaleString("ru-RU");

  const aiStatus = $("aiContributionStatus");
  if (state.qwenUsed) {
    aiStatus.textContent = ai.length
      ? "Новые объекты, которых не было среди находок системы"
      : "Новых объектов ПД диагностика с ИИ не добавила";
  } else if (state.qwenStatus === "limit") {
    aiStatus.textContent = "Диагностика с ИИ пропущена: превышен лимит текста";
  } else if (state.qwenStatus === "error") {
    aiStatus.textContent = "Диагностика с ИИ была недоступна";
  } else {
    aiStatus.textContent = "Диагностика с ИИ не выполнялась";
  }

  renderDetectionEntityList(
    $("systemDetectedItems"),
    system,
    "Основная система не обнаружила объектов ПД."
  );
  renderDetectionEntityList(
    $("aiAddedItems"),
    ai,
    state.qwenUsed
      ? "Диагностика с ИИ не добавила новых объектов ПД."
      : "Диагностика с ИИ не выполнялась или была недоступна."
  );
}

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
    seedRestoreFromCurrent();
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

async function extractDocx(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  return parseDocxPackage(bytes, window.fflate).text;
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
  state.qwenStatus = "idle";
  state.qwenDiagnostics = null;
  state.qwenTrace = null;
  state.sourceBinary = null;
  state.docxModel = null;
  setDetectionDetailsExpanded(false);
  state.restoreResult = null;
  state.restoreSourceName = "";
  state.restoreSourceFormat = "text";
  $("processingFileName").textContent = source.name;
  $("processingFileMeta").textContent = source.kind === "text" ? "Подготовка текста" : formatBytes(source.size);
  setView("processing");
  $("progressBar").style.width = "8%";
}

async function requestQwenEntities(text, ruleEntities, source) {
  const authToken = localStorage.getItem("auth_token") || "";
  if (!authToken) throw new Error("QWEN_AUTH_REQUIRED");
  const response = await fetch("/api/anonymizer/qwen/entities", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-auth-token": authToken
    },
    body: JSON.stringify({
      text,
      ruleCandidates: ruleEntities,
      document: {
        format: source?.format || (source?.kind === "text" ? "text" : "unknown"),
        size: Number(source?.size) || 0
      },
      confirmed: true
    })
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload.error || `QWEN_HTTP_${response.status}`);
    error.trace = payload.trace || (payload.requestId ? { requestId: payload.requestId } : null);
    throw error;
  }
  state.qwenUsed = true;
  state.qwenModel = payload.model || qwenConfiguration.model || null;
  state.qwenTrace = payload.trace || null;
  const entities = Array.isArray(payload.entities) ? payload.entities : [];
  state.qwenDiagnostics = payload.diagnostics || {
    returned: entities.length,
    located: entities.length,
    repaired: 0,
    accepted: entities.length,
    addedToResult: entities.length,
    rejected: 0,
    reasons: {}
  };
  return entities;
}

async function loadQwenStatus() {
  try {
    const response = await fetch("/api/anonymizer/qwen/status", { headers: { Accept: "application/json" } });
    if (!response.ok) throw new Error(`QWEN_STATUS_HTTP_${response.status}`);
    const payload = await response.json();
    qwenConfiguration = {
      configured: Boolean(payload.configured),
      model: payload.model || null,
      profile: payload.profile || null,
      maxTextLength: Number(payload.maxTextLength) || DEFAULT_QWEN_TEXT_LIMIT,
      promptVersion: payload.promptVersion || null,
      localOnly: false
    };
  } catch (error) {
    console.error("Qwen status check failed:", error?.message);
    qwenConfiguration = { configured: false, model: null, promptVersion: null, maxTextLength: DEFAULT_QWEN_TEXT_LIMIT, localOnly: true };
  }
  updatePasteCounter();
  if (state.result) renderQwenCharacterMetric();
  return qwenConfiguration;
}

function ensureQwenStatus() {
  if (!qwenStatusPromise) qwenStatusPromise = loadQwenStatus();
  return qwenStatusPromise;
}

function sessionSnapshot() {
  return {
    schema: 3,
    source: state.source,
    text: state.text,
    entities: state.entities,
    tokenAssignments: state.tokenAssignments,
    canonicalOverrides: state.canonicalOverrides,
    sessionId: state.sessionId,
    createdAt: state.createdAt,
    draftName: state.draftName,
    map: state.result?.map || null,
    updatedAt: new Date().toISOString()
  };
}

function autoSaveSession() {
  if (!state.text || !state.result) return;
  try {
    sessionStorage.setItem(SESSION_KEY, JSON.stringify(sessionSnapshot()));
    $("sessionStatus").textContent = savedSessionsCache[state.sessionId]
      ? "Черновик сохранён на этом устройстве. Последние изменения сохраняются автоматически."
      : "Текущий черновик хранится только до закрытия вкладки.";
  } catch {
    $("sessionStatus").textContent = "Не удалось временно сохранить текущий черновик в браузере.";
  }
  window.clearTimeout(autoSaveSession.timer);
  const sessionId = state.sessionId;
  const suppressPersistentSave = state.suppressNextPersistentAutoSave;
  state.suppressNextPersistentAutoSave = false;
  if (savedSessionsCache[sessionId] && !suppressPersistentSave) {
    autoSaveSession.timer = window.setTimeout(() => {
      if (state.sessionId === sessionId && savedSessionsCache[sessionId]) persistCurrentDraft(true);
    }, 500);
  }
}

function getSavedSessions() {
  return savedSessionsCache;
}

function refreshSavedSessions() {
  const sessions = getSavedSessions();
  const items = Object.values(sessions).sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)));
  const list = $("savedDraftList");
  list.replaceChildren();
  $("savedDraftCount").textContent = String(items.length);
  $("savedSessionsHint").textContent = items.length
    ? "Открывайте, переименовывайте и удаляйте черновики по отдельности. Они доступны только на этом устройстве."
    : "Черновик содержит исходный документ и данные для восстановления. Не сохраняйте его на чужом компьютере.";
  if (!items.length) {
    const empty = document.createElement("p");
    empty.className = "draft-empty";
    empty.textContent = "Сохранённых черновиков пока нет.";
    list.appendChild(empty);
    return;
  }
  items.forEach((snapshot) => {
    const row = document.createElement("article");
    row.className = "draft-row";
    if (snapshot.sessionId === state.sessionId) row.classList.add("is-current");

    const summary = document.createElement("div");
    summary.className = "draft-info";
    const title = document.createElement("strong");
    title.textContent = snapshot.draftName || snapshot.source?.name || "Без названия";
    const source = document.createElement("span");
    source.textContent = snapshot.source?.name || "Текстовый материал";
    const meta = document.createElement("small");
    meta.className = "draft-meta";
    const hiddenCount = snapshot.map?.entries?.reduce((total, entry) => total + (entry.occurrences?.length || 0), 0)
      || snapshot.entities?.filter((entity) => entity.action !== "KEEP").length
      || 0;
    meta.textContent = `${new Date(snapshot.updatedAt).toLocaleString("ru-RU")} · скрыто: ${hiddenCount}`;
    summary.append(title, source, meta);

    const actions = document.createElement("div");
    actions.className = "draft-actions";
    const openButton = document.createElement("button");
    openButton.className = "btn secondary compact";
    openButton.type = "button";
    openButton.textContent = snapshot.sessionId === state.sessionId ? "Открыт" : "Открыть";
    openButton.disabled = snapshot.sessionId === state.sessionId;
    openButton.addEventListener("click", () => openDraftById(snapshot.sessionId));
    const renameButton = document.createElement("button");
    renameButton.className = "btn ghost compact";
    renameButton.type = "button";
    renameButton.textContent = "Переименовать";
    renameButton.addEventListener("click", () => renameDraftById(snapshot.sessionId));
    const deleteButton = document.createElement("button");
    deleteButton.className = "btn ghost compact danger-text";
    deleteButton.type = "button";
    deleteButton.textContent = "Удалить";
    deleteButton.addEventListener("click", () => deleteDraftById(snapshot.sessionId));
    actions.append(openButton, renameButton, deleteButton);
    row.append(summary, actions);
    list.appendChild(row);
  });
}

function currentDraftSourceBlob() {
  if (!state.sourceBinary || state.source?.format !== "docx") return null;
  return new Blob([state.sourceBinary], { type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" });
}

async function persistCurrentDraft(silent = false) {
  if (!state.result) return;
  const snapshot = sessionSnapshot();
  try {
    await saveDraftRecord(snapshot, currentDraftSourceBlob());
    if (state.sessionId !== snapshot.sessionId) return;
    savedSessionsCache[snapshot.sessionId] = snapshot;
    refreshSavedSessions();
    refreshRestoreMapSources();
    $("sessionStatus").textContent = "Черновик сохранён на этом устройстве. Последние изменения сохраняются автоматически.";
    if (!silent) showToast("Черновик сохранён на этом устройстве.");
  } catch {
    $("sessionStatus").textContent = "Не удалось обновить сохранённый черновик в хранилище браузера.";
    if (!silent) showToast("Не удалось сохранить черновик: хранилище браузера недоступно или переполнено.");
  }
}

async function openDraftById(id) {
  try {
    const record = await getDraftRecord(id);
    if (!record?.snapshot) return showToast("Черновик не найден в хранилище браузера.");
    await restoreSnapshot(record.snapshot, record.sourceBlob);
    refreshSavedSessions();
  } catch {
    showToast("Не удалось открыть черновик из хранилища браузера.");
  }
}

async function renameDraftById(id) {
  try {
    const record = await getDraftRecord(id);
    if (!record?.snapshot) return showToast("Черновик не найден в хранилище браузера.");
    const previousName = record.snapshot.draftName || record.snapshot.source?.name || "Без названия";
    const enteredName = window.prompt("Новое название черновика", previousName);
    if (enteredName === null) return;
    const draftName = enteredName.trim().slice(0, 80);
    if (!draftName) return showToast("Название черновика не может быть пустым.");
    const snapshot = { ...record.snapshot, draftName, updatedAt: new Date().toISOString() };
    await saveDraftRecord(snapshot, record.sourceBlob);
    savedSessionsCache[id] = snapshot;
    if (state.sessionId === id) {
      state.draftName = draftName;
      $("draftNameInput").value = draftName;
    }
    refreshSavedSessions();
    refreshRestoreMapSources();
    showToast("Черновик переименован.");
  } catch {
    showToast("Не удалось переименовать черновик.");
  }
}

async function deleteDraftById(id) {
  const snapshot = savedSessionsCache[id];
  if (!snapshot) return showToast("Черновик не найден в хранилище браузера.");
  const title = snapshot.draftName || snapshot.source?.name || "Без названия";
  if (!window.confirm(`Удалить черновик «${title}» с этого устройства?`)) return;
  try {
    await deleteDraftRecord(id);
    delete savedSessionsCache[id];
    refreshSavedSessions();
    refreshRestoreMapSources();
    if (state.sessionId === id) {
      $("sessionStatus").textContent = "Сохранённая копия удалена. Черновик останется открыт до закрытия вкладки.";
    }
    showToast("Сохранённый черновик удалён.");
  } catch {
    showToast("Не удалось удалить черновик из хранилища браузера.");
  }
}

async function restoreSnapshot(snapshot, sourceBlob = null) {
  if (!snapshot?.text || !Array.isArray(snapshot.entities)) throw new Error("Повреждённый черновик.");
  state.source = snapshot.source || { name: "Восстановленный черновик.txt", size: snapshot.text.length, kind: "text" };
  state.text = snapshot.text;
  state.entities = assignEntityGroups(snapshot.entities);
  state.tokenAssignments = snapshot.tokenAssignments || {};
  state.canonicalOverrides = snapshot.canonicalOverrides || {};
  state.sessionId = snapshot.sessionId || makeId();
  state.createdAt = snapshot.createdAt || new Date().toISOString();
  state.draftName = snapshot.draftName || "";
  $("draftNameInput").value = state.draftName;
  state.ocrPages = snapshot.source?.analysis?.ocrPages || [];
  state.qwenUsed = Boolean(snapshot.source?.analysis?.qwenUsed);
  state.qwenModel = snapshot.source?.analysis?.qwenModel || null;
  state.qwenStatus = snapshot.source?.analysis?.qwenStatus || (state.qwenUsed ? "used" : "local");
  state.qwenDiagnostics = snapshot.source?.analysis?.qwenDiagnostics || null;
  state.qwenTrace = snapshot.source?.analysis?.qwenTrace || null;
  state.sourceBinary = null;
  state.docxModel = null;
  if (sourceBlob && state.source?.format === "docx") {
    state.sourceBinary = new Uint8Array(await sourceBlob.arrayBuffer());
    state.docxModel = parseDocxPackage(state.sourceBinary, window.fflate);
  }
  state.selectedGroups.clear();
  recalculate(false);
  state.suppressNextPersistentAutoSave = true;
  renderResult();
  setMode("anonymize");
  showToast("Черновик открыт.");
}

async function savePersistentSession() {
  if (!state.result) return;
  const enteredName = $("draftNameInput").value.trim();
  state.draftName = enteredName || String(state.source?.name || "Черновик").replace(/\.[^.]+$/u, "");
  $("draftNameInput").value = state.draftName;
  if (!window.confirm("Сохранить черновик на этом устройстве? Он содержит исходный текст и данные для восстановления.")) return;
  await persistCurrentDraft();
}

async function deletePersistentSession() {
  if (!savedSessionsCache[state.sessionId]) return showToast("Этот черновик не был сохранён на устройстве.");
  await deleteDraftById(state.sessionId);
}

async function initializeDraftStorage() {
  try {
    let legacy = {};
    try { legacy = JSON.parse(localStorage.getItem(SAVED_KEY) || "{}"); } catch { legacy = {}; }
    if (legacy && typeof legacy === "object") {
      await migrateLegacyDrafts(legacy);
      localStorage.removeItem(SAVED_KEY);
    }
    const records = await listDraftRecords();
    savedSessionsCache = Object.fromEntries(records.map((record) => [record.id, record.snapshot]));
  } catch (error) {
    console.error("Draft storage initialization failed:", error?.message);
    savedSessionsCache = {};
    $("savedSessionsHint").textContent = "Локальное хранилище черновиков недоступно в этом браузере.";
  }
  refreshSavedSessions();
  refreshRestoreMapSources();
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
  if (state.docxModel) {
    state.result.map.source = { format: "docx", name: state.source?.name || "document.docx" };
    state.result.map.entries.forEach((entry) => {
      entry.occurrences = (entry.occurrences || []).map((occurrence) => ({
        ...occurrence,
        docx: locateDocxRange(state.docxModel, occurrence.start, occurrence.end)
      }));
    });
  }
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
  state.lastManualChange = null;
  state.suppressNextPersistentAutoSave = false;
  state.sessionId = makeId();
  state.createdAt = new Date().toISOString();
  state.draftName = "";
  state.sourceBinary = options.sourceBinary || null;
  state.docxModel = options.docxModel || null;
  $("draftNameInput").value = "";
  setSelectionBanner("Если что-то пропущено, выделите фрагмент в безопасной копии: тип определится, а текст сразу заменится токеном.");
  $("restoreInput").value = "";
  $("restoreCharCount").textContent = "0 знаков";
  $("restoreSourceStatus").textContent = "Файл не выбран";
  clearRestoreResult();
  $("processingFileName").textContent = source.name;
  const sourceMeta = source.kind === "text" ? "Вставленный текст" : formatBytes(source.size);
  $("processingFileMeta").textContent = `${sourceMeta} · Qwen: ${qwenCounterText(text.length)} знаков`;

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
  await ensureQwenStatus();
  $("processingFileMeta").textContent = `${sourceMeta} · Qwen: ${qwenCounterText(text.length)} знаков`;
  const qwenOverLimit = text.length > qwenTextLimit();
  const qwenTask = document.querySelector('[data-task="qwen"]');
  if (qwenTask) qwenTask.textContent = qwenOverLimit && qwenConfiguration.configured
    ? `Qwen пропущен: ${qwenCounterText(text.length)} знаков`
    : qwenConfiguration.configured
      ? "Дополнительно проверяем с помощью ИИ"
      : "Завершаем локальную проверку";
  if (qwenConfiguration.configured && !qwenOverLimit) {
    try {
      const qwenEntities = await requestQwenEntities(text, ruleEntities, source);
      state.entities = assignEntityGroups(mergeEntityCandidates(ruleEntities, qwenEntities));
      state.qwenStatus = "used";
    } catch (error) {
      console.error("Qwen entity search failed:", error?.message);
      state.qwenStatus = "error";
      state.qwenTrace = error?.trace || null;
      showToast("Дополнительная проверка временно недоступна. Документ обработан основным способом.");
    }
  } else if (qwenOverLimit && qwenConfiguration.configured) {
    state.qwenStatus = "limit";
    showToast(`Лимит Qwen — ${qwenTextLimit().toLocaleString("ru-RU")} знаков. Документ обработан локальными правилами.`);
  } else {
    state.qwenStatus = "local";
  }
  markTask("qwen");
  state.source.analysis = {
    ocrPages: state.ocrPages,
    qwenUsed: state.qwenUsed,
    qwenModel: state.qwenModel,
    qwenStatus: state.qwenStatus,
    qwenDiagnostics: state.qwenDiagnostics,
    qwenTrace: state.qwenTrace
  };
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
    const extension = file.name.split(".").pop()?.toLowerCase();
    const source = { name: file.name, size: file.size, kind: "file", mime: file.type || "", format: extension };
    prepareProcessing(source);
    if (extension === "docx") {
      const sourceBinary = new Uint8Array(await file.arrayBuffer());
      const docxModel = parseDocxPackage(sourceBinary, window.fflate);
      await processSource(docxModel.text, source, { prepared: true, sourceBinary, docxModel });
    } else {
      const text = await extractText(file);
      await processSource(text, source, { prepared: true });
    }
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

function closeOccurrenceNavigator() {
  occurrenceNavigation = null;
  $("occurrenceNavigator")?.classList.add("hidden");
  $("safePreview")?.querySelectorAll(".token-active").forEach((element) => element.classList.remove("token-active"));
}

function currentOccurrenceGroup() {
  return occurrenceNavigation ? state.registry.find((group) => group.id === occurrenceNavigation.groupId) : null;
}

function focusOccurrence(group, requestedIndex = 0) {
  const activeGroup = state.registry.find((item) => item.id === group.id) || group;
  const token = state.tokenAssignments[activeGroup.id] || activeGroup.token;
  const targets = [...$("safePreview").querySelectorAll(".document-token")]
    .filter((element) => element.textContent === token);
  if (!targets.length) return showToast("Для этих данных нет токена в безопасной копии.");
  const index = Math.min(Math.max(0, requestedIndex), targets.length - 1);
  $("safePreview").querySelectorAll(".token-active").forEach((element) => element.classList.remove("token-active"));
  const target = targets[index];
  target.classList.add("token-active");
  occurrenceNavigation = { groupId: activeGroup.id, index, total: targets.length };
  $("occurrenceNavigatorLabel").textContent = `${ENTITY_TYPES[activeGroup.type]?.label || "Данные"} · ${index + 1} из ${targets.length}`;
  $("occurrencePreviousButton").disabled = index === 0;
  $("occurrenceNextButton").disabled = index === targets.length - 1;
  $("occurrenceNavigator").classList.remove("hidden");
  target.scrollIntoView({ behavior: "smooth", block: "center" });
  target.classList.remove("token-flash");
  window.requestAnimationFrame(() => target.classList.add("token-flash"));
  window.setTimeout(() => target.classList.remove("token-flash"), 2200);
}

function appendMappedText(parent, value, start = null, end = null, style = null) {
  if (!value) return;
  const textNode = document.createTextNode(value);
  if (Number.isInteger(start) && Number.isInteger(end)) sourceRangeByTextNode.set(textNode, { start, end });
  if (!style) {
    parent.appendChild(textNode);
    return;
  }
  const span = document.createElement("span");
  applyRunStyle(span, style);
  span.appendChild(textNode);
  parent.appendChild(span);
}

function appendToken(parent, value, replacement = null) {
  const part = splitTokenizedText(value).find((item) => item.token);
  const token = document.createElement("span");
  token.className = `document-token token-${(part?.type || "OTHER").toLowerCase()}`;
  const textNode = document.createTextNode(value);
  token.appendChild(textNode);
  token.dataset.type = part?.type || "OTHER";
  if (replacement) {
    token.dataset.sourceStart = String(replacement.start);
    token.dataset.sourceEnd = String(replacement.end);
    sourceRangeByTextNode.set(textNode, { start: replacement.start, end: replacement.end, atomic: true });
  }
  parent.appendChild(token);
}

function renderPlainSafeDocument(element, sourceText, replacements) {
  let cursor = 0;
  [...(replacements || [])].sort((left, right) => left.start - right.start).forEach((replacement) => {
    appendMappedText(element, sourceText.slice(cursor, replacement.start), cursor, replacement.start);
    appendToken(element, replacement.token, replacement);
    cursor = replacement.end;
  });
  appendMappedText(element, sourceText.slice(cursor), cursor, sourceText.length);
}

function renderClassicDocumentPage(element, text) {
  element.classList.add("classic-document");
  parseClassicDocument(text).forEach((block) => {
    if (block.type === "table") {
      const table = document.createElement("table");
      table.className = "classic-table";
      const body = document.createElement("tbody");
      block.rows.forEach((row, rowIndex) => {
        const rowElement = document.createElement("tr");
        row.forEach((cell) => {
          const cellElement = document.createElement(rowIndex === 0 ? "th" : "td");
          cellElement.textContent = cell;
          rowElement.appendChild(cellElement);
        });
        body.appendChild(rowElement);
      });
      table.appendChild(body);
      element.appendChild(table);
      return;
    }
    const tagName = block.type === "heading" ? (block.level === 1 ? "h1" : "h2") : "p";
    const paragraph = document.createElement(tagName);
    paragraph.className = block.type === "list" ? `classic-list ${block.ordered ? "ordered" : "bullet"}` : "classic-paragraph";
    paragraph.textContent = block.text;
    element.appendChild(paragraph);
  });
}

function renderDocumentPage(element, text, options = {}) {
  element.replaceChildren();
  element.classList.remove("docx-structured", "classic-document");
  const docxModel = options.docxModel || null;
  element.classList.toggle("docx-structured", Boolean(docxModel));
  if (docxModel) {
    renderDocxDocument(element, docxModel, options);
    return;
  }
  if (options.classic) {
    renderClassicDocumentPage(element, text);
    return;
  }
  if (options.tokens && options.sourceText && options.replacements) {
    renderPlainSafeDocument(element, options.sourceText, options.replacements);
    return;
  }
  if (!options.tokens) {
    element.textContent = String(text || "");
    return;
  }
  splitTokenizedText(text).forEach((part) => {
    if (!part.token) return element.appendChild(document.createTextNode(part.text));
    appendToken(element, part.text);
  });
}

function applyRunStyle(element, style = {}) {
  if (style.bold) element.style.fontWeight = "700";
  if (style.italic) element.style.fontStyle = "italic";
  const decorations = [];
  if (style.underline) decorations.push("underline");
  if (style.strike) decorations.push("line-through");
  if (decorations.length) element.style.textDecoration = decorations.join(" ");
  if (style.sizePt) element.style.fontSize = `${Math.min(36, Math.max(8, style.sizePt))}pt`;
  if (/^[0-9a-f]{6}$/iu.test(style.color || "")) element.style.color = `#${style.color}`;
}

function appendStyledRange(parent, paragraph, start, end) {
  if (end <= start) return;
  paragraph.runs.forEach((run) => {
    const overlapStart = Math.max(start, run.start);
    const overlapEnd = Math.min(end, run.end);
    if (overlapEnd <= overlapStart) return;
    const value = run.text.slice(overlapStart - run.start, overlapEnd - run.start);
    if (!value) return;
    appendMappedText(parent, value, overlapStart, overlapEnd, run.style);
  });
}

function applyParagraphStyle(element, paragraph) {
  const style = paragraph.style || {};
  const twipsToPt = (value) => `${Math.round((Number(value) || 0) / 20 * 10) / 10}pt`;
  const alignment = { both: "justify", center: "center", right: "right", left: "left", distribute: "justify" }[style.alignment];
  if (alignment) element.style.textAlign = alignment;
  if (style.leftTwips) element.style.marginLeft = twipsToPt(style.leftTwips);
  if (style.rightTwips) element.style.marginRight = twipsToPt(style.rightTwips);
  if (style.beforeTwips) element.style.marginTop = twipsToPt(style.beforeTwips);
  if (style.afterTwips) element.style.marginBottom = twipsToPt(style.afterTwips);
  if (style.firstLineTwips || style.hangingTwips) element.style.textIndent = twipsToPt(style.firstLineTwips - style.hangingTwips);
  if (style.lineTwips) element.style.lineHeight = style.lineRule === "exact" || style.lineRule === "atLeast"
    ? twipsToPt(style.lineTwips)
    : String(Math.max(1, Math.round(style.lineTwips / 240 * 100) / 100));
  if (/heading|заголов/iu.test(style.styleId || "")) element.classList.add("docx-heading");
  if (style.numbered) element.classList.add("docx-numbered");
}

function renderDocxParagraph(paragraph, options = {}) {
  const element = document.createElement("p");
  element.className = "docx-paragraph";
  applyParagraphStyle(element, paragraph);
  if (!paragraph.text) {
    element.appendChild(document.createElement("br"));
    return element;
  }
  const replacements = (options.replacements || [])
    .filter((replacement) => replacement.start < paragraph.end && paragraph.start < replacement.end)
    .sort((left, right) => left.start - right.start);
  if (!replacements.length) {
    appendStyledRange(element, paragraph, paragraph.start, paragraph.end);
    return element;
  }
  let cursor = paragraph.start;
  replacements.forEach((replacement) => {
    const overlapStart = Math.max(paragraph.start, replacement.start);
    const overlapEnd = Math.min(paragraph.end, replacement.end);
    appendStyledRange(element, paragraph, cursor, overlapStart);
    if (replacement.start >= paragraph.start && replacement.start < paragraph.end) {
      if (options.tokens) appendToken(element, replacement.token, replacement);
      else appendMappedText(element, replacement.replacement || replacement.token, replacement.start, replacement.end);
    }
    cursor = Math.max(cursor, overlapEnd);
  });
  appendStyledRange(element, paragraph, cursor, paragraph.end);
  if (!element.childNodes.length) element.appendChild(document.createElement("br"));
  return element;
}

function renderDocxDocument(element, model, options = {}) {
  const main = model.parts.find((part) => part.name === "word/document.xml");
  const renderBlocks = (container, blocks) => {
    blocks.forEach((block) => {
      if (block.type === "paragraph") {
        container.appendChild(renderDocxParagraph(block.paragraph, options));
        return;
      }
      const table = document.createElement("table");
      table.className = "docx-table";
      if (!block.style?.bordered) table.classList.add("docx-table-borderless");
      if (block.style?.widthTwips) {
        table.style.width = `${Math.round(block.style.widthTwips / 20 * 10) / 10}pt`;
        table.style.maxWidth = "100%";
      } else if (block.style?.widthPercent) {
        table.style.width = `${Math.min(100, block.style.widthPercent)}%`;
      }
      if (block.style?.alignment === "center") table.style.marginInline = "auto";
      if (block.style?.grid?.length) {
        const total = block.style.grid.reduce((sum, width) => sum + width, 0);
        const columnGroup = document.createElement("colgroup");
        block.style.grid.forEach((width) => {
          const column = document.createElement("col");
          column.style.width = `${Math.round(width / total * 10000) / 100}%`;
          columnGroup.appendChild(column);
        });
        table.appendChild(columnGroup);
      }
      const body = document.createElement("tbody");
      block.rows.forEach((row) => {
        const rowElement = document.createElement("tr");
        row.cells.forEach((cell) => {
          if (cell.hidden) return;
          const cellElement = document.createElement("td");
          if (cell.colSpan > 1) cellElement.colSpan = cell.colSpan;
          if (cell.rowSpan > 1) cellElement.rowSpan = cell.rowSpan;
          if (cell.widthTwips) cellElement.style.width = `${Math.round(cell.widthTwips / 20 * 10) / 10}pt`;
          cellElement.style.verticalAlign = cell.verticalAlign === "center" ? "middle" : cell.verticalAlign;
          cell.paragraphs.forEach((paragraph) => cellElement.appendChild(renderDocxParagraph(paragraph, options)));
          if (!cellElement.childNodes.length) cellElement.appendChild(document.createElement("br"));
          rowElement.appendChild(cellElement);
        });
        body.appendChild(rowElement);
      });
      table.appendChild(body);
      container.appendChild(table);
    });
  };

  const headers = model.parts.filter((part) => /\/header\d+\.xml$/iu.test(part.name));
  if (headers.length) {
    const header = document.createElement("div");
    header.className = "docx-header";
    headers.forEach((part) => renderBlocks(header, part.blocks));
    element.appendChild(header);
  }
  renderBlocks(element, main?.blocks || []);
  const footers = model.parts.filter((part) => /\/footer\d+\.xml$/iu.test(part.name));
  if (footers.length) {
    const footer = document.createElement("div");
    footer.className = "docx-footer";
    footers.forEach((part) => renderBlocks(footer, part.blocks));
    element.appendChild(footer);
  }
  const notes = model.parts.filter((part) => /\/(?:footnotes|endnotes|comments)\.xml$/iu.test(part.name));
  if (notes.some((part) => part.paragraphs.some((paragraph) => paragraph.text.trim()))) {
    const details = document.createElement("details");
    details.className = "docx-notes";
    const summary = document.createElement("summary");
    summary.textContent = "Сноски и примечания";
    details.appendChild(summary);
    notes.forEach((part) => renderBlocks(details, part.blocks));
    element.appendChild(details);
  }
}
function renderAliasDetails(group) {
  if (group.aliases.length < 2) return null;
  const note = document.createElement("div");
  note.className = "alias-details";
  note.textContent = `Вариантов написания: ${group.aliases.length}`;
  note.title = group.aliases.map((alias) => `${alias.value} — ${alias.count}`).join("\n");
  return note;
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
    const aliasDetails = renderAliasDetails(group);
    originalCell.appendChild(editor);
    if (aliasDetails) originalCell.appendChild(aliasDetails);

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
    actionSelect.innerHTML = '<option value="MASK">Скрыть</option><option value="KEEP">Не скрывать</option>';
    actionSelect.value = group.action === "KEEP" ? "KEEP" : "MASK";
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
  $("resultEyebrow").textContent = "Готово";
  $("resultTitle").textContent = "Безопасная копия создана";
  actions.classList.toggle("hidden", state.integrity.ok);
  override.classList.toggle("hidden", state.integrity.ok);

  if (!state.integrity.ok) {
    $("resultEyebrow").textContent = "Нужна проверка";
    $("resultTitle").textContent = "Проверьте безопасную копию";
    notice.className = "notice error";
    notice.textContent = "При проверке результата обнаружено отличие. Пересчитайте документ или откройте расширенные настройки.";
    $("integrityDetails").textContent = `Первое отличие: позиция ${state.integrity.firstDifference}\n\nОжидалось:\n${state.integrity.expectedSnippet}\n\nПолучено:\n${state.integrity.actualSnippet}`;
  } else if (state.residual.critical > 0) {
    $("resultEyebrow").textContent = "Нужна проверка";
    $("resultTitle").textContent = "Проверьте безопасную копию";
    notice.className = "notice";
    notice.textContent = `В защищённой копии могут остаться чувствительные данные: ${state.residual.critical}. Откройте расширенные настройки и проверьте результат.`;
  } else if (state.docxModel?.mediaCount > 0) {
    $("resultEyebrow").textContent = "Проверьте изображения";
    $("resultTitle").textContent = "Текст Word защищён";
    notice.className = "notice";
    notice.textContent = `В Word сохранены изображения: ${state.docxModel.mediaCount}. Текст внутри изображений пока не распознаётся — проверьте их перед использованием файла.`;
  } else {
    const status = resultSafetyStatus(state.text.length, state.result.replacements.length);
    notice.className = status.level === "warning" ? "notice zero-warning" : "notice success";
    notice.textContent = status.message;
    $("resultEyebrow").textContent = status.title;
    $("resultTitle").textContent = status.level === "warning" ? "Проверьте безопасную копию" : "Безопасная копия создана";
  }
}

function renderResult(renderRows = true) {
  closeOccurrenceNavigator();
  const categories = new Set(state.registry.map((group) => group.type));
  const review = state.registry.filter((group) => group.action === "REVIEW");
  const methods = ["обработано автоматически"];
  if (state.ocrPages.length) methods.push(`OCR: ${state.ocrPages.length} стр.`);
  if (state.qwenUsed) methods.push(`Qwen: ${state.qwenModel || "дополнительная проверка"}`);
  $("resultFileName").textContent = `${state.source?.name || "Материал"} · ${methods.join(" · ")}`;
  $("foundCount").textContent = state.result.replacements.length;
  $("entityCount").textContent = state.registry.length;
  $("reviewCount").textContent = review.length;
  $("categoryCount").textContent = categories.size;
  $("sourceLength").textContent = `${state.text.length.toLocaleString("ru-RU")} знаков`;
  $("safeLength").textContent = `${state.result.text.length.toLocaleString("ru-RU")} знаков`;
  renderDetectionContributions();
  renderQwenCharacterMetric();
  renderDocumentPage($("sourcePreview"), state.text, { docxModel: state.docxModel });
  renderDocumentPage($("safePreview"), state.result.text, {
    tokens: true,
    docxModel: state.docxModel,
    sourceText: state.text,
    replacements: state.result.replacements
  });
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
  $("downloadWordButton").disabled = !enabled;
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
  state.draftName = "";
  state.selectedGroups.clear();
  state.manualSelection = null;
  state.lastManualChange = null;
  state.suppressNextPersistentAutoSave = false;
  state.ocrPages = [];
  state.qwenUsed = false;
  state.qwenModel = null;
  state.qwenStatus = "idle";
  state.qwenDiagnostics = null;
  state.qwenTrace = null;
  state.sourceBinary = null;
  state.docxModel = null;
  state.restoreResult = null;
  state.restoreSourceName = "";
  state.restoreSourceFormat = "text";
  $("fileInput").value = "";
  $("pasteInput").value = "";
  updatePasteCounter();
  $("manualValue").value = "";
  $("draftNameInput").value = "";
  $("restoreInput").value = "";
  $("restoreCharCount").textContent = "0 знаков";
  $("restoreSourceStatus").textContent = "Файл не выбран";
  clearRestoreResult();
  $("warningOverrideCheckbox").checked = false;
  closeOccurrenceNavigator();
  setSelectionBanner("Если что-то пропущено, выделите фрагмент в безопасной копии: тип определится, а текст сразу заменится токеном.");
  sessionStorage.removeItem(SESSION_KEY);
  refreshSavedSessions();
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
  const result = appendUniqueEntities(state.entities, additions);
  state.entities = result.entities;
  return result.added;
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

function mappedBoundaryOffset(container, offset, endBoundary = false) {
  if (container?.nodeType === Node.TEXT_NODE) {
    const mapped = sourceRangeByTextNode.get(container);
    if (!mapped) return null;
    if (mapped.atomic) return endBoundary ? mapped.end : mapped.start;
    return Math.min(mapped.end, mapped.start + Math.max(0, offset));
  }
  if (container?.nodeType !== Node.ELEMENT_NODE) return null;
  const children = Array.from(container.childNodes || []);
  const candidate = endBoundary
    ? children[Math.max(0, Math.min(children.length - 1, offset - 1))]
    : children[Math.min(children.length - 1, Math.max(0, offset))];
  if (!candidate) return null;
  const walker = document.createTreeWalker(candidate, NodeFilter.SHOW_TEXT);
  const mappedNodes = [];
  let node = walker.nextNode();
  while (node) {
    if (sourceRangeByTextNode.has(node)) mappedNodes.push(node);
    node = walker.nextNode();
  }
  const mapped = sourceRangeByTextNode.get(endBoundary ? mappedNodes.at(-1) : mappedNodes[0]);
  return mapped ? (endBoundary ? mapped.end : mapped.start) : null;
}

function setSelectionBanner(message, canUndo = false) {
  $("selectionBannerText").textContent = message;
  $("undoSelectionButton").classList.toggle("hidden", !canUndo);
}

function uncoveredSelectionText(start, end, replacements) {
  let cursor = start;
  let output = "";
  [...replacements].sort((left, right) => left.start - right.start).forEach((replacement) => {
    output += state.text.slice(cursor, Math.max(cursor, replacement.start));
    cursor = Math.max(cursor, replacement.end);
  });
  return output + state.text.slice(cursor, end);
}

function undoLastManualChange() {
  const snapshot = state.lastManualChange;
  if (!snapshot) return;
  state.entities = snapshot.entities;
  state.tokenAssignments = snapshot.tokenAssignments;
  state.canonicalOverrides = snapshot.canonicalOverrides;
  state.lastManualChange = null;
  recalculate();
  renderResult();
  setSelectionBanner("Последнее ручное выделение отменено.");
  showToast("Последняя ручная замена отменена.");
}

function captureSelection(container, source) {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || !selection.rangeCount) return;
  const range = selection.getRangeAt(0);
  if (!container.contains(range.commonAncestorContainer)) return;
  let start = mappedBoundaryOffset(range.startContainer, range.startOffset, false);
  let end = mappedBoundaryOffset(range.endContainer, range.endOffset, true);
  if (!Number.isInteger(start) || !Number.isInteger(end) || end <= start) {
    return showToast("Не удалось определить границы выделения. Выделите фрагмент ещё раз.");
  }
  let value = state.text.slice(start, end);
  const leading = value.match(/^\s+/u)?.[0].length || 0;
  const trailing = value.match(/\s+$/u)?.[0].length || 0;
  start += leading;
  end -= trailing;
  value = state.text.slice(start, end);
  if (!value) return;
  if (value.length > MAX_MANUAL_SELECTION) return showToast("Можно скрыть не более 20 000 знаков за одно выделение.");
  const overlappingReplacements = (state.result?.replacements || [])
    .filter((replacement) => replacement.start < end && start < replacement.end);
  if (overlappingReplacements.length && !uncoveredSelectionText(start, end, overlappingReplacements).trim()) {
    selection.removeAllRanges();
    setSelectionBanner("Этот фрагмент уже скрыт. Выделите текст рядом или другой фрагмент.");
    return showToast("Этот фрагмент уже скрыт.");
  }
  const type = overlappingReplacements.length || value.length > 250 || value.includes("\n")
    ? "FRAGMENT"
    : (inferEntityType(value) || "OTHER");
  $("manualValue").value = value;
  $("manualType").value = type;
  $("manualScope").value = "one";
  state.lastManualChange = {
    entities: structuredClone(state.entities),
    tokenAssignments: { ...state.tokenAssignments },
    canonicalOverrides: { ...state.canonicalOverrides }
  };
  if (overlappingReplacements.length) {
    state.entities = state.entities.filter((entity) => !(entity.start < end && start < entity.end));
  }
  state.manualSelection = { source: "source", start, end, value };
  const additions = selectedManualEntity(value, type);
  const added = appendNewEntities(additions);
  if (!added) {
    state.entities = state.lastManualChange.entities;
    state.tokenAssignments = state.lastManualChange.tokenAssignments;
    state.canonicalOverrides = state.lastManualChange.canonicalOverrides;
    state.manualSelection = null;
    state.lastManualChange = null;
    return showToast("Этот фрагмент уже скрыт.");
  }
  state.manualSelection = null;
  recalculate();
  renderResult();
  const summary = value.length > 160 ? `${value.slice(0, 157)}…` : value;
  selection.removeAllRanges();
  const mergedNote = overlappingReplacements.length ? ` Внутри было уже скрыто замен: ${overlappingReplacements.length}; они объединены в один фрагмент.` : "";
  setSelectionBanner(`Скрыто: «${summary}». Тип: «${ENTITY_TYPES[type].label}».${mergedNote}`, true);
  showToast(overlappingReplacements.length ? "Выделение с готовыми токенами объединено в один фрагмент." : `Фрагмент скрыт: ${ENTITY_TYPES[type].label}.`);
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

function outputBaseName() {
  return safeBaseName($("draftNameInput")?.value.trim() || state.draftName || state.source?.name);
}

function safeDocxBytes() {
  if (!state.result) throw new Error("RESULT_UNAVAILABLE");
  if (!state.docxModel) return createClassicDocx(state.result.text, window.fflate).bytes;
  const created = createAnonymizedDocx(state.docxModel, state.result.replacements || [], window.fflate);
  if (created.skipped.length) throw new Error("DOCX_REPLACEMENT_SKIPPED");
  return created.bytes;
}

function downloadWord() {
  try {
    const bytes = safeDocxBytes();
    downloadBlob(`${outputBaseName()}_обезличено.docx`, new Blob([bytes], {
      type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    }));
    showToast(state.docxModel ? "Word с сохранённой структурой документа скачан." : "Безопасный текст оформлен как новый Word.");
  } catch (error) {
    console.error("DOCX export failed:", error?.message);
    showToast(error?.message === "DOCX_REPLACEMENT_SKIPPED"
      ? "Word не скачан: не все замены удалось безопасно перенести в структуру документа."
      : "Не удалось подготовить Word. Безопасный текст остаётся доступен отдельно.");
  }
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
    option.textContent = `Из черновика: ${snapshot.draftName || snapshot.source?.name || snapshot.sessionId}`;
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

function clearRestoreResult() {
  state.restoreResult = null;
  $("restoreNotice").classList.add("hidden");
  $("restoreMetrics").classList.add("hidden");
  $("restorePreviewGrid").classList.add("hidden");
  $("restoreActions").classList.add("hidden");
  $("restoreAfterPreview").replaceChildren();
}

function setRestoreInput(text, options = {}) {
  const value = String(text || "");
  $("restoreInput").value = value;
  $("restoreCharCount").textContent = `${value.length.toLocaleString("ru-RU")} знаков`;
  state.restoreSourceName = options.name || "";
  state.restoreSourceFormat = options.format || "text";
  $("restoreSourceStatus").textContent = options.name || "Вставленный текст";
  clearRestoreResult();
}

async function loadRestoreSource(file) {
  try {
    validateFile(file);
    const extension = file.name.split(".").pop()?.toLowerCase();
    if (extension === "docx") {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const docxModel = parseDocxPackage(bytes, window.fflate);
      setRestoreInput(docxModel.text, { name: file.name, format: "docx" });
    } else {
      const text = await extractText(file);
      setRestoreInput(text, { name: file.name, format: extension || "text" });
    }
    showToast("Документ для восстановления загружен.");
  } catch (error) {
    showToast(errorMessage(error));
  }
}

function seedRestoreFromCurrent() {
  if (!state.result || $("restoreInput").value.trim()) return;
  setRestoreInput(state.result.text, { name: `${outputBaseName()}_обезличено.txt`, format: "text" });
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
  renderDocumentPage($("restoreAfterPreview"), result.restored, { classic: true });
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
    notice.textContent = "Данные восстановлены. Будет создан новый Word в классическом офисном оформлении.";
  }
}

function restoredOutputBaseName() {
  const map = selectedRestoreMap();
  return safeBaseName(state.restoreSourceName || map?.source?.name || "восстановленный_документ");
}

function downloadRestoredWord() {
  if (!state.restoreResult?.restored) return showToast("Сначала восстановите данные.");
  try {
    const bytes = createClassicDocx(state.restoreResult.restored, window.fflate).bytes;
    downloadBlob(`${restoredOutputBaseName()}_восстановлено.docx`, new Blob([bytes], {
      type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    }));
    showToast("Восстановленный Word скачан.");
  } catch (error) {
    console.error("Restored DOCX export failed:", error?.message);
    showToast("Не удалось подготовить восстановленный Word. Текст остаётся доступен отдельно.");
  }
}

function downloadBundle() {
  if (!window.fflate?.zipSync || !window.fflate?.strToU8) return showToast("Модуль упаковки ZIP не загружен.");
  if (!window.confirm("ZIP содержит ключ восстановления с исходными данными. Скачать его и хранить в защищённом месте?")) return;
  const base = outputBaseName();
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
  const files = {
    [`${base}_безопасный.txt`]: window.fflate.strToU8(state.result.text),
    [`${base}_ключ_восстановления.json`]: window.fflate.strToU8(JSON.stringify(state.result.map, null, 2)),
    "информация_о_черновике.json": window.fflate.strToU8(JSON.stringify(manifest, null, 2))
  };
  try {
    files[`${base}_обезличено.docx`] = safeDocxBytes();
  } catch (error) {
    console.error("DOCX bundle export failed:", error?.message);
    return showToast("ZIP не создан: Word не прошёл проверку безопасной замены.");
  }
  const archive = window.fflate.zipSync(files, { level: 6 });
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

  const bindRestoreDropzone = (element, handler) => {
    ["dragenter", "dragover"].forEach((name) => element.addEventListener(name, (event) => {
      event.preventDefault();
      event.stopPropagation();
      element.classList.add("dragging");
    }));
    ["dragleave", "drop"].forEach((name) => element.addEventListener(name, (event) => {
      event.preventDefault();
      event.stopPropagation();
      element.classList.remove("dragging");
    }));
    element.addEventListener("drop", (event) => handler(event.dataTransfer?.files?.[0]));
  };
  bindRestoreDropzone($("restoreSourceDropzone"), loadRestoreSource);
  bindRestoreDropzone($("restoreMapDropzone"), loadRestoreMap);
}

function bindActions() {
  $("anonymizeModeButton").addEventListener("click", () => setMode("anonymize"));
  $("restoreModeButton").addEventListener("click", () => setMode("restore"));
  $("openRestoreButton").addEventListener("click", () => setMode("restore"));
  $("backToAnonymizeButton").addEventListener("click", () => setMode("anonymize"));
  $("fileTabButton").addEventListener("click", () => setInputTab("file"));
  $("textTabButton").addEventListener("click", () => setInputTab("text"));
  $("pasteInput").addEventListener("input", () => {
    updatePasteCounter();
  });
  $("processTextButton").addEventListener("click", () => {
    const text = $("pasteInput").value;
    processSource(text, { name: "Вставленный текст.txt", size: new Blob([text]).size, kind: "text", mime: "text/plain" });
  });
  $("newDocumentButton").addEventListener("click", resetApplication);
  $("detectionDetailsButton").addEventListener("click", () => {
    setDetectionDetailsExpanded($("detectionDetailsButton").getAttribute("aria-expanded") !== "true");
  });
  $("addManualButton").addEventListener("click", addManualValue);
  $("findSimilarButton").addEventListener("click", findSimilarValues);
  $("undoSelectionButton").addEventListener("click", undoLastManualChange);
  $("occurrencePreviousButton").addEventListener("click", () => {
    const group = currentOccurrenceGroup();
    if (group && occurrenceNavigation) focusOccurrence(group, occurrenceNavigation.index - 1);
  });
  $("occurrenceNextButton").addEventListener("click", () => {
    const group = currentOccurrenceGroup();
    if (group && occurrenceNavigation) focusOccurrence(group, occurrenceNavigation.index + 1);
  });
  $("occurrenceCloseButton").addEventListener("click", closeOccurrenceNavigator);
  $("manualValue").addEventListener("keydown", (event) => {
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      addManualValue();
    }
  });
  $("mergeEntitiesButton").addEventListener("click", mergeSelectedEntities);
  $("toggleOriginalsButton").addEventListener("click", () => {
    state.hideOriginals = !state.hideOriginals;
    renderResult(false);
  });
  $("safePreview").addEventListener("mouseup", () => captureSelection($("safePreview"), "safe"));
  $("warningOverrideCheckbox").addEventListener("change", updateDownloadState);
  $("recalculateButton").addEventListener("click", () => {
    recalculate();
    renderResult();
    showToast("Результат пересчитан из исходного текста и текущей карты.");
  });
  $("downloadTextButton").addEventListener("click", () => {
    downloadFile(`${outputBaseName()}_обезличено.txt`, state.result.text);
    showToast("Безопасный текст скачан.");
  });
  $("downloadWordButton").addEventListener("click", downloadWord);
  $("copyTextButton").addEventListener("click", () => copyText(state.result.text, "Безопасный текст скопирован."));
  $("downloadMapButton").addEventListener("click", () => {
    if (!window.confirm("Ключ восстановления содержит исходные данные. Скачать его отдельно от защищённого документа?")) return;
    downloadFile(`${outputBaseName()}_ключ_восстановления.json`, JSON.stringify(state.result.map, null, 2), "application/json;charset=utf-8");
    showToast("Ключ восстановления скачан.");
  });
  $("downloadBundleButton").addEventListener("click", downloadBundle);
  $("saveSessionButton").addEventListener("click", savePersistentSession);
  $("deleteCurrentSessionButton").addEventListener("click", deletePersistentSession);
  $("draftNameInput").addEventListener("input", () => {
    state.draftName = $("draftNameInput").value.trim().slice(0, 80);
    autoSaveSession();
  });

  $("restoreInput").addEventListener("input", () => {
    $("restoreCharCount").textContent = `${$("restoreInput").value.length.toLocaleString("ru-RU")} знаков`;
    if (!state.restoreSourceName) $("restoreSourceStatus").textContent = "Вставленный текст";
    clearRestoreResult();
  });
  $("restoreFileInput").addEventListener("change", (event) => loadRestoreSource(event.target.files?.[0]));
  $("restoreMapFileInput").addEventListener("change", (event) => loadRestoreMap(event.target.files?.[0]));
  $("restoreMapSelect").addEventListener("change", updateRestoreMapStatus);
  $("restoreRunButton").addEventListener("click", runRestoration);
  $("downloadRestoredWordButton").addEventListener("click", downloadRestoredWord);
  $("downloadRestoredButton").addEventListener("click", () => {
    downloadFile(`${restoredOutputBaseName()}_восстановлено.txt`, state.restoreResult?.restored || "");
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

async function loadCurrentSession() {
  try {
    const snapshot = JSON.parse(sessionStorage.getItem(SESSION_KEY) || "null");
    if ([2, 3].includes(snapshot?.schema) && snapshot.text && Array.isArray(snapshot.entities)) await restoreSnapshot(snapshot);
  } catch {
    sessionStorage.removeItem(SESSION_KEY);
  }
}

renderEntityTypes();
ensureQwenStatus();
updatePasteCounter();
bindUpload();
bindActions();
bindNavigation();
initializeDraftStorage();
setInputTab("file");
setView("input");
loadCurrentSession();
