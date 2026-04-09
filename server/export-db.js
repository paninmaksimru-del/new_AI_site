/**
 * Создаёт готовый файл БД для отправки коллегам.
 * Результат: share/platform.db
 *
 * Запуск: node server/export-db.js
 * или:   npm run export-db
 */

import { mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, '..');
const shareDir = join(projectRoot, 'share');
const outPath = join(shareDir, 'platform.db');

// Указываем путь к БД до первого вызова getDb
process.env.DATABASE_PATH = outPath;

if (!existsSync(shareDir)) mkdirSync(shareDir, { recursive: true });

// Инициализация основной схемы и сидов
import { getDb } from './db.js';
import './seed.js';

const db = getDb();

// Схема и пользователи из auth (чтобы коллеги могли сразу входить)
db.exec(`
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
`);

const addColumn = (name, type = 'TEXT') => {
  try { db.exec(`ALTER TABLE users ADD COLUMN ${name} ${type}`); } catch (_) {}
};
addColumn('full_name');
addColumn('department');
addColumn('contacts');

const hashPassword = (password) =>
  crypto.createHash('sha256').update(password + 'mik_salt_2026').digest('hex');

const userCount = db.prepare('SELECT COUNT(*) as c FROM users').get();
if (userCount.c === 0) {
  db.prepare(
    'INSERT INTO users (login, password_hash, role, full_name, department, contacts) VALUES (?, ?, ?, ?, ?, ?)'
  ).run('admin', hashPassword('admin123'), 'admin', 'Администратор', null, null);
  db.prepare(
    'INSERT INTO users (login, password_hash, role, full_name, department, contacts) VALUES (?, ?, ?, ?, ?, ?)'
  ).run('user', hashPassword('user123'), 'user', 'Иванов Иван Иванович', 'Отдел цифровых инноваций', null);
  console.log('Добавлены пользователи: admin/admin123, user/user123');
}

console.log('');
console.log('Готово. Файл БД для коллег:');
console.log('  ', outPath);
console.log('');
console.log('Отправьте коллегам файл share/platform.db.');
console.log('Чтобы использовать: положите его в папку data/ как platform.db и запустите сервер.');
console.log('');
