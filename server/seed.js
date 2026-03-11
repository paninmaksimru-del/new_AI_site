import { getDb } from './db.js';

const defaultDepartments = ['Аналитический центр', 'ЕЦП', 'Центр развития Сколково', 'Платформа i.moscow и ИИ', 'ИС РПП'];

const defaultCases = [
  { id: 'case_protocol', title: 'Протокол встречи за 15 минут', taskCategory: 'Провести встречу / зафиксировать итоги', context: 'Управление', role: ['Руководитель', 'Проектный менеджер', 'Специалист'], maturity: 'ready', whenToUse: 'После встречи нужно быстро подготовить протокол и список поручений.', result: 'Протокол + поручения (таблица) + риск-вопросы.', tools: ['ChatGPT', 'Copilot'], promptTemplate: 'Роль: секретарь встречи\nЦель: подготовить протокол по заметкам\nКонтекст: [вставь заметки/расшифровку]' },
  { id: 'case_letter', title: 'Черновик официального письма', taskCategory: 'Коммуникация и согласования', context: 'Переписка', role: ['Специалист', 'Руководитель'], maturity: 'pilot', whenToUse: 'Нужно быстро подготовить письмо в деловом стиле.', result: 'Черновик письма + варианты темы.', tools: ['ChatGPT', 'YandexGPT'], promptTemplate: 'Роль: делопроизводитель\nЦель: подготовить официальный черновик письма' },
];

const defaultPrompts = [
  { id: 'prompt_comm_1', sectionTitle: 'Коммуникации (письма, записки, ответы)', sectionSubtitle: 'Официальный стиль, лимит объёма.', title: '1) Официальное письмо (универсальное)', meta: 'Черновик официального письма по тезисам.', text: 'Роль: ты специалист Центра.\nЦель: подготовить официальное письмо [кому] по теме: [тема].' },
  { id: 'prompt_comm_2', sectionTitle: 'Коммуникации (письма, записки, ответы)', sectionSubtitle: 'Официальный стиль.', title: '2) Письмо‑приглашение на встречу', meta: 'Краткое приглашение с предложением слотов.', text: 'Роль: организатор встречи.\nЦель: подготовить письмо‑приглашение на [очную/онлайн] встречу по теме: [тема].' },
];

const defaultTools = [
  { id: 'tool_chatgpt', name: 'ChatGPT', category: 'documents', tasks: ['Документы и письма', 'Аналитика и сводки'], official: 'limited', vpn: true, access: 'request', departments: ['Аналитический центр', 'ЕЦП', 'Платформа i.moscow и ИИ'], bestFor: ['сводки', 'черновики'], risks: 'Не отправлять персональные данные.', onboarding: [] },
  { id: 'tool_yandexgpt', name: 'YandexGPT', category: 'documents', tasks: ['Документы и письма'], official: 'ok', vpn: false, access: 'ready', departments: ['Аналитический центр', 'ЕЦП'], bestFor: ['официальные черновики', 'сводки'], risks: 'Проверять факты.', onboarding: [] },
];

const defaultTasks = [
  { id: 't_prepare_doc', name: 'подготовить документ', tools: 'ChatGPT / YandexGPT / Copilot', weight: 1 },
  { id: 't_parse_incoming', name: 'разобрать документ / входящие материалы', tools: 'NotebookLM / ChatGPT', weight: 0.78 },
];

const db = getDb();

const deptCount = db.prepare('SELECT COUNT(*) as c FROM departments').get();
if (deptCount.c === 0) {
  const ins = db.prepare('INSERT OR IGNORE INTO departments (name) VALUES (?)');
  defaultDepartments.forEach(name => ins.run(name));
  console.log('Seeded departments');
}

const caseCount = db.prepare('SELECT COUNT(*) as c FROM cases').get();
if (caseCount.c === 0) {
  const ins = db.prepare('INSERT OR REPLACE INTO cases (id, data) VALUES (?, ?)');
  defaultCases.forEach(c => ins.run(c.id, JSON.stringify(c)));
  console.log('Seeded cases');
}

const promptCount = db.prepare('SELECT COUNT(*) as c FROM prompts').get();
if (promptCount.c === 0) {
  const ins = db.prepare('INSERT OR REPLACE INTO prompts (id, data) VALUES (?, ?)');
  defaultPrompts.forEach(p => ins.run(p.id, JSON.stringify(p)));
  console.log('Seeded prompts');
}

const toolCount = db.prepare('SELECT COUNT(*) as c FROM tools').get();
if (toolCount.c === 0) {
  const ins = db.prepare('INSERT OR REPLACE INTO tools (id, data) VALUES (?, ?)');
  defaultTools.forEach(t => ins.run(t.id, JSON.stringify(t)));
  console.log('Seeded tools');
}

const taskCount = db.prepare('SELECT COUNT(*) as c FROM tasks').get();
if (taskCount.c === 0) {
  const ins = db.prepare('INSERT OR REPLACE INTO tasks (id, data) VALUES (?, ?)');
  defaultTasks.forEach(t => ins.run(t.id, JSON.stringify(t)));
  console.log('Seeded tasks');
}

console.log('Seed done');
