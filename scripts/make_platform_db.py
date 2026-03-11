#!/usr/bin/env python3
# Создаёт share/platform.db для отправки коллегам (без Node.js)
import sqlite3
import json
import hashlib
import os

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.dirname(SCRIPT_DIR)
SHARE_DIR = os.path.join(PROJECT_ROOT, 'share')
DB_PATH = os.path.join(SHARE_DIR, 'platform.db')

os.makedirs(SHARE_DIR, exist_ok=True)

def hash_password(password):
    return hashlib.sha256((password + 'mik_salt_2026').encode()).hexdigest()

conn = sqlite3.connect(DB_PATH)
conn.executescript("""
    CREATE TABLE IF NOT EXISTS departments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE NOT NULL
    );
    CREATE TABLE IF NOT EXISTS cases (
      id TEXT PRIMARY KEY,
      data TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS prompts (
      id TEXT PRIMARY KEY,
      data TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS tools (
      id TEXT PRIMARY KEY,
      data TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      data TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS ui_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT NOT NULL,
      event_type TEXT,
      payload TEXT
    );
    CREATE TABLE IF NOT EXISTS kv (
      key TEXT PRIMARY KEY,
      value TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_ui_events_ts ON ui_events(timestamp);
    CREATE INDEX IF NOT EXISTS idx_ui_events_type ON ui_events(event_type);
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      login TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'user',
      full_name TEXT,
      department TEXT,
      contacts TEXT
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      created_at TEXT NOT NULL
    );
""")

cur = conn.cursor()

# Departments
depts = ['Аналитический центр', 'ЕЦП', 'Центр развития Сколково', 'Платформа i.moscow и ИИ', 'ИС РПП']
for name in depts:
    cur.execute("INSERT OR IGNORE INTO departments (name) VALUES (?)", (name,))

# Cases
default_cases = [
    {'id': 'case_protocol', 'title': 'Протокол встречи за 15 минут', 'taskCategory': 'Провести встречу / зафиксировать итоги', 'context': 'Управление', 'role': ['Руководитель', 'Проектный менеджер', 'Специалист'], 'maturity': 'ready', 'whenToUse': 'После встречи нужно быстро подготовить протокол и список поручений.', 'result': 'Протокол + поручения (таблица) + риск-вопросы.', 'tools': ['ChatGPT', 'Copilot'], 'promptTemplate': 'Роль: секретарь встречи\nЦель: подготовить протокол по заметкам\nКонтекст: [вставь заметки/расшифровку]'},
    {'id': 'case_letter', 'title': 'Черновик официального письма', 'taskCategory': 'Коммуникация и согласования', 'context': 'Переписка', 'role': ['Специалист', 'Руководитель'], 'maturity': 'pilot', 'whenToUse': 'Нужно быстро подготовить письмо в деловом стиле.', 'result': 'Черновик письма + варианты темы.', 'tools': ['ChatGPT', 'YandexGPT'], 'promptTemplate': 'Роль: делопроизводитель\nЦель: подготовить официальный черновик письма'},
]
for c in default_cases:
    cur.execute("INSERT OR REPLACE INTO cases (id, data) VALUES (?, ?)", (c['id'], json.dumps(c, ensure_ascii=False)))

# Prompts
default_prompts = [
    {'id': 'prompt_comm_1', 'sectionTitle': 'Коммуникации (письма, записки, ответы)', 'sectionSubtitle': 'Официальный стиль, лимит объёма.', 'title': '1) Официальное письмо (универсальное)', 'meta': 'Черновик официального письма по тезисам.', 'text': 'Роль: ты специалист Центра.\nЦель: подготовить официальное письмо [кому] по теме: [тема].'},
    {'id': 'prompt_comm_2', 'sectionTitle': 'Коммуникации (письма, записки, ответы)', 'sectionSubtitle': 'Официальный стиль.', 'title': '2) Письмо‑приглашение на встречу', 'meta': 'Краткое приглашение с предложением слотов.', 'text': 'Роль: организатор встречи.\nЦель: подготовить письмо‑приглашение на [очную/онлайн] встречу по теме: [тема].'},
]
for p in default_prompts:
    cur.execute("INSERT OR REPLACE INTO prompts (id, data) VALUES (?, ?)", (p['id'], json.dumps(p, ensure_ascii=False)))

# Tools
default_tools = [
    {'id': 'tool_chatgpt', 'name': 'ChatGPT', 'category': 'documents', 'tasks': ['Документы и письма', 'Аналитика и сводки'], 'official': 'limited', 'vpn': True, 'access': 'request', 'departments': ['Аналитический центр', 'ЕЦП', 'Платформа i.moscow и ИИ'], 'bestFor': ['сводки', 'черновики'], 'risks': 'Не отправлять персональные данные.', 'onboarding': []},
    {'id': 'tool_yandexgpt', 'name': 'YandexGPT', 'category': 'documents', 'tasks': ['Документы и письма'], 'official': 'ok', 'vpn': False, 'access': 'ready', 'departments': ['Аналитический центр', 'ЕЦП'], 'bestFor': ['официальные черновики', 'сводки'], 'risks': 'Проверять факты.', 'onboarding': []},
]
for t in default_tools:
    cur.execute("INSERT OR REPLACE INTO tools (id, data) VALUES (?, ?)", (t['id'], json.dumps(t, ensure_ascii=False)))

# Tasks
default_tasks = [
    {'id': 't_prepare_doc', 'name': 'подготовить документ', 'tools': 'ChatGPT / YandexGPT / Copilot', 'weight': 1},
    {'id': 't_parse_incoming', 'name': 'разобрать документ / входящие материалы', 'tools': 'NotebookLM / ChatGPT', 'weight': 0.78},
]
for t in default_tasks:
    cur.execute("INSERT OR REPLACE INTO tasks (id, data) VALUES (?, ?)", (t['id'], json.dumps(t, ensure_ascii=False)))

# Users (admin/admin123, user/user123)
cur.execute("INSERT OR IGNORE INTO users (id, login, password_hash, role, full_name, department, contacts) VALUES (1, 'admin', ?, 'admin', 'Администратор', NULL, NULL)", (hash_password('admin123'),))
cur.execute("INSERT OR IGNORE INTO users (id, login, password_hash, role, full_name, department, contacts) VALUES (2, 'user', ?, 'user', 'Иванов Иван Иванович', 'Отдел цифровых инноваций', NULL)", (hash_password('user123'),))

conn.commit()
conn.close()
print("Готово:", DB_PATH)
print("Отправьте коллегам файл share/platform.db")
