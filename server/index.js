import express from 'express';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { readFileSync, existsSync } from 'fs';
import { getDb } from './db.js';
import './seed.js';
import { setupAuth, requireAuth, requireAdmin } from './auth.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const publicDir = join(__dirname, '..', 'public');
const port = Number(process.env.PORT) || 19080;

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use((req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});

// ----- Static files -----
app.use(express.static(publicDir, { index: false }));
// Явная раздача логотипа (на случай кэша)
app.get('/logo.png', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.sendFile(join(publicDir, 'logo.png'));
});

// Auth setup
setupAuth(app, getDb);

// Pretty URLs
app.get('/', (req, res) => res.sendFile(join(publicDir, 'index.html')));
app.get('/login', (req, res) => res.sendFile(join(publicDir, 'login.html')));
app.get('/dashboard', (req, res) => res.sendFile(join(publicDir, 'dashboard.html')));
app.get('/admin', (req, res) => res.sendFile(join(publicDir, 'admin.html')));
app.get('/profile', (req, res) => res.sendFile(join(publicDir, 'profile.html')));
app.get('/training', (req, res) => res.sendFile(join(publicDir, 'education.html')));
app.get('/education', (req, res) => res.sendFile(join(publicDir, 'education.html')));
app.get('/cases', (req, res) => res.sendFile(join(publicDir, 'cases.html')));
app.get('/chat', (req, res) => res.sendFile(join(publicDir, 'chat.html')));

// ----- API -----
const db = () => getDb();

// Departments
app.get('/api/departments', (req, res) => {
  try {
    const rows = db().prepare('SELECT name FROM departments ORDER BY id').all();
    res.json(rows.map(r => r.name));
  } catch (e) {
    res.status(500).json({ error: String(e.message) });
  }
});

app.post('/api/departments', (req, res) => {
  try {
    const name = (req.body?.name || '').trim();
    if (!name) return res.status(400).json({ error: 'name required' });
    db().prepare('INSERT OR IGNORE INTO departments (name) VALUES (?)').run(name);
    const rows = db().prepare('SELECT name FROM departments ORDER BY id').all();
    res.json(rows.map(r => r.name));
  } catch (e) {
    res.status(500).json({ error: String(e.message) });
  }
});

app.put('/api/departments', (req, res) => {
  try {
    const names = Array.isArray(req.body) ? req.body : [];
    db().prepare('DELETE FROM departments').run();
    const ins = db().prepare('INSERT INTO departments (name) VALUES (?)');
    names.forEach(n => { if (String(n).trim()) ins.run(String(n).trim()); });
    const rows = db().prepare('SELECT name FROM departments ORDER BY id').all();
    res.json(rows.map(r => r.name));
  } catch (e) {
    res.status(500).json({ error: String(e.message) });
  }
});

app.delete('/api/departments/:name', (req, res) => {
  try {
    const name = decodeURIComponent(req.params.name || '');
    db().prepare('DELETE FROM departments WHERE name = ?').run(name);
    const rows = db().prepare('SELECT name FROM departments ORDER BY id').all();
    res.json(rows.map(r => r.name));
  } catch (e) {
    res.status(500).json({ error: String(e.message) });
  }
});

// Cases
app.get('/api/cases', (req, res) => {
  try {
    const rows = db().prepare('SELECT id, data FROM cases ORDER BY id').all();
    res.json(rows.map(r => ({ id: r.id, ...JSON.parse(r.data || '{}') })));
  } catch (e) {
    res.status(500).json({ error: String(e.message) });
  }
});

app.put('/api/cases', (req, res) => {
  try {
    const list = Array.isArray(req.body) ? req.body : [];
    db().prepare('DELETE FROM cases').run();
    const ins = db().prepare('INSERT INTO cases (id, data) VALUES (?, ?)');
    list.forEach(c => { const id = (c.id || 'case_new').trim().replace(/\s+/g, '_'); ins.run(id, JSON.stringify(c)); });
    const rows = db().prepare('SELECT id, data FROM cases ORDER BY id').all();
    res.json(rows.map(r => ({ id: r.id, ...JSON.parse(r.data || '{}') })));
  } catch (e) {
    res.status(500).json({ error: String(e.message) });
  }
});

app.post('/api/cases', (req, res) => {
  try {
    const body = req.body || {};
    const id = (body.id || 'case_new').trim().replace(/\s+/g, '_');
    const data = JSON.stringify(body);
    db().prepare('INSERT OR REPLACE INTO cases (id, data) VALUES (?, ?)').run(id, data);
    const rows = db().prepare('SELECT id, data FROM cases ORDER BY id').all();
    res.json(rows.map(r => ({ id: r.id, ...JSON.parse(r.data || '{}') })));
  } catch (e) {
    res.status(500).json({ error: String(e.message) });
  }
});

app.put('/api/cases/:id', (req, res) => {
  try {
    const id = decodeURIComponent(req.params.id || '');
    const body = req.body || {};
    body.id = id;
    const data = JSON.stringify(body);
    db().prepare('INSERT OR REPLACE INTO cases (id, data) VALUES (?, ?)').run(id, data);
    res.json({ id, ...body });
  } catch (e) {
    res.status(500).json({ error: String(e.message) });
  }
});

app.delete('/api/cases/:id', (req, res) => {
  try {
    const id = decodeURIComponent(req.params.id || '');
    db().prepare('DELETE FROM cases WHERE id = ?').run(id);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: String(e.message) });
  }
});

// Prompts
app.get('/api/prompts', (req, res) => {
  try {
    let rows = db().prepare('SELECT id, data FROM prompts ORDER BY id').all();
    // If DB has fewer than 10 prompts, load from JSON library directly
    if (rows.length < 10) {
      const candidates = [
        join(__dirname, '..', 'prompt-library.json'),
        join(process.cwd(), 'prompt-library.json'),
      ];
      const libPath = candidates.find(p => existsSync(p));
      if (libPath) {
        const data = JSON.parse(readFileSync(libPath, 'utf8'));
        const flat = [];
        data.categories.forEach(cat => {
          cat.prompts.forEach(p => {
            flat.push({ id: cat.id + '_' + p.id, sectionTitle: cat.name, sectionSubtitle: (cat.description || '').replace(/\.$/, ''), title: p.title, meta: (p.description || '').replace(/\.$/, ''), text: p.prompt || '', result: (p.result || '').replace(/\.$/, '') });
          });
        });
        db().prepare('DELETE FROM prompts').run();
        const ins = db().prepare('INSERT INTO prompts (id, data) VALUES (?, ?)');
        flat.forEach(p => ins.run(p.id, JSON.stringify(p)));
        return res.json(flat);
      }
    }
    res.json(rows.map(r => ({ id: r.id, ...JSON.parse(r.data || '{}') })));
  } catch (e) {
    res.status(500).json({ error: String(e.message) });
  }
});

app.put('/api/prompts', (req, res) => {
  try {
    const list = Array.isArray(req.body) ? req.body : [];
    db().prepare('DELETE FROM prompts').run();
    const ins = db().prepare('INSERT INTO prompts (id, data) VALUES (?, ?)');
    list.forEach(p => { const id = (p.id || 'prompt_new').trim(); ins.run(id, JSON.stringify(p)); });
    const rows = db().prepare('SELECT id, data FROM prompts ORDER BY id').all();
    res.json(rows.map(r => ({ id: r.id, ...JSON.parse(r.data || '{}') })));
  } catch (e) {
    res.status(500).json({ error: String(e.message) });
  }
});

app.post('/api/prompts', (req, res) => {
  try {
    const body = req.body || {};
    const id = (body.id || 'prompt_new').trim();
    const data = JSON.stringify(body);
    db().prepare('INSERT OR REPLACE INTO prompts (id, data) VALUES (?, ?)').run(id, data);
    const rows = db().prepare('SELECT id, data FROM prompts ORDER BY id').all();
    res.json(rows.map(r => ({ id: r.id, ...JSON.parse(r.data || '{}') })));
  } catch (e) {
    res.status(500).json({ error: String(e.message) });
  }
});

app.delete('/api/prompts/:id', (req, res) => {
  try {
    const id = decodeURIComponent(req.params.id || '');
    db().prepare('DELETE FROM prompts WHERE id = ?').run(id);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: String(e.message) });
  }
});

// Tools
app.get('/api/tools', (req, res) => {
  try {
    const rows = db().prepare('SELECT id, data FROM tools ORDER BY id').all();
    res.json(rows.map(r => ({ id: r.id, ...JSON.parse(r.data || '{}') })));
  } catch (e) {
    res.status(500).json({ error: String(e.message) });
  }
});

app.put('/api/tools', (req, res) => {
  try {
    const list = Array.isArray(req.body) ? req.body : [];
    db().prepare('DELETE FROM tools').run();
    const ins = db().prepare('INSERT INTO tools (id, data) VALUES (?, ?)');
    list.forEach(t => { const id = (t.id || 'tool_new').trim(); ins.run(id, JSON.stringify(t)); });
    const rows = db().prepare('SELECT id, data FROM tools ORDER BY id').all();
    res.json(rows.map(r => ({ id: r.id, ...JSON.parse(r.data || '{}') })));
  } catch (e) {
    res.status(500).json({ error: String(e.message) });
  }
});

app.post('/api/tools', (req, res) => {
  try {
    const body = req.body || {};
    const id = (body.id || 'tool_new').trim();
    const data = JSON.stringify(body);
    db().prepare('INSERT OR REPLACE INTO tools (id, data) VALUES (?, ?)').run(id, data);
    const rows = db().prepare('SELECT id, data FROM tools ORDER BY id').all();
    res.json(rows.map(r => ({ id: r.id, ...JSON.parse(r.data || '{}') })));
  } catch (e) {
    res.status(500).json({ error: String(e.message) });
  }
});

app.delete('/api/tools/:id', (req, res) => {
  try {
    const id = decodeURIComponent(req.params.id || '');
    db().prepare('DELETE FROM tools WHERE id = ?').run(id);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: String(e.message) });
  }
});

// Tasks (dashboard)
app.get('/api/tasks', (req, res) => {
  try {
    const rows = db().prepare('SELECT id, data FROM tasks ORDER BY id').all();
    res.json(rows.map(r => ({ id: r.id, ...JSON.parse(r.data || '{}') })));
  } catch (e) {
    res.status(500).json({ error: String(e.message) });
  }
});

app.put('/api/tasks', (req, res) => {
  try {
    const list = Array.isArray(req.body) ? req.body : [];
    db().prepare('DELETE FROM tasks').run();
    const ins = db().prepare('INSERT INTO tasks (id, data) VALUES (?, ?)');
    list.forEach(t => { const id = (t.id || 't_new').trim(); ins.run(id, JSON.stringify(t)); });
    const rows = db().prepare('SELECT id, data FROM tasks ORDER BY id').all();
    res.json(rows.map(r => ({ id: r.id, ...JSON.parse(r.data || '{}') })));
  } catch (e) {
    res.status(500).json({ error: String(e.message) });
  }
});

app.post('/api/tasks', (req, res) => {
  try {
    const body = req.body || {};
    const id = (body.id || 't_new').trim();
    const data = JSON.stringify(body);
    db().prepare('INSERT OR REPLACE INTO tasks (id, data) VALUES (?, ?)').run(id, data);
    const rows = db().prepare('SELECT id, data FROM tasks ORDER BY id').all();
    res.json(rows.map(r => ({ id: r.id, ...JSON.parse(r.data || '{}') })));
  } catch (e) {
    res.status(500).json({ error: String(e.message) });
  }
});

app.delete('/api/tasks/:id', (req, res) => {
  try {
    const id = decodeURIComponent(req.params.id || '');
    db().prepare('DELETE FROM tasks WHERE id = ?').run(id);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: String(e.message) });
  }
});

// Single-item upserts
app.put('/api/prompts/:id', (req, res) => {
  try {
    const id = decodeURIComponent(req.params.id || '');
    const body = req.body || {};
    body.id = id;
    const data = JSON.stringify(body);
    db().prepare('INSERT OR REPLACE INTO prompts (id, data) VALUES (?, ?)').run(id, data);
    res.json({ id, ...body });
  } catch (e) {
    res.status(500).json({ error: String(e.message) });
  }
});

app.put('/api/tools/:id', (req, res) => {
  try {
    const id = decodeURIComponent(req.params.id || '');
    const body = req.body || {};
    body.id = id;
    const data = JSON.stringify(body);
    db().prepare('INSERT OR REPLACE INTO tools (id, data) VALUES (?, ?)').run(id, data);
    res.json({ id, ...body });
  } catch (e) {
    res.status(500).json({ error: String(e.message) });
  }
});

app.put('/api/tasks/:id', (req, res) => {
  try {
    const id = decodeURIComponent(req.params.id || '');
    const body = req.body || {};
    body.id = id;
    const data = JSON.stringify(body);
    db().prepare('INSERT OR REPLACE INTO tasks (id, data) VALUES (?, ?)').run(id, data);
    res.json({ id, ...body });
  } catch (e) {
    res.status(500).json({ error: String(e.message) });
  }
});

// Analytics: kv store for dashboard dataset (ui_events, case_used, prompt_used, tool_used, feedback_tickets, access_requests, task_events, headcount)
app.get('/api/analytics/dataset', (req, res) => {
  try {
    const kv = db().prepare('SELECT key, value FROM kv').all();
    const out = {};
    kv.forEach(({ key, value }) => { out[key] = value ? JSON.parse(value) : null; });
    const events = db().prepare('SELECT timestamp, event_type, payload FROM ui_events ORDER BY timestamp').all();
    out.ui = events.map(e => ({ timestamp: e.timestamp, event_type: e.event_type, ...JSON.parse(e.payload || '{}') }));
    res.json(out);
  } catch (e) {
    res.status(500).json({ error: String(e.message) });
  }
});

app.post('/api/analytics/kv', (req, res) => {
  try {
    const { key, value } = req.body || {};
    if (!key) return res.status(400).json({ error: 'key required' });
    db().prepare('INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)').run(key, JSON.stringify(value));
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: String(e.message) });
  }
});

app.post('/api/analytics/events', (req, res) => {
  try {
    const list = Array.isArray(req.body) ? req.body : (req.body?.events ? req.body.events : [req.body]);
    const ins = db().prepare('INSERT INTO ui_events (timestamp, event_type, payload) VALUES (?, ?, ?)');
    for (const ev of list) {
      const ts = ev.timestamp || new Date().toISOString();
      const type = ev.event_type || '';
      const payload = JSON.stringify(ev);
      ins.run(ts, type, payload);
    }
    res.json({ ok: true, count: list.length });
  } catch (e) {
    res.status(500).json({ error: String(e.message) });
  }
});

// Speaker questions
app.get('/api/speaker-questions', (req, res) => {
  try {
    const rows = db().prepare('SELECT * FROM speaker_questions ORDER BY created_at DESC').all();
    res.json(rows);
  } catch (e) { res.status(500).json({ error: String(e.message) }); }
});

app.post('/api/speaker-questions', (req, res) => {
  try {
    const { speaker, first_name, last_name, telegram, question } = req.body || {};
    if (!speaker || !first_name || !last_name || !telegram || !question) {
      return res.status(400).json({ error: 'All fields are required' });
    }
    const stmt = db().prepare('INSERT INTO speaker_questions (speaker, first_name, last_name, telegram, question) VALUES (?, ?, ?, ?, ?)');
    stmt.run(speaker, first_name, last_name, telegram, question);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: String(e.message) }); }
});

app.delete('/api/speaker-questions/:id', (req, res) => {
  try {
    db().prepare('DELETE FROM speaker_questions WHERE id = ?').run(req.params.id);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: String(e.message) }); }
});

// Health
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

// Fallback SPA: any other path that looks like a page
app.get('/dashboard.html', (req, res) => res.sendFile(join(publicDir, 'dashboard.html')));
app.get('/admin.html', (req, res) => res.sendFile(join(publicDir, 'admin.html')));
app.get('/profile.html', (req, res) => res.sendFile(join(publicDir, 'profile.html')));

app.listen(port, () => {
  console.log(`MIK AI Platform listening on http://localhost:${port}`);
});
