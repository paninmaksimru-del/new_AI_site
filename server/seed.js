import { query } from './db.js';
import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Load prompts from JSON library file
function loadPromptsFromLibrary() {
  const candidates = [
    join(__dirname, '..', 'prompt-library.json'),
    join(process.cwd(), 'prompt-library.json'),
  ];
  const libPath = candidates.find(p => existsSync(p));
  if (!libPath) return null;
  try {
    const data = JSON.parse(readFileSync(libPath, 'utf8'));
    const flat = [];
    data.categories.forEach(cat => {
      cat.prompts.forEach(p => {
        flat.push({
          id: cat.id + '_' + p.id,
          sectionTitle: cat.name,
          sectionSubtitle: cat.description || '',
          title: p.title,
          meta: p.description || '',
          text: p.prompt || '',
          result: p.result || ''
        });
      });
    });
    return flat;
  } catch (e) {
    console.error('Failed to load prompt library:', e.message);
    return null;
  }
}

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

// Prompts: load from JSON library if available, otherwise seed defaults
const libraryPrompts = loadPromptsFromLibrary();
if (libraryPrompts && libraryPrompts.length > 0) {
  await query('DELETE FROM prompts');
  for (const p of libraryPrompts) {
    await query('INSERT INTO prompts (id, data) VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET data = $2', [p.id, JSON.stringify(p)]);
  }
  console.log('Seeded prompts from library:', libraryPrompts.length);
} else {
  const { rows: promptRows } = await query('SELECT COUNT(*) as c FROM prompts');
  if (parseInt(promptRows[0].c) === 0) {
    for (const p of defaultPrompts) {
      await query('INSERT INTO prompts (id, data) VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET data = $2', [p.id, JSON.stringify(p)]);
    }
    console.log('Seeded prompts');
  }
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

const defaultMaterials = [
  { id: '1', title: 'ТОП-10 бесплатных нейросетей на все случаи жизни', link: 'https://habr.com/ru/companies/bothub/articles/1012792/', description: 'Обзор лучших бесплатных нейросетей для работы, учёбы и повседневных задач' },
  { id: '2', title: 'Можно ли собрать рабочий сайт через ИИ, зная только базовый HTML', link: 'https://habr.com/ru/companies/tensor/articles/1012316/', description: 'Эксперимент по созданию полноценного сайта с помощью ИИ без глубоких знаний программирования' },
  { id: '3', title: 'Гайд по пользованию ChatGPT', link: 'https://youtu.be/3n3BDmb_QEg?si=qDLI9s4lsVbIMJ0Y', description: 'Видеоурок по основам работы с ChatGPT для начинающих' },
  { id: '4', title: 'Гайд по работе языковых моделей', link: 'https://habr.com/ru/companies/skillfactory/articles/837366/', description: 'Подробное объяснение принципов работы больших языковых моделей простым языком' },
  { id: '5', title: 'Я дал ИИ собственный компьютер и 483 сессии свободы', link: 'https://habr.com/ru/articles/1007574/', description: 'Эксперимент: что произойдёт, если дать ИИ-агенту полный доступ к компьютеру' },
  { id: '6', title: 'The Only AI Tools You Need (Part 1 — Daily Use)', link: 'https://www.youtube.com/watch?v=htZRCE2GgIs', description: 'Подборка самых полезных ИИ-инструментов для ежедневного использования' },
  { id: '7', title: 'NotebookLM + Gemini: бесплатные AI-презентации', link: 'https://www.youtube.com/watch?v=Hjj5Z-zblWQ', description: 'Как создавать качественные презентации бесплатно с помощью Google NotebookLM и Gemini' },
  { id: '8', title: 'AI Agents, Clearly Explained', link: 'https://www.youtube.com/watch?v=FwOTs4UxQS4', description: 'Понятное объяснение концепции ИИ-агентов и их возможностей' },
  { id: '9', title: '101 Ways To Use AI In Your Daily Life', link: 'https://www.youtube.com/watch?v=zkXonmqIBFg', description: '101 практический сценарий применения ИИ в повседневной жизни' },
  { id: '10', title: 'AI инструменты для продуктивности: полный обзор', link: 'https://www.youtube.com/watch?v=JMQ0X_si144', description: 'Обзор ИИ-инструментов, которые помогают работать быстрее и эффективнее' },
  { id: '11', title: '25+ лучших гугловских инструментов и гайдов по ИИ', link: 'https://habr.com/ru/articles/984326/', description: 'Каталог ИИ-инструментов и обучающих материалов от Google' },
  { id: '12', title: 'The AI Skills Playbook (Google)', link: 'https://services.google.com/fh/files/misc/the-ai-skills-playbook.pdf', description: 'Руководство Google по развитию навыков работы с ИИ в команде' },
  { id: '13', title: 'Использование средств и ресурсов ИИ для бизнеса', link: 'https://learn.microsoft.com/ru-ru/training/modules/leverage-ai-tools/', description: 'Курс Microsoft по применению ИИ-инструментов в бизнес-процессах' },
  { id: '14', title: 'GPT в ChatGPT — как создавать и использовать', link: 'https://help.openai.com/ru-ru/articles/8554407-gpts-in-chatgpt', description: 'Официальное руководство OpenAI по созданию и использованию кастомных GPT' },
  { id: '15', title: 'Нанимаем ChatGPT на работу: автоматизация бизнес-процессов', link: 'https://habr.com/ru/articles/985272/', description: 'Практические примеры автоматизации рабочих задач с помощью ChatGPT' },
  { id: '16', title: 'Введение в Claude API', link: 'https://docs.anthropic.com/en/docs/intro-to-claude', description: 'Официальная документация Anthropic по началу работы с Claude API' },
  { id: '17', title: 'Гайд по написанию промптов (OpenAI)', link: 'https://platform.openai.com/docs/guides/prompt-engineering', description: 'Официальное руководство OpenAI по эффективному написанию промптов' },
  { id: '18', title: 'Основы работы с ChatGPT (OpenAI Academy)', link: 'https://academy.openai.com/', description: 'Бесплатные курсы OpenAI Academy по основам работы с ChatGPT' },
  { id: '19', title: 'Как работают AI модели (Cursor Learn)', link: 'https://www.cursor.com/learn/how-ai-models-work', description: 'Наглядное объяснение принципов работы современных ИИ-моделей' },
  { id: '20', title: 'Безопасный ИИ: принципы ответственного использования', link: 'https://www.cloudskillsboost.google/course_templates/388', description: 'Курс Google Cloud по принципам безопасного и ответственного применения ИИ' },
  { id: '21', title: 'ИИ в бизнесе (Сколково)', link: 'https://www.youtube.com/watch?v=9YrTyzYGp58&list=PLt17IPLzK6i46MydtD-7ifjn6FkakUKbI&index=5', description: 'Лекция Сколково о применении искусственного интеллекта в бизнесе' },
  { id: '22', title: 'Как в продуктовом подходе помогают ИИ-инструменты', link: 'https://www.youtube.com/watch?v=gHkPs_quiyY&list=PLt17IPLzK6i46MydtD-7ifjn6FkakUKbI&index=18', description: 'Доклад о роли ИИ-инструментов в продуктовом менеджменте' },
  { id: '23', title: 'Claude Skills — расширения для Claude Code', link: 'https://docs.anthropic.com/en/docs/claude-code/skills', description: 'Документация Anthropic по созданию и использованию skills в Claude Code' },
];

const { rows: matRows } = await query('SELECT COUNT(*) as c FROM materials');
if (parseInt(matRows[0].c) === 0) {
  for (const m of defaultMaterials) {
    await query('INSERT INTO materials (id, data) VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET data = $2', [m.id, JSON.stringify(m)]);
  }
  console.log('Seeded materials:', defaultMaterials.length);
}

console.log('Seed done');
