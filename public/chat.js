const DEFAULT_PROJECT = '__default__';
const token = localStorage.getItem('auth_token') || '';
const MODEL_META = {
  'qwen3.6-27b': {
    label: 'Qwen3.6-27B', dot: 'dot-green',
    desc: 'Qwen3.6-27B — полноразмерная модель для сложного анализа, рассуждений, текста и кода.',
    info: '<strong>Qwen3.6-27B</strong> · контекст 128K · около 30 токенов/с · режим долгого рассуждения включён по умолчанию.'
  },
  'qwen3.6-35b-a3b': {
    label: 'Qwen3.6-35B-A3B', dot: 'dot-cyan',
    desc: 'Qwen3.6-35B-A3B — быстрая MoE-модель для рабочих запросов, диалогов и документов.',
    info: '<strong>Qwen3.6-35B-A3B</strong> · контекст 128K · около 90 токенов/с · поддерживает потоковую выдачу и рассуждение.'
  }
};

const state = {
  model: 'qwen3.6-27b',
  modelLabel: 'Qwen3.6-27B',
  modelDot: 'dot-green',
  projects: [{ id: DEFAULT_PROJECT, name: null, open: true }],
  chats: [], messages: [], pendingFiles: [], activeChatId: null, draftProjectId: null, isLoading: false
};

function headers(json = true) {
  return { ...(json ? { 'Content-Type': 'application/json' } : {}), 'x-auth-token': token };
}

async function api(path, options = {}) {
  const response = await fetch(path, { ...options, headers: { ...headers(options.body instanceof FormData ? false : true), ...(options.headers || {}) } });
  if (response.status === 401) {
    window.location.replace('/login');
    throw new Error('Требуется авторизация.');
  }
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(typeof data.error === 'string' ? data.error : data.error?.message || `HTTP ${response.status}`);
  }
  return response.json();
}

function escHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#039;' }[c]));
}

const messageDateFormatter = new Intl.DateTimeFormat('ru-RU', {
  day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit'
});

function formatMessageDate(value) {
  const date = value ? new Date(value) : new Date();
  return messageDateFormatter.format(Number.isNaN(date.getTime()) ? new Date() : date);
}

function setProgress(value) {
  const bar = document.getElementById('progressBar');
  if (bar) bar.style.width = `${value}%`;
}

let toastTimer;
function showToast(message) {
  const toast = document.getElementById('toast');
  if (!toast) return;
  toast.textContent = message;
  toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), 3600);
}

function currentParameters() {
  return {
    enable_thinking: document.getElementById('enableThinking').checked,
    max_tokens: Number(document.getElementById('maxTokens').value),
    temperature: Number(document.getElementById('temperature').value),
    top_p: Number(document.getElementById('topP').value),
    top_k: Number(document.getElementById('topK').value),
    min_p: Number(document.getElementById('minP').value),
    presence_penalty: Number(document.getElementById('presencePenalty').value),
    frequency_penalty: Number(document.getElementById('frequencyPenalty').value),
    repetition_penalty: Number(document.getElementById('repetitionPenalty').value),
    system_prompt: document.getElementById('systemPrompt').value.trim()
  };
}

function applyParameters(parameters = {}, preservePreset = false) {
  if (!preservePreset) document.getElementById('samplingPreset').value = 'custom';
  document.getElementById('enableThinking').checked = parameters.enable_thinking !== false;
  document.getElementById('maxTokens').value = parameters.max_tokens ?? 2048;
  document.getElementById('temperature').value = parameters.temperature ?? 1;
  document.getElementById('topP').value = parameters.top_p ?? 0.95;
  document.getElementById('topK').value = parameters.top_k ?? 20;
  document.getElementById('minP').value = parameters.min_p ?? 0;
  document.getElementById('presencePenalty').value = parameters.presence_penalty ?? 0;
  document.getElementById('frequencyPenalty').value = parameters.frequency_penalty ?? 0;
  document.getElementById('repetitionPenalty').value = parameters.repetition_penalty ?? 1;
  document.getElementById('systemPrompt').value = parameters.system_prompt ?? '';
}

function setModel(model) {
  const meta = MODEL_META[model] || MODEL_META['qwen3.6-27b'];
  state.model = model;
  state.modelLabel = meta.label;
  state.modelDot = meta.dot;
  document.getElementById('msLabel').textContent = meta.label;
  document.getElementById('msDot').className = `ms-dot ${meta.dot}`;
  document.querySelectorAll('.md-option').forEach(option => option.classList.toggle('selected', option.dataset.model === model));
  document.getElementById('modelDesc').textContent = meta.desc;
  document.getElementById('modelInfoCard').innerHTML = meta.info;
}

async function loadModels() {
  const data = await api('/api/chat/models');
  const note = document.getElementById('connectionNote');
  note.textContent = data.configured
    ? 'Подключение настроено. Ответы передаются потоком; история и вложения изолированы по пользователю. По документации модели не имеют встроенных этических фильтров — используйте их ответственно.'
    : 'Подключение не настроено: администратору нужно указать токен прокси i.moscow во вкладке /admin → Qwen Chat. Модели не имеют встроенных этических фильтров.';
  note.style.color = data.configured ? 'rgba(38,210,152,.9)' : 'rgba(255,193,7,.95)';
}

async function loadProjects() {
  const projects = await api('/api/chat/projects');
  state.projects = [{ id: DEFAULT_PROJECT, name: null, open: true }, ...projects.map(p => ({ ...p, open: true }))];
}

async function loadSessions() {
  state.chats = await api('/api/chat/sessions');
  renderSidebar();
}

function renderSidebar() {
  const sidebar = document.getElementById('sbScroll');
  sidebar.innerHTML = '';
  for (const project of state.projects) {
    const chats = state.chats.filter(chat => (chat.project_id || DEFAULT_PROJECT) === project.id);
    const isDefault = project.id === DEFAULT_PROJECT;
    const group = document.createElement('div');
    group.className = `project-group${project.open !== false ? ' open' : ''}`;
    group.dataset.pid = project.id;
    if (!isDefault) {
      group.innerHTML = `<div class="project-head"><div class="project-head-left"><span class="project-arrow">›</span><span class="project-name">${escHtml(project.name)}</span><span class="project-badge">${chats.length}</span></div><div class="project-actions"><button class="project-add-btn" data-proj-new="${project.id}" type="button" title="Новый чат в проекте">＋</button><button class="project-delete-btn" data-proj-delete="${project.id}" type="button" title="Удалить проект">×</button></div></div>`;
    } else {
      group.innerHTML = '<div class="sb-section-label">Мои диалоги</div>';
    }
    const list = document.createElement('div');
    list.className = 'project-chats';
    if (!chats.length && !isDefault) list.innerHTML = '<div style="padding:5px 12px 6px 20px;font-size:11.5px;color:var(--muted-2);">Нет чатов</div>';
    for (const chat of chats) {
      const model = MODEL_META[chat.model] || MODEL_META['qwen3.6-27b'];
      const item = document.createElement('div');
      item.className = `chat-item${chat.id === state.activeChatId ? ' active' : ''}`;
      item.dataset.cid = chat.id;
      item.innerHTML = `<span class="chat-item-icon">—</span><span class="chat-item-text">${escHtml(chat.title)}</span><span class="chat-item-model">${escHtml(model.label.replace('Qwen3.6-', ''))}</span><button class="chat-item-menu" data-cmenu="${chat.id}" type="button">⋯</button>`;
      list.appendChild(item);
    }
    group.appendChild(list);
    sidebar.appendChild(group);
  }
  sidebar.querySelectorAll('.project-head').forEach(head => head.addEventListener('click', event => {
    if (event.target.closest('.project-actions')) return;
    const group = head.closest('.project-group');
    group.classList.toggle('open');
    const project = state.projects.find(item => item.id === group.dataset.pid);
    if (project) project.open = group.classList.contains('open');
  }));
  sidebar.querySelectorAll('[data-proj-new]').forEach(button => button.addEventListener('click', event => {
    event.stopPropagation();
    createNewChat(button.dataset.projNew).catch(error => showToast(`⚠️ ${error.message}`));
  }));
  sidebar.querySelectorAll('[data-proj-delete]').forEach(button => button.addEventListener('click', event => {
    event.stopPropagation();
    deleteProject(button.dataset.projDelete).catch(error => showToast(`⚠️ ${error.message}`));
  }));
  sidebar.querySelectorAll('.chat-item').forEach(item => item.addEventListener('click', event => {
    if (!event.target.closest('.chat-item-menu')) openChat(item.dataset.cid);
  }));
  sidebar.querySelectorAll('[data-cmenu]').forEach(button => button.addEventListener('click', event => {
    event.stopPropagation(); openContextMenu(event, button.dataset.cmenu);
  }));
}

async function createNewChat(projectId = null) {
  if (state.isLoading) throw new Error('Дождитесь завершения текущего ответа.');
  state.activeChatId = null;
  state.draftProjectId = !projectId || projectId === DEFAULT_PROJECT ? null : projectId;
  state.messages = [];
  clearChatUI();
  renderSidebar();
  document.getElementById('userInput').focus();
}

async function deleteProject(projectId) {
  if (state.isLoading) return showToast('Дождитесь завершения текущего ответа.');
  const project = state.projects.find(item => item.id === projectId);
  if (!project) return;
  if (!confirm(`Удалить проект «${project.name}»? Чаты из него будут перемещены в «Мои диалоги».`)) return;
  await api(`/api/chat/projects/${projectId}`, { method: 'DELETE' });
  state.projects = state.projects.filter(item => item.id !== projectId);
  state.chats.forEach(chat => { if (chat.project_id === projectId) chat.project_id = null; });
  if (state.draftProjectId === projectId) state.draftProjectId = null;
  renderSidebar();
  showToast('Проект удалён, чаты сохранены в «Моих диалогах».');
}

async function openChat(chatId) {
  if (state.isLoading) return showToast('Дождитесь завершения текущего ответа.');
  try {
    const data = await api(`/api/chat/sessions/${chatId}`);
    state.activeChatId = data.chat.id;
    state.draftProjectId = null;
    state.messages = data.messages || [];
    setModel(data.chat.model);
    applyParameters(data.chat.parameters || {});
    renderSidebar();
    replayChatUI();
    document.querySelector('.sidebar')?.classList.remove('mobile-open');
  } catch (error) { showToast(`⚠️ ${error.message}`); }
}

function clearChatUI() {
  const area = document.getElementById('messagesArea');
  const empty = document.getElementById('emptyState');
  area.innerHTML = '';
  area.appendChild(empty);
  empty.style.display = '';
}

function replayChatUI() {
  const area = document.getElementById('messagesArea');
  const empty = document.getElementById('emptyState');
  area.innerHTML = '';
  if (!state.messages.length) {
    area.appendChild(empty); empty.style.display = '';
    return;
  }
  empty.style.display = 'none';
  for (const message of state.messages) appendMessage(message.role, message.content, message.attachments || [], message.model, message.created_at);
}

function appendMessage(role, text, attachments = [], messageModel = state.model, createdAt = null) {
  const area = document.getElementById('messagesArea');
  const wrap = document.createElement('div');
  wrap.className = `msg ${role}`;
  const modelLabel = MODEL_META[messageModel]?.label || state.modelLabel;
  const files = attachments.length ? `<div class="message-files">${attachments.map(file => `<span>📄 ${escHtml(file.name)}</span>`).join('')}</div>` : '';
  wrap.innerHTML = `<div class="msg-avatar">${role === 'assistant' ? '✦' : '○'}</div><div class="msg-body"><div class="msg-meta"><span class="msg-label">${role === 'assistant' ? escHtml(modelLabel) : 'Вы'}</span><time class="msg-time" datetime="${escHtml(createdAt || new Date().toISOString())}">${escHtml(formatMessageDate(createdAt))}</time></div><div class="msg-bubble">${files}<span class="message-text">${escHtml(text)}</span></div><div class="msg-actions"><button class="msg-action-btn" type="button">Копировать</button></div></div>`;
  wrap.querySelector('.msg-action-btn').addEventListener('click', () => {
    const currentText = wrap.querySelector('.message-text')?.textContent || '';
    navigator.clipboard.writeText(currentText).then(() => showToast('✅ Скопировано')).catch(() => showToast('Не удалось скопировать'));
  });
  area.appendChild(wrap);
  scrollBottom();
  return wrap;
}

function createStreamingMessage(model) {
  const wrap = appendMessage('assistant', '', [], model);
  const text = wrap.querySelector('.message-text');
  text.innerHTML = '<span class="typing-dots"><span></span><span></span><span></span></span>';
  return { wrap, text, value: '' };
}

function scrollBottom() {
  const area = document.getElementById('messagesArea');
  area.scrollTop = area.scrollHeight;
}

let contextTarget = null;
function openContextMenu(event, chatId) {
  contextTarget = chatId;
  const menu = document.getElementById('ctxMenu');
  menu.style.left = `${Math.min(event.clientX, window.innerWidth - 180)}px`;
  menu.style.top = `${event.clientY}px`;
  menu.classList.add('open');
}

document.getElementById('ctxRename').addEventListener('click', async () => {
  if (state.isLoading) return showToast('Дождитесь завершения текущего ответа.');
  const chat = state.chats.find(item => item.id === contextTarget);
  if (!chat) return;
  const title = prompt('Новое название:', chat.title)?.trim();
  if (!title) return;
  try { await api(`/api/chat/sessions/${chat.id}`, { method:'PATCH', body:JSON.stringify({ title }) }); chat.title = title; renderSidebar(); }
  catch (error) { showToast(`⚠️ ${error.message}`); }
});

document.getElementById('ctxMove').addEventListener('click', async () => {
  if (state.isLoading) return showToast('Дождитесь завершения текущего ответа.');
  const projects = state.projects.filter(project => project.id !== DEFAULT_PROJECT);
  if (!projects.length) return showToast('Сначала создайте проект');
  const index = Number(prompt(`Переместить в проект:\n${projects.map((p, i) => `${i + 1}. ${p.name}`).join('\n')}`)) - 1;
  if (!projects[index]) return;
  try {
    await api(`/api/chat/sessions/${contextTarget}`, { method:'PATCH', body:JSON.stringify({ project_id: projects[index].id }) });
    const chat = state.chats.find(item => item.id === contextTarget); if (chat) chat.project_id = projects[index].id;
    renderSidebar();
  } catch (error) { showToast(`⚠️ ${error.message}`); }
});

document.getElementById('ctxDelete').addEventListener('click', async () => {
  if (state.isLoading) return showToast('Дождитесь завершения текущего ответа.');
  if (!confirm('Удалить чат и всю его историю?')) return;
  try {
    await api(`/api/chat/sessions/${contextTarget}`, { method:'DELETE' });
    state.chats = state.chats.filter(chat => chat.id !== contextTarget);
    if (state.activeChatId === contextTarget) { state.activeChatId = null; state.messages = []; clearChatUI(); }
    renderSidebar();
  } catch (error) { showToast(`⚠️ ${error.message}`); }
});

document.addEventListener('click', () => document.getElementById('ctxMenu').classList.remove('open'));

function renderFilePills() {
  const bar = document.getElementById('filePreviewBar');
  bar.innerHTML = state.pendingFiles.map((file, index) => `<div class="file-pill"><span>📄</span><span class="file-pill-name" title="${escHtml(file.name)}">${escHtml(file.name)}</span><span class="file-pill-rm" data-index="${index}">✕</span></div>`).join('');
  bar.classList.toggle('has-files', Boolean(state.pendingFiles.length));
  updateSendButton();
}

function updateSendButton() {
  document.getElementById('sendBtn').disabled = state.isLoading || (!document.getElementById('userInput').value.trim() && !state.pendingFiles.length);
  document.getElementById('newChatBtn').disabled = state.isLoading;
  document.getElementById('modelSelectorBtn').disabled = state.isLoading;
  document.querySelectorAll('.project-add-btn, .project-delete-btn, .chat-item-menu').forEach(button => { button.disabled = state.isLoading; });
}

async function consumeStream(response, streamMessage) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const events = buffer.split('\n\n');
    buffer = events.pop() || '';
    for (const raw of events) {
      const line = raw.split(/\r?\n/).find(item => item.startsWith('data:'));
      if (!line) continue;
      let event;
      try { event = JSON.parse(line.slice(5).trim()); } catch { continue; }
      if (event.type === 'meta') { state.activeChatId = event.chat_id; state.draftProjectId = null; }
      if (event.type === 'delta') {
        streamMessage.value += event.text;
        streamMessage.text.textContent = streamMessage.value;
        scrollBottom();
      }
      if (event.type === 'error') throw new Error(event.error || 'Ошибка модели.');
    }
  }
  return streamMessage.value;
}

async function sendMessage() {
  const input = document.getElementById('userInput');
  const message = input.value.trim();
  if ((!message && !state.pendingFiles.length) || state.isLoading) return;
  state.isLoading = true; updateSendButton(); setProgress(20);
  const files = [...state.pendingFiles];
  const requestModel = state.model;
  try {
    const empty = document.getElementById('emptyState');
    if (empty) empty.style.display = 'none';
    appendMessage('user', message, files.map(file => ({ name: file.name })), requestModel);
    input.value = ''; input.style.height = 'auto';
    document.getElementById('charCount').textContent = '';
    state.pendingFiles = []; renderFilePills();
    const streamMessage = createStreamingMessage(requestModel);
    const form = new FormData();
    if (state.activeChatId) form.append('chat_id', state.activeChatId);
    else if (state.draftProjectId) form.append('project_id', state.draftProjectId);
    form.append('model', requestModel);
    form.append('message', message);
    const parameters = currentParameters();
    for (const [key, value] of Object.entries(parameters)) form.append(key, String(value));
    for (const file of files) form.append('files', file, file.name);
    const response = await fetch('/api/chat/completions', { method:'POST', headers:headers(false), body:form });
    if (response.status === 401) { window.location.replace('/login'); return; }
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(typeof data.error === 'string' ? data.error : data.error?.message || `HTTP ${response.status}`);
    }
    setProgress(55);
    const answer = await consumeStream(response, streamMessage);
    if (!answer) streamMessage.wrap.remove();
    setProgress(100);
    await loadSessions();
  } catch (error) {
    document.querySelector('.msg.assistant:last-child .typing-dots')?.closest('.msg')?.remove();
    showToast(`⚠️ ${error.message}`);
  } finally {
    state.isLoading = false; updateSendButton();
    setTimeout(() => setProgress(0), 600);
    input.focus();
  }
}

document.getElementById('modelSelectorBtn').addEventListener('click', event => {
  event.stopPropagation(); document.getElementById('modelDropdown').classList.toggle('open');
});
document.getElementById('modelDropdown').addEventListener('click', async event => {
  const option = event.target.closest('.md-option');
  if (!option || !MODEL_META[option.dataset.model]) return;
  if (state.isLoading) return showToast('Дождитесь завершения текущего ответа.');
  setModel(option.dataset.model);
  document.getElementById('modelDropdown').classList.remove('open');
  if (state.activeChatId) {
    try {
      await api(`/api/chat/sessions/${state.activeChatId}`, { method:'PATCH', body:JSON.stringify({ model:state.model, parameters:currentParameters() }) });
      const chat = state.chats.find(item => item.id === state.activeChatId); if (chat) chat.model = state.model;
      renderSidebar();
    } catch (error) { showToast(`⚠️ ${error.message}`); }
  }
});
document.addEventListener('click', () => document.getElementById('modelDropdown').classList.remove('open'));
document.getElementById('settingsBtn').addEventListener('click', () => document.getElementById('settingsPanel').classList.toggle('open'));
document.getElementById('samplingPreset').addEventListener('change', event => {
  const presets = {
    'thinking-general': { enable_thinking:true, temperature:1, top_p:.95, top_k:20, min_p:0, presence_penalty:0, repetition_penalty:1 },
    'thinking-code': { enable_thinking:true, temperature:.6, top_p:.95, top_k:20, min_p:0, presence_penalty:0, repetition_penalty:1 },
    'instruct': { enable_thinking:false, temperature:.7, top_p:.8, top_k:20, min_p:0, presence_penalty:1.5, repetition_penalty:1 }
  };
  if (presets[event.target.value]) applyParameters({ ...currentParameters(), ...presets[event.target.value] }, true);
});
document.getElementById('newChatBtn').addEventListener('click', () => {
  createNewChat(DEFAULT_PROJECT).catch(error => showToast(`⚠️ ${error.message}`));
});
document.getElementById('sendBtn').addEventListener('click', sendMessage);
document.getElementById('userInput').addEventListener('keydown', event => {
  if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); sendMessage(); }
});
document.getElementById('userInput').addEventListener('input', event => {
  event.target.style.height = 'auto'; event.target.style.height = `${Math.min(event.target.scrollHeight, 180)}px`;
  document.getElementById('charCount').textContent = event.target.value.length ? `${event.target.value.length} / 50000` : '';
  updateSendButton();
});
document.getElementById('attachBtn').addEventListener('click', () => document.getElementById('fileInput').click());
document.getElementById('fileInput').addEventListener('change', event => {
  for (const file of event.target.files || []) {
    if (state.pendingFiles.length >= 5) { showToast('Можно приложить не более 5 файлов.'); break; }
    if (file.size > 15 * 1024 * 1024) { showToast(`Файл «${file.name}» больше 15 МБ.`); continue; }
    state.pendingFiles.push(file);
  }
  event.target.value = ''; renderFilePills();
});
document.getElementById('filePreviewBar').addEventListener('click', event => {
  const remove = event.target.closest('[data-index]');
  if (!remove) return; state.pendingFiles.splice(Number(remove.dataset.index), 1); renderFilePills();
});
document.querySelector('.suggestions').addEventListener('click', event => {
  const chip = event.target.closest('.suggestion-chip'); if (!chip) return;
  document.getElementById('userInput').value = chip.textContent.trim(); updateSendButton(); sendMessage();
});

document.getElementById('addProjectBtn').addEventListener('click', () => document.getElementById('projectModal').classList.add('open'));
document.getElementById('projectCancelBtn').addEventListener('click', () => document.getElementById('projectModal').classList.remove('open'));
document.getElementById('projectCreateBtn').addEventListener('click', async () => {
  const input = document.getElementById('projectNameInput');
  const name = input.value.trim(); if (!name) return;
  try {
    const project = await api('/api/chat/projects', { method:'POST', body:JSON.stringify({ name }) });
    state.projects.push({ ...project, open:true }); renderSidebar();
    input.value = ''; document.getElementById('projectModal').classList.remove('open');
  } catch (error) { showToast(`⚠️ ${error.message}`); }
});
document.getElementById('projectNameInput').addEventListener('keydown', event => { if (event.key === 'Enter') document.getElementById('projectCreateBtn').click(); });

document.getElementById('historyBtn').addEventListener('click', () => {
  const sidebar = document.querySelector('.sidebar');
  if (window.innerWidth <= 820) sidebar.classList.toggle('mobile-open');
  else { document.getElementById('sbScroll').scrollTop = 0; showToast('История диалогов находится слева и хранится персонально в БД.'); }
});
document.getElementById('burgerBtn').addEventListener('click', () => {
  const menu = document.getElementById('mobileMenu');
  menu.classList.toggle('show');
  document.getElementById('burgerBtn').setAttribute('aria-expanded', menu.classList.contains('show') ? 'true' : 'false');
});
document.getElementById('profileBtn').addEventListener('click', event => { event.preventDefault(); window.location = token ? '/profile' : '/login'; });

async function init() {
  if (!token) return window.location.replace('/login');
  try {
    const me = await api('/api/me');
    const label = document.querySelector('#profileBtn span:last-child');
    if (label) label.textContent = me.full_name || me.login || 'Профиль';
    setModel(state.model);
    await Promise.all([loadModels(), loadProjects(), loadSessions()]);
    renderSidebar();
    if (state.chats[0]) await openChat(state.chats[0].id);
    else clearChatUI();
  } catch (error) { showToast(`⚠️ ${error.message}`); }
}

init();
