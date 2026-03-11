// server/auth.js
// Подключи в server/index.js:
//   import { setupAuth, requireAuth, requireAdmin } from './auth.js';
//   setupAuth(app, getDb);

import crypto from 'crypto';

// ── helpers ──────────────────────────────────────────────────────────────────
function hashPassword(password) {
  return crypto.createHash('sha256').update(password + 'mik_salt_2026').digest('hex');
}

function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

// ── setup ─────────────────────────────────────────────────────────────────────
export function setupAuth(app, getDb) {
  const db = () => getDb();

  // Создать таблицы если нет
  db().exec(`
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

  // Миграция: добавить колонки в существующую таблицу (если их нет)
  const addColumn = (name, type = 'TEXT') => {
    try { db().exec(`ALTER TABLE users ADD COLUMN ${name} ${type}`); } catch (_) {}
  };
  addColumn('full_name');
  addColumn('department');
  addColumn('contacts');

  // Создать дефолтных пользователей если таблица пустая
  const count = db().prepare('SELECT COUNT(*) as c FROM users').get();
  if (count.c === 0) {
    db().prepare('INSERT INTO users (login, password_hash, role, full_name, department, contacts) VALUES (?, ?, ?, ?, ?, ?)').run(
      'admin', hashPassword('admin123'), 'admin', 'Администратор', null, null
    );
    db().prepare('INSERT INTO users (login, password_hash, role, full_name, department, contacts) VALUES (?, ?, ?, ?, ?, ?)').run(
      'user', hashPassword('user123'), 'user', 'Иванов Иван Иванович', 'Отдел цифровых инноваций', null
    );
    console.log('✅ Созданы дефолтные пользователи: admin/admin123 и user/user123');
  }

  // POST /api/login
  app.post('/api/login', (req, res) => {
    try {
      const { login, password } = req.body || {};
      if (!login || !password) return res.status(400).json({ error: 'Введите логин и пароль' });

      const user = db().prepare('SELECT * FROM users WHERE login = ?').get(login.trim());
      if (!user || user.password_hash !== hashPassword(password)) {
        return res.status(401).json({ error: 'Неверный логин или пароль' });
      }

      const token = generateToken();
      db().prepare('INSERT INTO sessions (token, user_id, created_at) VALUES (?, ?, ?)').run(
        token, user.id, new Date().toISOString()
      );

      res.json({
        ok: true,
        token,
        role: user.role,
        login: user.login,
        full_name: user.full_name || null,
        department: user.department || null,
        contacts: user.contacts || null
      });
    } catch (e) {
      res.status(500).json({ error: String(e.message) });
    }
  });

  // POST /api/logout
  app.post('/api/logout', (req, res) => {
    try {
      const token = req.headers['x-auth-token'] || req.body?.token;
      if (token) db().prepare('DELETE FROM sessions WHERE token = ?').run(token);
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: String(e.message) });
    }
  });

  // GET /api/me
  app.get('/api/me', (req, res) => {
    try {
      const token = req.headers['x-auth-token'];
      if (!token) return res.status(401).json({ error: 'Не авторизован' });
      const session = db().prepare('SELECT * FROM sessions WHERE token = ?').get(token);
      if (!session) return res.status(401).json({ error: 'Сессия не найдена' });
      const user = db().prepare('SELECT id, login, role, full_name, department, contacts FROM users WHERE id = ?').get(session.user_id);
      res.json(user);
    } catch (e) {
      res.status(500).json({ error: String(e.message) });
    }
  });

  // GET /api/users (только для admin)
  app.get('/api/users', requireAdmin(getDb), (req, res) => {
    try {
      const users = db().prepare('SELECT id, login, role, full_name, department, contacts FROM users ORDER BY id').all();
      res.json(users);
    } catch (e) {
      res.status(500).json({ error: String(e.message) });
    }
  });

  // PUT /api/users/:id (обновить пользователя: full_name, department, contacts, пароль — только admin)
  app.put('/api/users/:id', requireAdmin(getDb), (req, res) => {
    try {
      const id = req.params.id;
      const { login, password, role, full_name, department, contacts } = req.body || {};
      const user = db().prepare('SELECT id FROM users WHERE id = ?').get(id);
      if (!user) return res.status(404).json({ error: 'Пользователь не найден' });
      const updates = [];
      const values = [];
      if (login !== undefined) { updates.push('login = ?'); values.push(login.trim()); }
      if (password !== undefined && String(password).length > 0) { updates.push('password_hash = ?'); values.push(hashPassword(password)); }
      if (role !== undefined) { updates.push('role = ?'); values.push(role === 'admin' ? 'admin' : 'user'); }
      if (full_name !== undefined) { updates.push('full_name = ?'); values.push(full_name ? String(full_name).trim() : null); }
      if (department !== undefined) { updates.push('department = ?'); values.push(department ? String(department).trim() : null); }
      if (contacts !== undefined) { updates.push('contacts = ?'); values.push(contacts ? String(contacts).trim() : null); }
      if (updates.length === 0) return res.json({ ok: true });
      values.push(id);
      db().prepare(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`).run(...values);
      res.json({ ok: true });
    } catch (e) {
      if (e.message && e.message.includes('UNIQUE')) return res.status(400).json({ error: 'Логин уже занят' });
      res.status(500).json({ error: String(e.message) });
    }
  });

  // POST /api/users (создать пользователя, только admin)
  app.post('/api/users', requireAdmin(getDb), (req, res) => {
    try {
      const { login, password, role, full_name, department, contacts } = req.body || {};
      if (!login || !password) return res.status(400).json({ error: 'login и password обязательны' });
      const validRole = role === 'admin' ? 'admin' : 'user';
      db().prepare('INSERT INTO users (login, password_hash, role, full_name, department, contacts) VALUES (?, ?, ?, ?, ?, ?)').run(
        login.trim(),
        hashPassword(password),
        validRole,
        full_name ? String(full_name).trim() : null,
        department ? String(department).trim() : null,
        contacts ? String(contacts).trim() : null
      );
      res.json({ ok: true });
    } catch (e) {
      if (e.message.includes('UNIQUE')) return res.status(400).json({ error: 'Логин уже занят' });
      res.status(500).json({ error: String(e.message) });
    }
  });

  // DELETE /api/users/:id (только admin)
  app.delete('/api/users/:id', requireAdmin(getDb), (req, res) => {
    try {
      db().prepare('DELETE FROM users WHERE id = ?').run(req.params.id);
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: String(e.message) });
    }
  });
}

// ── middleware ────────────────────────────────────────────────────────────────
export function requireAuth(getDb) {
  return (req, res, next) => {
    const token = req.headers['x-auth-token'] || req.query.token;
    if (!token) return res.redirect('/login');
    const session = getDb().prepare('SELECT * FROM sessions WHERE token = ?').get(token);
    if (!session) return res.redirect('/login');
    const user = getDb().prepare('SELECT * FROM users WHERE id = ?').get(session.user_id);
    if (!user) return res.redirect('/login');
    req.user = user;
    next();
  };
}

export function requireAdmin(getDb) {
  return (req, res, next) => {
    const token = req.headers['x-auth-token'] || req.query.token;
    if (!token) return res.status(401).json({ error: 'Не авторизован' });
    const session = getDb().prepare('SELECT * FROM sessions WHERE token = ?').get(token);
    if (!session) return res.status(401).json({ error: 'Не авторизован' });
    const user = getDb().prepare('SELECT * FROM users WHERE id = ?').get(session.user_id);
    if (!user || user.role !== 'admin') return res.status(403).json({ error: 'Нет доступа' });
    req.user = user;
    next();
  };
}

