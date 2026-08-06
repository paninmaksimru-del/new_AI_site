import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const root = new URL("../public/", import.meta.url);

test("безопасная копия — read-only документ и скрыта в расширенных настройках рядом с таблицей сущностей", async () => {
  const html = await readFile(new URL("anonymizer.html", root), "utf8");
  assert.match(html, /id="safePreview" role="document"/);
  assert.doesNotMatch(html, /textarea[^>]+id="safePreview"/);
  assert.match(html, /<details class="advanced-panel">[\s\S]*id="sourcePreview"/);
  assert.match(html, /<details class="advanced-panel">[\s\S]*class="source-details safe-preview-details"[\s\S]*id="safePreview"/);
});

test("цветные токены и чёрный восстановленный текст заданы стилями", async () => {
  const css = await readFile(new URL("anonymizer.css", root), "utf8");
  assert.match(css, /\.token-person\s*\{/);
  assert.match(css, /\.token-phone, \.token-email\s*\{/);
  assert.match(css, /\.preview-text\.restored\s*\{\s*color:\s*#111827/);
});

test("показ в документе использует плавающую навигацию, прокрутку и временную подсветку", async () => {
  const [html, script, css] = await Promise.all([
    readFile(new URL("anonymizer.html", root), "utf8"),
    readFile(new URL("anonymizer.js", root), "utf8"),
    readFile(new URL("anonymizer.css", root), "utf8")
  ]);
  assert.match(html, /id="occurrenceNavigator"/);
  assert.match(html, /id="occurrencePreviousButton"/);
  assert.match(html, /id="occurrenceNextButton"/);
  assert.match(script, /target\.scrollIntoView\(\{ behavior: "smooth", block: "center" \}\)/);
  assert.match(script, /target\.classList\.add\("token-flash"\)/);
  assert.match(script, /occurrenceNavigation = \{ groupId: activeGroup\.id, index, total: targets\.length \}/);
  assert.match(script, /focusOccurrence\(group, occurrenceNavigation\.index \+ 1\)/);
  assert.match(css, /\.occurrence-navigator\s*\{[^}]*position:\s*absolute/);
  assert.doesNotMatch(script, /insertBefore\([^\n]*occurrence/);
});

test("большие выделения, именованные черновики и одиночный результат восстановления доступны в интерфейсе", async () => {
  const [html, script] = await Promise.all([
    readFile(new URL("anonymizer.html", root), "utf8"),
    readFile(new URL("anonymizer.js", root), "utf8")
  ]);
  assert.match(html, /id="draftNameInput"/);
  assert.match(html, /id="savedDraftList"/);
  assert.match(html, /textarea id="manualValue"/);
  assert.doesNotMatch(html, /id="restoreBeforePreview"/);
  assert.equal((html.match(/id="restoreAfterPreview"/g) || []).length, 1);
  assert.match(script, /MAX_MANUAL_SELECTION = 20_000/);
  assert.match(script, /snapshot\.draftName/);
  assert.match(script, /Из черновика: \$\{snapshot\.draftName \|\| snapshot\.source\?\.name/);
});

test("черновики открываются, переименовываются и удаляются по одному с автосохранением", async () => {
  const [html, script] = await Promise.all([
    readFile(new URL("anonymizer.html", root), "utf8"),
    readFile(new URL("anonymizer.js", root), "utf8")
  ]);
  assert.match(script, /async function openDraftById\(id\)/);
  assert.match(script, /async function renameDraftById\(id\)/);
  assert.match(script, /async function deleteDraftById\(id\)/);
  assert.match(script, /persistCurrentDraft\(true\)/);
  assert.match(script, /suppressNextPersistentAutoSave/);
  assert.match(script, /sessionStorage\.removeItem\(SESSION_KEY\);\s*refreshSavedSessions\(\)/);
  assert.match(script, /Последние изменения сохраняются автоматически/);
  assert.doesNotMatch(html, /Удалить все сохранённые черновики/);
  assert.doesNotMatch(html, /id="clearSavedSessionsButton"/);
});

test("исходный DOCX хранится в IndexedDB, а Word доступен для любого входного формата", async () => {
  const [html, script, docx, storage, css] = await Promise.all([
    readFile(new URL("anonymizer.html", root), "utf8"),
    readFile(new URL("anonymizer.js", root), "utf8"),
    readFile(new URL("anonymizer-docx.js", root), "utf8"),
    readFile(new URL("anonymizer-storage.js", root), "utf8"),
    readFile(new URL("anonymizer.css", root), "utf8")
  ]);
  assert.match(html, /id="downloadWordButton"[^>]*>Скачать Word \(\.docx\)/);
  assert.match(script, /createAnonymizedDocx\(state\.docxModel/);
  assert.match(script, /if \(!state\.docxModel\) return createClassicDocx\(state\.result\.text/);
  assert.match(script, /files\[`\$\{base\}_обезличено\.docx`\] = safeDocxBytes\(\)/);
  assert.match(script, /new Blob\(\[state\.sourceBinary\]/);
  assert.match(docx, /word\/document\.xml/);
  assert.match(docx, /header\\d\+/);
  assert.match(docx, /footer\\d\+/);
  assert.match(docx, /scrubWordMetadata/);
  assert.match(docx, /docProps\/core\.xml/);
  assert.match(storage, /indexedDB\.open/);
  assert.match(storage, /sourceBlob/);
  assert.match(css, /\.docx-table\s*\{/);
});

test("Word-предпросмотр не показывает коды полей и не разбивает списки на flex-колонки", async () => {
  const [docx, css] = await Promise.all([
    readFile(new URL("anonymizer-docx.js", root), "utf8"),
    readFile(new URL("anonymizer.css", root), "utf8")
  ]);
  assert.match(docx, /return \["t", "delText", "tab", "br", "cr"\]/);
  assert.match(docx, /readTableStyle/);
  assert.match(docx, /rowSpan/);
  assert.doesNotMatch(css, /\.docx-numbered\s*\{[^}]*display:\s*flex/);
  assert.match(css, /\.docx-table\.docx-table-borderless/);
});

test("выделение связано с координатами исходника и не ищется точной строкой", async () => {
  const script = await readFile(new URL("anonymizer.js", root), "utf8");
  assert.match(script, /sourceRangeByTextNode/);
  assert.match(script, /mappedBoundaryOffset/);
  assert.match(script, /state\.text\.slice\(start, end\)/);
  assert.match(script, /selectedManualEntity\(value, type\)/);
  assert.doesNotMatch(script, /state\.text\.includes\(value\).*Выделенный фрагмент не найден/);
});

test("выделение с готовыми токенами объединяется в один фрагмент и может быть отменено", async () => {
  const [html, script] = await Promise.all([
    readFile(new URL("anonymizer.html", root), "utf8"),
    readFile(new URL("anonymizer.js", root), "utf8")
  ]);
  assert.match(html, /id="undoSelectionButton"/);
  assert.match(html, /class="source-details safe-preview-details"[\s\S]*id="selectionBanner"/);
  assert.match(script, /atomic:\s*true/);
  assert.match(script, /overlappingReplacements/);
  assert.match(script, /uncoveredSelectionText\(start, end, overlappingReplacements\)/);
  assert.match(script, /\? "FRAGMENT"/);
  assert.match(script, /state\.lastManualChange = \{/);
  assert.match(script, /function undoLastManualChange\(\)/);
  assert.match(script, /Этот фрагмент уже скрыт/);
});

test("восстановление поддерживает перетаскивание и всегда создаёт новый классический Word", async () => {
  const [html, script, css] = await Promise.all([
    readFile(new URL("anonymizer.html", root), "utf8"),
    readFile(new URL("anonymizer.js", root), "utf8"),
    readFile(new URL("anonymizer.css", root), "utf8")
  ]);
  assert.match(html, /id="restoreSourceDropzone"/);
  assert.match(html, /id="restoreMapDropzone"/);
  assert.doesNotMatch(html, /id="restoreOriginalMode"/);
  assert.doesNotMatch(html, /id="restoreClassicMode"/);
  assert.match(html, /Восстановленный текст будет оформлен в Times New Roman 14/);
  assert.match(html, /id="downloadRestoredWordButton"/);
  assert.match(script, /createClassicDocx\(state\.restoreResult\.restored/);
  assert.doesNotMatch(script, /createRestoredDocx/);
  assert.doesNotMatch(script, /restoreDocxModel/);
  assert.match(script, /bindRestoreDropzone/);
  assert.match(css, /Times New Roman/);
});

test("смысловая проверка использует серверный Qwen Chat и сохраняет локальный fallback", async () => {
  const [html, script] = await Promise.all([
    readFile(new URL("anonymizer.html", root), "utf8"),
    readFile(new URL("anonymizer.js", root), "utf8")
  ]);
  assert.match(script, /fetch\("\/api\/anonymizer\/qwen\/status"/);
  assert.match(script, /fetch\("\/api\/anonymizer\/qwen\/entities"/);
  assert.match(script, /"x-auth-token": authToken/);
  assert.match(script, /confirmed: true/);
  assert.match(script, /document: \{/);
  assert.match(script, /const qwenAnalysisEntities = await requestQwenEntities\([\s\S]*preparedAnalysis\.analysisText/);
  assert.match(script, /mapAnalysisEntitiesToWorkingText\(qwenAnalysisEntities, preparedAnalysis\)/);
  assert.match(script, /state\.qwenTrace = error\?\.trace \|\| null/);
  assert.match(script, /mergeEntityCandidates\(ruleEntities, qwenEntities\)/);
  assert.match(script, /Дополнительная проверка временно недоступна\. Документ обработан основным способом\./);
  assert.match(script, /Qwen: \$\{state\.qwenModel/);
  assert.match(html, /Сервис сам прочитает документ, найдёт чувствительные данные и создаст защищённую копию/);
});

test("лимит ИИ показан счётчиком для текста, файлов и готового результата", async () => {
  const [html, script, css] = await Promise.all([
    readFile(new URL("anonymizer.html", root), "utf8"),
    readFile(new URL("anonymizer.js", root), "utf8"),
    readFile(new URL("anonymizer.css", root), "utf8")
  ]);
  assert.match(html, /id="pasteCharCount"[^>]*>0 \/ 60 000 знаков лимит для ИИ/);
  assert.match(html, /id="qwenCharacterCount">0 \/ 60 000/);
  assert.match(html, /id="qwenCharacterStatus"/);
  assert.match(html, /id="qwenDiagnosticsDetails"/);
  assert.match(script, /maxTextLength: Number\(payload\.maxTextLength\)/);
  assert.match(script, /preparedAnalysis\.analysisText\.length > qwenTextLimit\(\)/);
  assert.match(script, /Qwen пропущен: \$\{qwenCounterText\(preparedAnalysis\.analysisText\.length\)\}/);
  assert.match(script, /Лимит Qwen — \$\{qwenTextLimit\(\)\.toLocaleString/);
  assert.match(script, /Qwen: вернул \$\{diagnostics\.returned\}, исправлено \$\{diagnostics\.repaired \|\| 0\}, добавлено/);
  assert.match(script, /до ИИ вырезано опасных инструкций/);
  assert.match(script, /qwenDiagnostics: state\.qwenDiagnostics/);
  assert.match(script, /qwenTrace: state\.qwenTrace/);
  assert.match(script, /processingFileMeta[^\n]+qwenCounterText\(preparedAnalysis\.analysisText\.length\)/);
  assert.match(css, /\.char-counter\.over-limit/);
  assert.match(css, /\.metric\.qwen-metric b/);
  assert.match(css, /\.metric \.qwen-diagnostics/);
});

test("результат отдельно показывает находки системы и дополнения диагностики с ИИ", async () => {
  const [html, script, css] = await Promise.all([
    readFile(new URL("anonymizer.html", root), "utf8"),
    readFile(new URL("anonymizer.js", root), "utf8"),
    readFile(new URL("anonymizer.css", root), "utf8")
  ]);

  assert.match(html, /id="systemDetectedCount"/);
  assert.match(html, /id="aiAddedCount"/);
  assert.match(html, /id="detectionDetailsButton"[^>]+aria-controls="detectionDetailsPanel"/);
  assert.match(html, /id="systemDetectedItems"/);
  assert.match(html, /id="aiAddedItems"/);
  assert.match(script, /splitDetectionContributions\(state\.entities\)/);
  assert.match(script, /function renderDetectionEntityList/);
  assert.match(script, /setDetectionDetailsExpanded/);
  assert.match(css, /\.detection-contribution-grid/);
  assert.match(css, /\.detection-entity-list/);
});
