import express from 'express';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { initSchema, query } from './db.js';
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
app.get('/logo.png', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.sendFile(join(publicDir, 'logo.png'));
});

// ----- Init DB and start -----
async function start() {
  await initSchema();
  await setupAuth(app);
  await import('./seed.js');

  // Pretty URLs
  app.get('/', (req, res) => res.sendFile(join(publicDir, 'index.html')));
  app.get('/index_new', (req, res) => res.sendFile(join(publicDir, 'index_new.html')));
  app.get('/login', (req, res) => res.sendFile(join(publicDir, 'login.html')));
  app.get('/dashboard', (req, res) => res.sendFile(join(publicDir, 'dashboard.html')));
  app.get('/admin', (req, res) => res.sendFile(join(publicDir, 'admin.html')));
  app.get('/profile', (req, res) => res.sendFile(join(publicDir, 'profile.html')));
  app.get('/training', (req, res) => res.sendFile(join(publicDir, 'education.html')));
  app.get('/education', (req, res) => res.sendFile(join(publicDir, 'education.html')));
  app.get('/cases', (req, res) => res.sendFile(join(publicDir, 'cases.html')));
  app.get('/chat', (req, res) => res.sendFile(join(publicDir, 'chat.html')));

  // ----- API -----

  // Departments
  app.get('/api/departments', async (req, res) => {
    try {
      const { rows } = await query('SELECT name FROM departments ORDER BY id');
      res.json(rows.map(r => r.name));
    } catch (e) {
      res.status(500).json({ error: String(e.message) });
    }
  });

  app.post('/api/departments', async (req, res) => {
    try {
      const name = (req.body?.name || '').trim();
      if (!name) return res.status(400).json({ error: 'name required' });
      await query('INSERT INTO departments (name) VALUES ($1) ON CONFLICT DO NOTHING', [name]);
      const { rows } = await query('SELECT name FROM departments ORDER BY id');
      res.json(rows.map(r => r.name));
    } catch (e) {
      res.status(500).json({ error: String(e.message) });
    }
  });

  app.put('/api/departments', async (req, res) => {
    try {
      const names = Array.isArray(req.body) ? req.body : [];
      await query('DELETE FROM departments');
      for (const n of names) {
        if (String(n).trim()) await query('INSERT INTO departments (name) VALUES ($1)', [String(n).trim()]);
      }
      const { rows } = await query('SELECT name FROM departments ORDER BY id');
      res.json(rows.map(r => r.name));
    } catch (e) {
      res.status(500).json({ error: String(e.message) });
    }
  });

  app.delete('/api/departments/:name', async (req, res) => {
    try {
      const name = decodeURIComponent(req.params.name || '');
      await query('DELETE FROM departments WHERE name = $1', [name]);
      const { rows } = await query('SELECT name FROM departments ORDER BY id');
      res.json(rows.map(r => r.name));
    } catch (e) {
      res.status(500).json({ error: String(e.message) });
    }
  });

  // Справочник: категории задач (для кейсов)
  app.get('/api/case-task-categories', async (req, res) => {
    try {
      const { rows } = await query('SELECT name FROM case_task_categories ORDER BY id');
      res.json(rows.map(r => r.name));
    } catch (e) {
      res.status(500).json({ error: String(e.message) });
    }
  });

  app.post('/api/case-task-categories', async (req, res) => {
    try {
      const name = (req.body?.name || '').trim();
      if (!name) return res.status(400).json({ error: 'name required' });
      await query('INSERT INTO case_task_categories (name) VALUES ($1) ON CONFLICT DO NOTHING', [name]);
      const { rows } = await query('SELECT name FROM case_task_categories ORDER BY id');
      res.json(rows.map(r => r.name));
    } catch (e) {
      res.status(500).json({ error: String(e.message) });
    }
  });

  app.put('/api/case-task-categories', async (req, res) => {
    try {
      const names = Array.isArray(req.body) ? req.body : [];
      await query('DELETE FROM case_task_categories');
      for (const n of names) {
        if (String(n).trim()) await query('INSERT INTO case_task_categories (name) VALUES ($1)', [String(n).trim()]);
      }
      const { rows } = await query('SELECT name FROM case_task_categories ORDER BY id');
      res.json(rows.map(r => r.name));
    } catch (e) {
      res.status(500).json({ error: String(e.message) });
    }
  });

  app.delete('/api/case-task-categories/:name', async (req, res) => {
    try {
      const name = decodeURIComponent(req.params.name || '');
      await query('DELETE FROM case_task_categories WHERE name = $1', [name]);
      const { rows } = await query('SELECT name FROM case_task_categories ORDER BY id');
      res.json(rows.map(r => r.name));
    } catch (e) {
      res.status(500).json({ error: String(e.message) });
    }
  });

  // Cases
  app.get('/api/cases', async (req, res) => {
    try {
      const { rows } = await query('SELECT id, data FROM cases ORDER BY id');
      const all = rows.map(r => ({ id: r.id, ...JSON.parse(r.data || '{}') }));
      // ?all=true is reserved for admin — without it drafts are hidden from public
      if (req.query.all === 'true') {
        res.json(all);
      } else {
        res.json(all.filter(c => c.maturity !== 'draft'));
      }
    } catch (e) {
      res.status(500).json({ error: String(e.message) });
    }
  });

  app.put('/api/cases', async (req, res) => {
    try {
      const list = Array.isArray(req.body) ? req.body : [];
      await query('DELETE FROM cases');
      for (const c of list) {
        const id = (c.id || 'case_new').trim().replace(/\s+/g, '_');
        await query('INSERT INTO cases (id, data) VALUES ($1, $2)', [id, JSON.stringify(c)]);
      }
      const { rows } = await query('SELECT id, data FROM cases ORDER BY id');
      res.json(rows.map(r => ({ id: r.id, ...JSON.parse(r.data || '{}') })));
    } catch (e) {
      res.status(500).json({ error: String(e.message) });
    }
  });

  app.post('/api/cases', async (req, res) => {
    try {
      const body = req.body || {};
      const id = (body.id || 'case_new').trim().replace(/\s+/g, '_');
      const data = JSON.stringify(body);
      await query('INSERT INTO cases (id, data) VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET data = $2', [id, data]);
      const { rows } = await query('SELECT id, data FROM cases ORDER BY id');
      res.json(rows.map(r => ({ id: r.id, ...JSON.parse(r.data || '{}') })));
    } catch (e) {
      res.status(500).json({ error: String(e.message) });
    }
  });

  app.put('/api/cases/:id', async (req, res) => {
    try {
      const id = decodeURIComponent(req.params.id || '');
      const body = req.body || {};
      body.id = id;
      const data = JSON.stringify(body);
      await query('INSERT INTO cases (id, data) VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET data = $2', [id, data]);
      res.json({ id, ...body });
    } catch (e) {
      res.status(500).json({ error: String(e.message) });
    }
  });

  app.delete('/api/cases/:id', async (req, res) => {
    try {
      const id = decodeURIComponent(req.params.id || '');
      await query('DELETE FROM cases WHERE id = $1', [id]);
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: String(e.message) });
    }
  });

  // Prompts
  app.get('/api/prompts', async (req, res) => {
    try {
      const { rows } = await query('SELECT id, data FROM prompts ORDER BY id');
      res.json(rows.map(r => ({ id: r.id, ...JSON.parse(r.data || '{}') })));
    } catch (e) {
      res.status(500).json({ error: String(e.message) });
    }
  });

  app.put('/api/prompts', async (req, res) => {
    try {
      const list = Array.isArray(req.body) ? req.body : [];
      await query('DELETE FROM prompts');
      for (const p of list) {
        const id = (p.id || 'prompt_new').trim();
        await query('INSERT INTO prompts (id, data) VALUES ($1, $2)', [id, JSON.stringify(p)]);
      }
      const { rows } = await query('SELECT id, data FROM prompts ORDER BY id');
      res.json(rows.map(r => ({ id: r.id, ...JSON.parse(r.data || '{}') })));
    } catch (e) {
      res.status(500).json({ error: String(e.message) });
    }
  });

  app.post('/api/prompts', async (req, res) => {
    try {
      const body = req.body || {};
      const id = (body.id || 'prompt_new').trim();
      const data = JSON.stringify(body);
      await query('INSERT INTO prompts (id, data) VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET data = $2', [id, data]);
      const { rows } = await query('SELECT id, data FROM prompts ORDER BY id');
      res.json(rows.map(r => ({ id: r.id, ...JSON.parse(r.data || '{}') })));
    } catch (e) {
      res.status(500).json({ error: String(e.message) });
    }
  });

  app.put('/api/prompts/:id', async (req, res) => {
    try {
      const id = decodeURIComponent(req.params.id || '');
      const body = req.body || {};
      body.id = id;
      const data = JSON.stringify(body);
      await query('INSERT INTO prompts (id, data) VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET data = $2', [id, data]);
      res.json({ id, ...body });
    } catch (e) {
      res.status(500).json({ error: String(e.message) });
    }
  });

  app.delete('/api/prompts/:id', async (req, res) => {
    try {
      const id = decodeURIComponent(req.params.id || '');
      await query('DELETE FROM prompts WHERE id = $1', [id]);
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: String(e.message) });
    }
  });

  // Tools
  app.get('/api/tools', async (req, res) => {
    try {
      const { rows } = await query('SELECT id, data FROM tools ORDER BY id');
      res.json(rows.map(r => ({ id: r.id, ...JSON.parse(r.data || '{}') })));
    } catch (e) {
      res.status(500).json({ error: String(e.message) });
    }
  });

  app.put('/api/tools', async (req, res) => {
    try {
      const list = Array.isArray(req.body) ? req.body : [];
      await query('DELETE FROM tools');
      for (const t of list) {
        const id = (t.id || 'tool_new').trim();
        await query('INSERT INTO tools (id, data) VALUES ($1, $2)', [id, JSON.stringify(t)]);
      }
      const { rows } = await query('SELECT id, data FROM tools ORDER BY id');
      res.json(rows.map(r => ({ id: r.id, ...JSON.parse(r.data || '{}') })));
    } catch (e) {
      res.status(500).json({ error: String(e.message) });
    }
  });

  app.post('/api/tools', async (req, res) => {
    try {
      const body = req.body || {};
      const id = (body.id || 'tool_new').trim();
      const data = JSON.stringify(body);
      await query('INSERT INTO tools (id, data) VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET data = $2', [id, data]);
      const { rows } = await query('SELECT id, data FROM tools ORDER BY id');
      res.json(rows.map(r => ({ id: r.id, ...JSON.parse(r.data || '{}') })));
    } catch (e) {
      res.status(500).json({ error: String(e.message) });
    }
  });

  app.put('/api/tools/:id', async (req, res) => {
    try {
      const id = decodeURIComponent(req.params.id || '');
      const body = req.body || {};
      body.id = id;
      const data = JSON.stringify(body);
      await query('INSERT INTO tools (id, data) VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET data = $2', [id, data]);
      res.json({ id, ...body });
    } catch (e) {
      res.status(500).json({ error: String(e.message) });
    }
  });

  app.delete('/api/tools/:id', async (req, res) => {
    try {
      const id = decodeURIComponent(req.params.id || '');
      await query('DELETE FROM tools WHERE id = $1', [id]);
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: String(e.message) });
    }
  });

  // Tasks
  app.get('/api/tasks', async (req, res) => {
    try {
      const { rows } = await query('SELECT id, data FROM tasks ORDER BY id');
      res.json(rows.map(r => ({ id: r.id, ...JSON.parse(r.data || '{}') })));
    } catch (e) {
      res.status(500).json({ error: String(e.message) });
    }
  });

  app.put('/api/tasks', async (req, res) => {
    try {
      const list = Array.isArray(req.body) ? req.body : [];
      await query('DELETE FROM tasks');
      for (const t of list) {
        const id = (t.id || 't_new').trim();
        await query('INSERT INTO tasks (id, data) VALUES ($1, $2)', [id, JSON.stringify(t)]);
      }
      const { rows } = await query('SELECT id, data FROM tasks ORDER BY id');
      res.json(rows.map(r => ({ id: r.id, ...JSON.parse(r.data || '{}') })));
    } catch (e) {
      res.status(500).json({ error: String(e.message) });
    }
  });

  app.post('/api/tasks', async (req, res) => {
    try {
      const body = req.body || {};
      const id = (body.id || 't_new').trim();
      const data = JSON.stringify(body);
      await query('INSERT INTO tasks (id, data) VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET data = $2', [id, data]);
      const { rows } = await query('SELECT id, data FROM tasks ORDER BY id');
      res.json(rows.map(r => ({ id: r.id, ...JSON.parse(r.data || '{}') })));
    } catch (e) {
      res.status(500).json({ error: String(e.message) });
    }
  });

  app.put('/api/tasks/:id', async (req, res) => {
    try {
      const id = decodeURIComponent(req.params.id || '');
      const body = req.body || {};
      body.id = id;
      const data = JSON.stringify(body);
      await query('INSERT INTO tasks (id, data) VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET data = $2', [id, data]);
      res.json({ id, ...body });
    } catch (e) {
      res.status(500).json({ error: String(e.message) });
    }
  });

  app.delete('/api/tasks/:id', async (req, res) => {
    try {
      const id = decodeURIComponent(req.params.id || '');
      await query('DELETE FROM tasks WHERE id = $1', [id]);
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: String(e.message) });
    }
  });

  // Analytics
  app.get('/api/analytics/dataset', async (req, res) => {
    try {
      const { rows: kv } = await query('SELECT key, value FROM kv');
      const out = {};
      kv.forEach(({ key, value }) => { out[key] = value ? JSON.parse(value) : null; });
      const { rows: events } = await query('SELECT timestamp, event_type, payload FROM ui_events ORDER BY timestamp');
      out.ui = events.map(e => ({ timestamp: e.timestamp, event_type: e.event_type, ...JSON.parse(e.payload || '{}') }));
      res.json(out);
    } catch (e) {
      res.status(500).json({ error: String(e.message) });
    }
  });

  app.post('/api/analytics/kv', async (req, res) => {
    try {
      const { key, value } = req.body || {};
      if (!key) return res.status(400).json({ error: 'key required' });
      await query('INSERT INTO kv (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = $2', [key, JSON.stringify(value)]);
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: String(e.message) });
    }
  });

  app.post('/api/analytics/events', async (req, res) => {
    try {
      const list = Array.isArray(req.body) ? req.body : (req.body?.events ? req.body.events : [req.body]);
      for (const ev of list) {
        const ts = ev.timestamp || new Date().toISOString();
        const type = ev.event_type || '';
        const payload = JSON.stringify(ev);
        await query('INSERT INTO ui_events (timestamp, event_type, payload) VALUES ($1, $2, $3)', [ts, type, payload]);
      }
      res.json({ ok: true, count: list.length });
    } catch (e) {
      res.status(500).json({ error: String(e.message) });
    }
  });

  // Browser config
  app.get('/api/browser-config', async (req, res) => {
    try {
      const { rows } = await query("SELECT value FROM kv WHERE key = 'browser_config'");
      res.json(rows.length ? JSON.parse(rows[0].value) : {});
    } catch (e) {
      res.status(500).json({ error: String(e.message) });
    }
  });

  app.post('/api/browser-config', requireAdmin(), async (req, res) => {
    try {
      const data = JSON.stringify(req.body || {});
      await query("INSERT INTO kv (key, value) VALUES ('browser_config', $1) ON CONFLICT (key) DO UPDATE SET value = $1", [data]);
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: String(e.message) });
    }
  });

  // Instructions
  app.get('/api/instructions', async (req, res) => {
    try {
      const { rows } = await query('SELECT id, data FROM instructions ORDER BY id');
      const all = rows.map(r => ({ id: r.id, ...JSON.parse(r.data || '{}') }));
      res.json(all);
    } catch (e) {
      res.status(500).json({ error: String(e.message) });
    }
  });

  app.put('/api/instructions/:id', async (req, res) => {
    try {
      const id = decodeURIComponent(req.params.id || '');
      if (!id) return res.status(400).json({ error: 'id required' });
      const data = JSON.stringify(req.body || {});
      await query(
        'INSERT INTO instructions (id, data) VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET data = $2',
        [id, data]
      );
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: String(e.message) });
    }
  });

  app.delete('/api/instructions/:id', async (req, res) => {
    try {
      const id = decodeURIComponent(req.params.id || '');
      await query('DELETE FROM instructions WHERE id = $1', [id]);
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: String(e.message) });
    }
  });

  // Video Categories
  app.get('/api/video-categories', async (req, res) => {
    try {
      const { rows } = await query('SELECT name, color FROM video_categories ORDER BY id');
      res.json(rows);
    } catch (e) {
      res.status(500).json({ error: String(e.message) });
    }
  });

  app.post('/api/video-categories', async (req, res) => {
    try {
      const name = (req.body?.name || '').trim();
      const color = (req.body?.color || '#6B9FFF').trim();
      if (!name) return res.status(400).json({ error: 'name required' });
      await query('INSERT INTO video_categories (name, color) VALUES ($1, $2) ON CONFLICT (name) DO UPDATE SET color = $2', [name, color]);
      const { rows } = await query('SELECT name, color FROM video_categories ORDER BY id');
      res.json(rows);
    } catch (e) {
      res.status(500).json({ error: String(e.message) });
    }
  });

  app.delete('/api/video-categories/:name', async (req, res) => {
    try {
      const name = decodeURIComponent(req.params.name || '');
      await query('DELETE FROM video_categories WHERE name = $1', [name]);
      const { rows } = await query('SELECT name, color FROM video_categories ORDER BY id');
      res.json(rows);
    } catch (e) {
      res.status(500).json({ error: String(e.message) });
    }
  });

  // Videos (education page)
  app.get('/api/videos', async (req, res) => {
    try {
      const { rows } = await query('SELECT id, data FROM videos ORDER BY id');
      res.json(rows.map(r => ({ id: r.id, ...JSON.parse(r.data || '{}') })));
    } catch (e) {
      res.status(500).json({ error: String(e.message) });
    }
  });

  app.post('/api/videos', async (req, res) => {
    try {
      const body = req.body || {};
      const id = (body.id || 'vid_' + Date.now()).trim().replace(/\s+/g, '_');
      body.id = id;
      const data = JSON.stringify(body);
      await query('INSERT INTO videos (id, data) VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET data = $2', [id, data]);
      const { rows } = await query('SELECT id, data FROM videos ORDER BY id');
      res.json(rows.map(r => ({ id: r.id, ...JSON.parse(r.data || '{}') })));
    } catch (e) {
      res.status(500).json({ error: String(e.message) });
    }
  });

  app.put('/api/videos/:id', async (req, res) => {
    try {
      const id = decodeURIComponent(req.params.id || '');
      const body = req.body || {};
      body.id = id;
      const data = JSON.stringify(body);
      await query('INSERT INTO videos (id, data) VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET data = $2', [id, data]);
      res.json({ id, ...body });
    } catch (e) {
      res.status(500).json({ error: String(e.message) });
    }
  });

  app.delete('/api/videos/:id', async (req, res) => {
    try {
      const id = decodeURIComponent(req.params.id || '');
      await query('DELETE FROM videos WHERE id = $1', [id]);
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: String(e.message) });
    }
  });

  // Speaker questions
  app.get('/api/speaker-questions', async (req, res) => {
    try {
      const { rows } = await query('SELECT * FROM speaker_questions ORDER BY created_at DESC');
      res.json(rows);
    } catch (e) { res.status(500).json({ error: String(e.message) }); }
  });

  app.post('/api/speaker-questions', async (req, res) => {
    try {
      const { speaker, first_name, last_name, telegram, question } = req.body || {};
      if (!speaker || !first_name || !last_name || !telegram || !question) {
        return res.status(400).json({ error: 'All fields are required' });
      }
      await query('INSERT INTO speaker_questions (speaker, first_name, last_name, telegram, question) VALUES ($1, $2, $3, $4, $5)', [speaker, first_name, last_name, telegram, question]);
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: String(e.message) }); }
  });

  app.delete('/api/speaker-questions/:id', async (req, res) => {
    try {
      await query('DELETE FROM speaker_questions WHERE id = $1', [req.params.id]);
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: String(e.message) }); }
  });

  // Health
  app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', time: new Date().toISOString() });
  });

  // Fallback HTML pages
  app.get('/dashboard.html', (req, res) => res.sendFile(join(publicDir, 'dashboard.html')));
  app.get('/admin.html', (req, res) => res.sendFile(join(publicDir, 'admin.html')));
  app.get('/profile.html', (req, res) => res.sendFile(join(publicDir, 'profile.html')));

  app.listen(port, () => {
    console.log(`MIK AI Platform listening on http://localhost:${port}`);
  });
}

start().catch(err => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
