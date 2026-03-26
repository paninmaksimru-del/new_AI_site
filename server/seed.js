import { query } from './db.js';

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

const { rows: deptRows } = await query('SELECT COUNT(*) as c FROM departments');
if (parseInt(deptRows[0].c) === 0) {
  for (const name of defaultDepartments) {
    await query('INSERT INTO departments (name) VALUES ($1) ON CONFLICT DO NOTHING', [name]);
  }
  console.log('Seeded departments');
}

const { rows: tccRows } = await query('SELECT COUNT(*) as c FROM case_task_categories');
if (parseInt(tccRows[0].c) === 0) {
  const catNames = [...new Set(defaultCases.map(c => c.taskCategory).filter(Boolean))];
  for (const name of catNames) {
    await query('INSERT INTO case_task_categories (name) VALUES ($1) ON CONFLICT DO NOTHING', [name]);
  }
  console.log('Seeded case_task_categories');
}

const { rows: caseRows } = await query('SELECT COUNT(*) as c FROM cases');
if (parseInt(caseRows[0].c) === 0) {
  for (const c of defaultCases) {
    await query('INSERT INTO cases (id, data) VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET data = $2', [c.id, JSON.stringify(c)]);
  }
  console.log('Seeded cases');
}

const { rows: promptRows } = await query('SELECT COUNT(*) as c FROM prompts');
if (parseInt(promptRows[0].c) === 0) {
  for (const p of defaultPrompts) {
    await query('INSERT INTO prompts (id, data) VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET data = $2', [p.id, JSON.stringify(p)]);
  }
  console.log('Seeded prompts');
}

const { rows: toolRows } = await query('SELECT COUNT(*) as c FROM tools');
if (parseInt(toolRows[0].c) === 0) {
  for (const t of defaultTools) {
    await query('INSERT INTO tools (id, data) VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET data = $2', [t.id, JSON.stringify(t)]);
  }
  console.log('Seeded tools');
}

const { rows: taskRows } = await query('SELECT COUNT(*) as c FROM tasks');
if (parseInt(taskRows[0].c) === 0) {
  for (const t of defaultTasks) {
    await query('INSERT INTO tasks (id, data) VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET data = $2', [t.id, JSON.stringify(t)]);
  }
  console.log('Seeded tasks');
}

console.log('Seed done');
