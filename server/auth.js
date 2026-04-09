// server/auth.js
import crypto from 'crypto';
import { query } from './db.js';

// ── helpers ──────────────────────────────────────────────────────────────────
function hashPassword(password) {
  return crypto.createHash('sha256').update(password + 'mik_salt_2026').digest('hex');
}

function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

// ── setup ─────────────────────────────────────────────────────────────────────
export async function setupAuth(app) {
  // Создать таблицы если нет
  await query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      login TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'user',
      full_name TEXT,
      department TEXT,
      contacts TEXT,
      last_name TEXT,
      first_name TEXT,
      patronymic TEXT,
      email TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_login_at TIMESTAMPTZ
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      created_at TEXT NOT NULL
    );
  `);

  // Добавить колонки в существующую таблицу (если БД уже была создана без них)
  await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`);
  await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMPTZ`);

  // Создать дефолтных пользователей если таблица пустая
  const { rows } = await query('SELECT COUNT(*) as c FROM users');
  if (parseInt(rows[0].c) === 0) {
    await query(
      'INSERT INTO users (login, password_hash, role, full_name, department, contacts) VALUES ($1, $2, $3, $4, $5, $6)',
      ['admin', hashPassword('admin123'), 'admin', 'Администратор', null, null]
    );
    await query(
      'INSERT INTO users (login, password_hash, role, full_name, department, contacts) VALUES ($1, $2, $3, $4, $5, $6)',
      ['user', hashPassword('user123'), 'user', 'Иванов Иван Иванович', 'Отдел цифровых инноваций', null]
    );
    console.log('Созданы дефолтные пользователи: admin/admin123 и user/user123');
  }

  // POST /api/login
  app.post('/api/login', async (req, res) => {
    try {
      const { login, password } = req.body || {};
      if (!login || !password) return res.status(400).json({ error: 'Введите логин и пароль' });

      const { rows } = await query('SELECT * FROM users WHERE login = $1', [login.trim()]);
      const user = rows[0];
      if (!user || user.password_hash !== hashPassword(password)) {
        return res.status(401).json({ error: 'Неверный логин или пароль' });
      }

      const token = generateToken();
      await query('INSERT INTO sessions (token, user_id, created_at) VALUES ($1, $2, $3)', [
        token, user.id, new Date().toISOString()
      ]);
      await query('UPDATE users SET last_login_at = NOW() WHERE id = $1', [user.id]);

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

  // POST /api/register
  app.post('/api/register', async (req, res) => {
    try {
      const { last_name, first_name, patronymic = '', email, password, password_confirm } = req.body || {};

      if (!last_name || !first_name || !email || !password)
        return res.status(400).json({ error: 'Заполните все обязательные поля' });
      if (password !== password_confirm)
        return res.status(400).json({ error: 'Пароли не совпадают' });
      if (password.length < 6)
        return res.status(400).json({ error: 'Пароль должен содержать не менее 6 символов' });

      const login = email.trim().toLowerCase();
      const fullName = [last_name.trim(), first_name.trim(), patronymic.trim()].filter(Boolean).join(' ');

      await query(
        'INSERT INTO users (login, password_hash, role, full_name, last_name, first_name, patronymic, email) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
        [login, hashPassword(password), 'user', fullName, last_name.trim(), first_name.trim(), patronymic.trim(), email.trim()]
      );

      const { rows } = await query('SELECT * FROM users WHERE login = $1', [login]);
      const user = rows[0];
      const token = generateToken();
      await query('INSERT INTO sessions (token, user_id, created_at) VALUES ($1, $2, $3)', [
        token, user.id, new Date().toISOString()
      ]);

      res.json({
        ok: true,
        token,
        role: 'user',
        login,
        full_name: fullName,
        department: user.department || null,
        contacts: user.contacts || null
      });
    } catch (e) {
      if (e.message && e.message.includes('unique')) return res.status(400).json({ error: 'Пользователь с таким email уже зарегистрирован' });
      res.status(500).json({ error: String(e.message) });
    }
  });

  // POST /api/logout
  app.post('/api/logout', async (req, res) => {
    try {
      const token = req.headers['x-auth-token'] || req.body?.token;
      if (token) await query('DELETE FROM sessions WHERE token = $1', [token]);
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: String(e.message) });
    }
  });

  // GET /api/me
  app.get('/api/me', async (req, res) => {
    try {
      const token = req.headers['x-auth-token'];
      if (!token) return res.status(401).json({ error: 'Не авторизован' });
      const { rows: sessions } = await query('SELECT * FROM sessions WHERE token = $1', [token]);
      if (!sessions[0]) return res.status(401).json({ error: 'Сессия не найдена' });
      const { rows: users } = await query(
        'SELECT id, login, role, full_name, department, contacts, first_name, last_name, patronymic, email, created_at, last_login_at FROM users WHERE id = $1',
        [sessions[0].user_id]
      );
      res.json(users[0]);
    } catch (e) {
      res.status(500).json({ error: String(e.message) });
    }
  });

  // GET /api/users (только для admin)
  app.get('/api/users', requireAdmin(), async (req, res) => {
    try {
      const { rows } = await query('SELECT id, login, role, full_name, department, contacts, first_name, last_name, patronymic, email, created_at, last_login_at FROM users ORDER BY id');
      res.json(rows);
    } catch (e) {
      res.status(500).json({ error: String(e.message) });
    }
  });

  // PUT /api/users/:id
  app.put('/api/users/:id', requireAdmin(), async (req, res) => {
    try {
      const id = req.params.id;
      const { login, password, role, full_name, department, contacts } = req.body || {};
      const { rows } = await query('SELECT id FROM users WHERE id = $1', [id]);
      if (!rows[0]) return res.status(404).json({ error: 'Пользователь не найден' });

      const updates = [];
      const values = [];
      let i = 1;
      if (login !== undefined) { updates.push(`login = $${i++}`); values.push(login.trim()); }
      if (password !== undefined && String(password).length > 0) { updates.push(`password_hash = $${i++}`); values.push(hashPassword(password)); }
      if (role !== undefined) { updates.push(`role = $${i++}`); values.push(role === 'admin' ? 'admin' : 'user'); }
      if (full_name !== undefined) { updates.push(`full_name = $${i++}`); values.push(full_name ? String(full_name).trim() : null); }
      if (department !== undefined) { updates.push(`department = $${i++}`); values.push(department ? String(department).trim() : null); }
      if (contacts !== undefined) { updates.push(`contacts = $${i++}`); values.push(contacts ? String(contacts).trim() : null); }
      if (updates.length === 0) return res.json({ ok: true });

      values.push(id);
      await query(`UPDATE users SET ${updates.join(', ')} WHERE id = $${i}`, values);
      res.json({ ok: true });
    } catch (e) {
      if (e.message && e.message.includes('unique')) return res.status(400).json({ error: 'Логин уже занят' });
      res.status(500).json({ error: String(e.message) });
    }
  });

  // POST /api/users
  app.post('/api/users', requireAdmin(), async (req, res) => {
    try {
      const { login, password, role, full_name, department, contacts } = req.body || {};
      if (!login || !password) return res.status(400).json({ error: 'login и password обязательны' });
      const validRole = role === 'admin' ? 'admin' : 'user';
      await query(
        'INSERT INTO users (login, password_hash, role, full_name, department, contacts) VALUES ($1, $2, $3, $4, $5, $6)',
        [login.trim(), hashPassword(password), validRole,
         full_name ? String(full_name).trim() : null,
         department ? String(department).trim() : null,
         contacts ? String(contacts).trim() : null]
      );
      res.json({ ok: true });
    } catch (e) {
      if (e.message && e.message.includes('unique')) return res.status(400).json({ error: 'Логин уже занят' });
      res.status(500).json({ error: String(e.message) });
    }
  });

  // DELETE /api/users/:id
  app.delete('/api/users/:id', requireAdmin(), async (req, res) => {
    try {
      await query('DELETE FROM users WHERE id = $1', [req.params.id]);
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: String(e.message) });
    }
  });
}

// ── middleware ────────────────────────────────────────────────────────────────
export function requireAuth() {
  return async (req, res, next) => {
    const token = req.headers['x-auth-token'] || req.query.token;
    if (!token) return res.redirect('/login');
    const { rows: sessions } = await query('SELECT * FROM sessions WHERE token = $1', [token]);
    if (!sessions[0]) return res.redirect('/login');
    const { rows: users } = await query('SELECT * FROM users WHERE id = $1', [sessions[0].user_id]);
    if (!users[0]) return res.redirect('/login');
    req.user = users[0];
    next();
  };
}

export function requireAdmin() {
  return async (req, res, next) => {
    const token = req.headers['x-auth-token'] || req.query.token;
    if (!token) return res.status(401).json({ error: 'Не авторизован' });
    const { rows: sessions } = await query('SELECT * FROM sessions WHERE token = $1', [token]);
    if (!sessions[0]) return res.status(401).json({ error: 'Не авторизован' });
    const { rows: users } = await query('SELECT * FROM users WHERE id = $1', [sessions[0].user_id]);
    if (!users[0] || users[0].role !== 'admin') return res.status(403).json({ error: 'Нет доступа' });
    req.user = users[0];
    next();
  };
}
