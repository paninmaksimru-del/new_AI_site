const $ = (selector) => document.querySelector(selector);
const taskLabels = { default: "Обычное резюме", abstractive: "Абстрактивное", extractive: "Экстрактивное" };
const activeStatuses = new Set(["created", "processing", "pending"]);
let currentTranscription = null;
let pollTimer = null;
let progressTimer = null;

for (const select of document.querySelectorAll(".task-type")) {
  for (const [value, label] of Object.entries(taskLabels)) {
    const option = document.createElement("option"); option.value = value; option.textContent = label; select.appendChild(option);
  }
}

async function api(url, options = {}) {
  const token = localStorage.getItem("auth_token");
  const response = await fetch(url, { headers: { Accept: "application/json", ...(token ? { "X-Auth-Token": token } : {}), ...(options.headers || {}) }, ...options });
  const type = response.headers.get("content-type") || "";
  const body = type.includes("json") ? await response.json() : null;
  if (response.status === 401) {
    window.location.replace("/login");
    throw new Error("Требуется авторизация");
  }
  if (!response.ok) {
    const error = new Error(body?.error?.message || body?.message || body?.detail || "Запрос не выполнен");
    error.status = response.status; error.code = body?.error?.code || body?.error; error.details = body?.details || {}; throw error;
  }
  return body;
}

function setBusy(button, busy, normal) { button.disabled = busy; button.toggleAttribute("aria-busy", busy); button.textContent = busy ? "Обработка…" : normal; }
function statusLabel(value) { return ({created:"Создано",processing:"В работе",pending:"Ожидает",completed:"Готово",failed:"Ошибка",timeout:"Таймаут"})[value] || value; }
function bytes(value) { return value < 1048576 ? `${(value/1024).toFixed(1)} КБ` : `${(value/1048576).toFixed(1)} МБ`; }
function time(value) { if (value == null) return "--:--"; const n=Math.max(0,Math.floor(Number(value))); return `${Math.floor(n/60)}:${String(n%60).padStart(2,"0")}`; }

function renderTranscription(item) {
  currentTranscription = item;
  $("#transcriptionStatus").textContent = statusLabel(item.status);
  $("#transcriptOutput").value = item.transcript || "";
  $("#transcriptionMeta").replaceChildren(...[item.original_filename,item.parameters?.converted?"Конвертировано в MP3":null,item.audio_media_type,bytes(item.audio_size_bytes)].filter(Boolean).map(value => { const span=document.createElement("span"); span.textContent=value; return span; }));
  const segmentBox = $("#segments"); segmentBox.replaceChildren();
  for (const segment of item.segments || []) {
    const row=document.createElement("div"); row.className="segment";
    const meta=document.createElement("small"); meta.textContent=[segment.speaker,`${time(segment.start_seconds)}–${time(segment.end_seconds)}`].filter(Boolean).join(" · ");
    const text=document.createElement("div"); text.textContent=segment.text; row.append(meta,text); segmentBox.appendChild(row);
  }
  segmentBox.hidden = !(item.segments || []).length;
  const ready = item.status === "completed" && item.transcript;
  $("#downloadActions").hidden = !ready; $("#transcriptSummaryActions").hidden = !ready;
  const token = localStorage.getItem("auth_token") || "";
  for (const link of document.querySelectorAll("[data-download]")) link.href = `/api/transcriptions/${encodeURIComponent(item.id)}/download/${link.dataset.download}?token=${encodeURIComponent(token)}`;
  $("#transcriptionMessage").textContent = item.error?.message || (ready ? "Расшифровка завершена." : activeStatuses.has(item.status) ? "Задание выполняется." : "Результат недоступен.");
  renderLinked(item.summaries || []);
  if (activeStatuses.has(item.status)) { localStorage.setItem("activeTranscription", item.id); schedulePoll(item.id); }
  else { localStorage.removeItem("activeTranscription"); if (pollTimer) clearTimeout(pollTimer); pollTimer=null; }
}

function renderLinked(items) {
  const box=$("#linkedSummaries"); box.replaceChildren();
  if (!items.length) return;
  const title=document.createElement("h3"); title.textContent="Связанные резюме"; box.appendChild(title);
  for (const item of items) { const button=document.createElement("button"); button.className="history-item"; button.textContent=`${taskLabels[item.task_type]} · ${item.created_at.slice(0,16)}`; button.onclick=()=>openSummary(item.id); box.appendChild(button); }
}

function schedulePoll(id, delay=2500) { if (pollTimer) return; pollTimer=setTimeout(async()=>{ pollTimer=null; try { renderTranscription(await api(`/api/transcriptions/${id}`)); await loadHistory(); } catch { schedulePoll(id,5000); } },delay); }

$("#transcriptionForm").addEventListener("submit", async event => {
  event.preventDefault(); const file=$("#audioFile").files[0]; if (!file) return;
  const data=new FormData(); data.append("audio",file); data.append("language",$("#language").value); data.append("timestamp_granularity",$("#timestamps").value); data.append("speaker_labels",$("#speakers").checked ? "true":"false"); if ($("#contextHint").value.trim()) data.append("context_hint",$("#contextHint").value.trim());
  const button=$("#transcribeButton"); setBusy(button,true,"Транскрибировать");
  try { renderTranscription(await api("/api/transcriptions",{method:"POST",body:data})); await loadHistory(); } catch(error) { $("#transcriptionMessage").textContent=error.message; } finally { setBusy(button,false,"Транскрибировать"); }
});

function makeProgressId() { return globalThis.crypto?.randomUUID ? crypto.randomUUID() : `p-${Date.now()}-${Math.random()}`; }
function startProgress(id) {
  $("#progressPanel").hidden=false; $("#progressBar").value=0;
  if (progressTimer) clearInterval(progressTimer);
  progressTimer=setInterval(async()=>{ try { const p=await api(`/api/summarizer/progress/${encodeURIComponent(id)}`); $("#progressLabel").textContent=p.message; $("#progressBar").max=p.total; $("#progressBar").value=p.current; } catch {} },750);
}
function stopProgress() { if(progressTimer) clearInterval(progressTimer); progressTimer=null; }

async function requestSummary(url, settings) {
  const progressId=makeProgressId(); const payload={...settings,progress_id:progressId};
  startProgress(progressId); $("#summaryStatus").textContent="В работе"; $("#summaryActions").hidden=true;
  try {
    const result=await api(url,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(payload)});
    renderSummary(result); await loadHistory(); if(currentTranscription) renderTranscription(await api(`/api/transcriptions/${currentTranscription.id}`));
  } catch(error) {
    $("#summaryStatus").textContent="Ошибка"; $("#summaryAnswer").textContent=error.message; $("#summaryActions").hidden=true; $("#progressPanel").hidden=true;
  } finally { stopProgress(); }
}

$("#textSummaryForm").addEventListener("submit", async event => {
  event.preventDefault(); const button=$("#summarizeTextButton"); setBusy(button,true,"Суммаризировать");
  await requestSummary("/api/summarizer/summaries",{text:$("#manualText").value,task_type:$("#manualTaskType").value,task:$("#manualTask").value||null}); setBusy(button,false,"Суммаризировать");
});
$("#summarizeTranscriptButton").addEventListener("click", async()=>{ if(!currentTranscription)return; await requestSummary(`/api/transcriptions/${currentTranscription.id}/summaries`,{task_type:$("#transcriptTaskType").value}); });

function renderSummary(item) {
  const answer=item.result.answer || "";
  $("#summaryStatus").textContent="Готово"; $("#summaryAnswer").textContent=answer; $("#summaryExplain").textContent=item.result.explain || ""; $("#summaryActions").hidden=!answer; $("#copySummaryButton").textContent="Копировать резюме";
  $("#progressPanel").hidden=true;
}
async function openSummary(id) { try { renderSummary(await api(`/api/summarizer/summaries/${id}`)); } catch(error) { $("#summaryAnswer").textContent=error.message; $("#summaryActions").hidden=true; } }

async function copySummary() {
  const text=$("#summaryAnswer").textContent.trim();
  if(!text)return;
  const button=$("#copySummaryButton"), normal="Копировать резюме";
  try {
    if(navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
    } else {
      const area=document.createElement("textarea"); area.value=text; area.style.position="fixed"; area.style.opacity="0"; document.body.appendChild(area); area.select();
      let copied=false;
      try { copied=document.execCommand("copy"); } finally { area.remove(); }
      if(!copied)throw new Error("copy failed");
    }
    button.textContent="Скопировано";
  } catch {
    button.textContent="Не удалось скопировать";
  }
  setTimeout(()=>{button.textContent=normal;},1600);
}
$("#copySummaryButton").addEventListener("click",copySummary);

async function loadHistory() {
  const [transcriptions,summaries]=await Promise.all([api("/api/transcriptions"),api("/api/summarizer/summaries")]);
  const tBox=$("#transcriptionHistory"); tBox.replaceChildren(); for(const item of transcriptions.items||[]){const b=document.createElement("button");b.className="history-item";b.innerHTML="";const title=document.createElement("strong");title.textContent=item.original_filename||"Запись";const meta=document.createElement("small");meta.textContent=`${statusLabel(item.status)} · ${(item.summaries||[]).length} резюме`;b.append(title,meta);b.onclick=async()=>renderTranscription(await api(`/api/transcriptions/${item.id}`));tBox.appendChild(b);}
  const sBox=$("#summaryHistory");sBox.replaceChildren();for(const item of summaries||[]){const b=document.createElement("button");b.className="history-item";const title=document.createElement("strong");title.textContent=taskLabels[item.task_type];const meta=document.createElement("small");meta.textContent=item.source_transcription_id?"Из расшифровки":"Из введённого текста";b.append(title,meta);b.onclick=()=>openSummary(item.id);sBox.appendChild(b);}
}
$("#refreshHistory").addEventListener("click",()=>loadHistory().catch(()=>{}));
api("/api/audio-assistant/health").then(h=>{const mode=h.mock_mode?"mock":"real";$("#serviceStatus").textContent=mode==="mock"?"Mock":"Real";$("#serviceState").dataset.mode=mode;}).catch(()=>{$("#serviceStatus").textContent="Offline";$("#serviceState").dataset.mode="offline";});
loadHistory().then(async()=>{const id=localStorage.getItem("activeTranscription");if(id)renderTranscription(await api(`/api/transcriptions/${id}`));}).catch(()=>{});
