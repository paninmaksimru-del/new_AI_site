// server/kb-routes.js
// All /api/kb/* routes for the Knowledge Base module

import { createReadStream, existsSync } from 'fs';
import { unlink, mkdir } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import multer from 'multer';
import { randomUUID } from 'crypto';
import { query } from './db.js';
import { requireKbAuth, requireAdmin, canReadFile, canWriteFile } from './auth.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const UPLOADS_DIR = join(__dirname, '..', 'data', 'uploads');

// Ensure uploads directory exists
await mkdir(UPLOADS_DIR, { recursive: true });

// ── Multer config ──────────────────────────────────────────────────────────────
const ALLOWED_MIMES = new Set([
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'text/plain',
  'image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'image/tiff',
]);
const MAX_SIZE = 20 * 1024 * 1024; // 20 MB

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename: (req, file, cb) => {
    const ext = file.originalname.split('.').pop().toLowerCase();
    cb(null, `${randomUUID()}.${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: MAX_SIZE },
  fileFilter: (req, file, cb) => {
    if (ALLOWED_MIMES.has(file.mimetype)) cb(null, true);
    else cb(new Error(`Неподдерживаемый тип файла: ${file.mimetype}`));
  },
});

// ── Helper ─────────────────────────────────────────────────────────────────────
async function getVisibleFileIds(userId, userRole) {
  if (userRole === 'admin') return null; // null = no filter (all files)
  const { rows } = await query(`
    SELECT id FROM kb_files WHERE owner_id = $1
    UNION
    SELECT file_id FROM kb_file_permissions WHERE user_id = $1
  `, [userId]);
  return rows.map(r => r.id);
}

// ── Register routes ────────────────────────────────────────────────────────────
export function setupKbRoutes(app) {

  // ── Files ──────────────────────────────────────────────────────────────────

  /** GET /api/kb/files — list files visible to current user */
  app.get('/api/kb/files', requireKbAuth(), async (req, res) => {
    try {
      const { folder_id, search } = req.query;
      const { id: userId, role } = req.user;

      let sql, params;
      if (role === 'admin') {
        sql = `SELECT f.*, u.full_name AS owner_name
               FROM kb_files f LEFT JOIN users u ON u.id = f.owner_id
               WHERE ($1::integer IS NULL OR f.folder_id = $1)
               AND ($2::text IS NULL OR f.original_name ILIKE $2)
               ORDER BY f.created_at DESC`;
        params = [folder_id || null, search ? `%${search}%` : null];
      } else {
        sql = `SELECT DISTINCT f.*, u.full_name AS owner_name
               FROM kb_files f
               LEFT JOIN users u ON u.id = f.owner_id
               LEFT JOIN kb_file_permissions p ON p.file_id = f.id
               WHERE (f.owner_id = $1 OR p.user_id = $1)
               AND ($2::integer IS NULL OR f.folder_id = $2)
               AND ($3::text IS NULL OR f.original_name ILIKE $3)
               ORDER BY f.created_at DESC`;
        params = [userId, folder_id || null, search ? `%${search}%` : null];
      }
      const { rows } = await query(sql, params);
      res.json(rows);
    } catch (e) {
      res.status(500).json({ error: String(e.message) });
    }
  });

  /** POST /api/kb/files — upload file */
  app.post('/api/kb/files', requireKbAuth(), (req, res, next) => {
    if (req.user.role === 'viewer') return res.status(403).json({ error: 'Нет доступа' });
    next();
  }, upload.single('file'), async (req, res) => {
    try {
      if (!req.file) return res.status(400).json({ error: 'Файл не получен' });
      const { folder_id } = req.body;
      const { rows } = await query(
        `INSERT INTO kb_files (original_name, stored_name, mime_type, size_bytes, folder_id, owner_id)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
        [req.file.originalname, req.file.filename, req.file.mimetype,
         req.file.size, folder_id || null, req.user.id]
      );
      res.status(201).json(rows[0]);
    } catch (e) {
      res.status(500).json({ error: String(e.message) });
    }
  });

  /** GET /api/kb/files/:id — file metadata */
  app.get('/api/kb/files/:id', requireKbAuth(), async (req, res) => {
    try {
      const fileId = parseInt(req.params.id);
      const { rows } = await query(
        'SELECT f.*, u.full_name AS owner_name FROM kb_files f LEFT JOIN users u ON u.id = f.owner_id WHERE f.id = $1',
        [fileId]
      );
      if (!rows[0]) return res.status(404).json({ error: 'Файл не найден' });
      const ok = await canReadFile(req.user.id, req.user.role, fileId);
      if (!ok) return res.status(403).json({ error: 'Нет доступа' });
      res.json(rows[0]);
    } catch (e) {
      res.status(500).json({ error: String(e.message) });
    }
  });

  /** GET /api/kb/files/:id/download — stream raw file */
  app.get('/api/kb/files/:id/download', requireKbAuth(), async (req, res) => {
    try {
      const fileId = parseInt(req.params.id);
      const { rows } = await query('SELECT * FROM kb_files WHERE id = $1', [fileId]);
      if (!rows[0]) return res.status(404).json({ error: 'Файл не найден' });
      const ok = await canReadFile(req.user.id, req.user.role, fileId);
      if (!ok) return res.status(403).json({ error: 'Нет доступа' });
      const filePath = join(UPLOADS_DIR, rows[0].stored_name);
      if (!existsSync(filePath)) return res.status(404).json({ error: 'Файл не найден на диске' });
      res.setHeader('Content-Type', rows[0].mime_type);
      res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(rows[0].original_name)}"`);
      createReadStream(filePath).pipe(res);
    } catch (e) {
      res.status(500).json({ error: String(e.message) });
    }
  });

  /** GET /api/kb/files/:id/status — OCR status */
  app.get('/api/kb/files/:id/status', requireKbAuth(), async (req, res) => {
    try {
      const fileId = parseInt(req.params.id);
      const { rows } = await query('SELECT id, ocr_status, ocr_error FROM kb_files WHERE id = $1', [fileId]);
      if (!rows[0]) return res.status(404).json({ error: 'Файл не найден' });
      const ok = await canReadFile(req.user.id, req.user.role, fileId);
      if (!ok) return res.status(403).json({ error: 'Нет доступа' });
      res.json({ id: rows[0].id, ocr_status: rows[0].ocr_status, ocr_error: rows[0].ocr_error });
    } catch (e) {
      res.status(500).json({ error: String(e.message) });
    }
  });

  /** DELETE /api/kb/files/:id */
  app.delete('/api/kb/files/:id', requireKbAuth(), async (req, res) => {
    try {
      const fileId = parseInt(req.params.id);
      const { rows } = await query('SELECT * FROM kb_files WHERE id = $1', [fileId]);
      if (!rows[0]) return res.status(404).json({ error: 'Файл не найден' });
      if (!canWriteFile(req.user.role, rows[0], req.user.id)) return res.status(403).json({ error: 'Нет доступа' });
      // Delete from disk
      const filePath = join(UPLOADS_DIR, rows[0].stored_name);
      try { await unlink(filePath); } catch (_) {}
      // Cascade deletes chunks + permissions via FK
      await query('DELETE FROM kb_files WHERE id = $1', [fileId]);
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: String(e.message) });
    }
  });

  /** PATCH /api/kb/files/:id — rename or move */
  app.patch('/api/kb/files/:id', requireKbAuth(), async (req, res) => {
    try {
      const fileId = parseInt(req.params.id);
      const { rows } = await query('SELECT * FROM kb_files WHERE id = $1', [fileId]);
      if (!rows[0]) return res.status(404).json({ error: 'Файл не найден' });
      if (!canWriteFile(req.user.role, rows[0], req.user.id)) return res.status(403).json({ error: 'Нет доступа' });
      const { original_name, folder_id } = req.body;
      const updates = [];
      const values = [];
      let i = 1;
      if (original_name !== undefined) { updates.push(`original_name = $${i++}`); values.push(original_name.trim()); }
      if (folder_id !== undefined) { updates.push(`folder_id = $${i++}`); values.push(folder_id || null); }
      if (updates.length === 0) return res.json({ ok: true });
      updates.push(`updated_at = NOW()`);
      values.push(fileId);
      await query(`UPDATE kb_files SET ${updates.join(', ')} WHERE id = $${i}`, values);
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: String(e.message) });
    }
  });

  // ── File Permissions ───────────────────────────────────────────────────────

  /** GET /api/kb/files/:id/permissions */
  app.get('/api/kb/files/:id/permissions', requireKbAuth(), async (req, res) => {
    try {
      const fileId = parseInt(req.params.id);
      const { rows: files } = await query('SELECT * FROM kb_files WHERE id = $1', [fileId]);
      if (!files[0]) return res.status(404).json({ error: 'Файл не найден' });
      if (!canWriteFile(req.user.role, files[0], req.user.id)) return res.status(403).json({ error: 'Нет доступа' });
      const { rows } = await query(
        `SELECT p.*, u.full_name, u.login FROM kb_file_permissions p
         LEFT JOIN users u ON u.id = p.user_id WHERE p.file_id = $1`,
        [fileId]
      );
      res.json(rows);
    } catch (e) {
      res.status(500).json({ error: String(e.message) });
    }
  });

  /** POST /api/kb/files/:id/permissions */
  app.post('/api/kb/files/:id/permissions', requireKbAuth(), async (req, res) => {
    try {
      const fileId = parseInt(req.params.id);
      const { rows: files } = await query('SELECT * FROM kb_files WHERE id = $1', [fileId]);
      if (!files[0]) return res.status(404).json({ error: 'Файл не найден' });
      if (!canWriteFile(req.user.role, files[0], req.user.id)) return res.status(403).json({ error: 'Нет доступа' });
      const { user_id, permission = 'view' } = req.body;
      if (!user_id) return res.status(400).json({ error: 'user_id обязателен' });
      await query(
        `INSERT INTO kb_file_permissions (file_id, user_id, permission, granted_by_id)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (file_id, user_id) DO UPDATE SET permission = $3`,
        [fileId, user_id, permission, req.user.id]
      );
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: String(e.message) });
    }
  });

  /** DELETE /api/kb/files/:id/permissions/:userId */
  app.delete('/api/kb/files/:id/permissions/:userId', requireKbAuth(), async (req, res) => {
    try {
      const fileId = parseInt(req.params.id);
      const { rows: files } = await query('SELECT * FROM kb_files WHERE id = $1', [fileId]);
      if (!files[0]) return res.status(404).json({ error: 'Файл не найден' });
      if (!canWriteFile(req.user.role, files[0], req.user.id)) return res.status(403).json({ error: 'Нет доступа' });
      await query('DELETE FROM kb_file_permissions WHERE file_id = $1 AND user_id = $2', [fileId, req.params.userId]);
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: String(e.message) });
    }
  });

  // ── Folders ────────────────────────────────────────────────────────────────

  /** GET /api/kb/folders */
  app.get('/api/kb/folders', requireKbAuth(), async (req, res) => {
    try {
      let rows;
      if (req.user.role === 'admin') {
        ({ rows } = await query('SELECT * FROM kb_folders ORDER BY name'));
      } else {
        ({ rows } = await query('SELECT * FROM kb_folders WHERE owner_id = $1 ORDER BY name', [req.user.id]));
      }
      res.json(rows);
    } catch (e) {
      res.status(500).json({ error: String(e.message) });
    }
  });

  /** POST /api/kb/folders */
  app.post('/api/kb/folders', requireKbAuth(), async (req, res) => {
    try {
      if (req.user.role === 'viewer') return res.status(403).json({ error: 'Нет доступа' });
      const { name, parent_id } = req.body;
      if (!name) return res.status(400).json({ error: 'name обязателен' });
      const { rows } = await query(
        'INSERT INTO kb_folders (name, parent_id, owner_id) VALUES ($1, $2, $3) RETURNING *',
        [name.trim(), parent_id || null, req.user.id]
      );
      res.status(201).json(rows[0]);
    } catch (e) {
      res.status(500).json({ error: String(e.message) });
    }
  });

  /** PATCH /api/kb/folders/:id */
  app.patch('/api/kb/folders/:id', requireKbAuth(), async (req, res) => {
    try {
      const { rows } = await query('SELECT * FROM kb_folders WHERE id = $1', [req.params.id]);
      if (!rows[0]) return res.status(404).json({ error: 'Папка не найдена' });
      if (!canWriteFile(req.user.role, rows[0], req.user.id)) return res.status(403).json({ error: 'Нет доступа' });
      const { name } = req.body;
      if (name) await query('UPDATE kb_folders SET name = $1 WHERE id = $2', [name.trim(), req.params.id]);
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: String(e.message) });
    }
  });

  /** DELETE /api/kb/folders/:id */
  app.delete('/api/kb/folders/:id', requireKbAuth(), async (req, res) => {
    try {
      const { rows } = await query('SELECT * FROM kb_folders WHERE id = $1', [req.params.id]);
      if (!rows[0]) return res.status(404).json({ error: 'Папка не найдена' });
      if (!canWriteFile(req.user.role, rows[0], req.user.id)) return res.status(403).json({ error: 'Нет доступа' });
      await query('DELETE FROM kb_folders WHERE id = $1', [req.params.id]);
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: String(e.message) });
    }
  });

  // ── Search ─────────────────────────────────────────────────────────────────

  /** POST /api/kb/search — vector similarity search */
  app.post('/api/kb/search', requireKbAuth(), async (req, res) => {
    try {
      const { query: searchQuery, file_ids, limit: k = 8 } = req.body;
      if (!searchQuery) return res.status(400).json({ error: 'query обязателен' });

      // Get embedding for the query
      let embedding;
      try {
        const { getEmbedding } = await import('./kb-pipeline.js');
        embedding = await getEmbedding(searchQuery);
      } catch (e) {
        return res.status(503).json({ error: 'Embeddings недоступны: ' + e.message });
      }

      const visibleIds = await getVisibleFileIds(req.user.id, req.user.role);

      let filterSql = '';
      let params = [JSON.stringify(embedding), k];

      if (visibleIds !== null && file_ids) {
        const allowed = file_ids.filter(id => visibleIds.includes(id));
        filterSql = `AND c.file_id = ANY($${params.length + 1}::int[])`;
        params.push(allowed);
      } else if (visibleIds !== null) {
        filterSql = `AND c.file_id = ANY($${params.length + 1}::int[])`;
        params.push(visibleIds);
      } else if (file_ids) {
        filterSql = `AND c.file_id = ANY($${params.length + 1}::int[])`;
        params.push(file_ids);
      }

      const { rows } = await query(`
        SELECT c.id, c.file_id, c.chunk_index, c.content,
               1 - (c.embedding <=> $1::vector) AS score,
               f.original_name
        FROM kb_chunks c
        JOIN kb_files f ON f.id = c.file_id
        WHERE c.embedding IS NOT NULL
        ${filterSql}
        ORDER BY c.embedding <=> $1::vector
        LIMIT $2
      `, params);

      // Filter out dissimilar results (score < 0.25)
      const results = rows.filter(r => r.score >= 0.25);
      res.json(results);
    } catch (e) {
      res.status(500).json({ error: String(e.message) });
    }
  });

  // ── Chat (RAG) ─────────────────────────────────────────────────────────────

  /** GET /api/kb/chats — list user's chat sessions */
  app.get('/api/kb/chats', requireKbAuth(), async (req, res) => {
    try {
      const { rows } = await query(
        'SELECT * FROM kb_chats WHERE user_id = $1 ORDER BY updated_at DESC',
        [req.user.id]
      );
      res.json(rows);
    } catch (e) {
      res.status(500).json({ error: String(e.message) });
    }
  });

  /** GET /api/kb/chats/:id — messages for a session */
  app.get('/api/kb/chats/:id', requireKbAuth(), async (req, res) => {
    try {
      const { rows: chats } = await query('SELECT * FROM kb_chats WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]);
      if (!chats[0]) return res.status(404).json({ error: 'Сессия не найдена' });
      const { rows } = await query('SELECT * FROM kb_messages WHERE chat_id = $1 ORDER BY created_at', [req.params.id]);
      res.json({ chat: chats[0], messages: rows });
    } catch (e) {
      res.status(500).json({ error: String(e.message) });
    }
  });

  /** DELETE /api/kb/chats/:id */
  app.delete('/api/kb/chats/:id', requireKbAuth(), async (req, res) => {
    try {
      await query('DELETE FROM kb_chats WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]);
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: String(e.message) });
    }
  });

  /** POST /api/kb/chat — RAG chat with SSE streaming */
  app.post('/api/kb/chat', requireKbAuth(), async (req, res) => {
    try {
      const { message, chat_id, file_ids } = req.body;
      if (!message) return res.status(400).json({ error: 'message обязателен' });

      const userId = req.user.id;

      // Get or create chat session
      let chatId = chat_id;
      if (!chatId) {
        const title = message.slice(0, 60);
        const { rows } = await query(
          'INSERT INTO kb_chats (user_id, title) VALUES ($1, $2) RETURNING id',
          [userId, title]
        );
        chatId = rows[0].id;
      }

      // Save user message
      await query(
        'INSERT INTO kb_messages (chat_id, role, content) VALUES ($1, $2, $3)',
        [chatId, 'user', message]
      );

      // Try to get RAG context
      let sourcesData = [];
      let contextText = '';
      try {
        const { getEmbedding } = await import('./kb-pipeline.js');
        const embedding = await getEmbedding(message);
        const visibleIds = await getVisibleFileIds(userId, req.user.role);

        let filterSql = '';
        let params = [JSON.stringify(embedding), 8];
        if (visibleIds !== null) {
          filterSql = file_ids
            ? `AND c.file_id = ANY($3::int[])`
            : `AND c.file_id = ANY($3::int[])`;
          params.push(visibleIds.length ? (file_ids ? file_ids.filter(id => visibleIds.includes(id)) : visibleIds) : [-1]);
        } else if (file_ids) {
          filterSql = `AND c.file_id = ANY($3::int[])`;
          params.push(file_ids);
        }

        const { rows: chunks } = await query(`
          SELECT c.id, c.file_id, c.chunk_index, c.content,
                 1 - (c.embedding <=> $1::vector) AS score,
                 f.original_name
          FROM kb_chunks c
          JOIN kb_files f ON f.id = c.file_id
          WHERE c.embedding IS NOT NULL
          ${filterSql}
          ORDER BY c.embedding <=> $1::vector
          LIMIT $2
        `, params);

        const relevant = chunks.filter(c => c.score >= 0.25).slice(0, 5);
        sourcesData = relevant.map(c => ({
          file_id: c.file_id,
          file_name: c.original_name,
          chunk_index: c.chunk_index,
          score: parseFloat(c.score).toFixed(3),
          snippet: c.content.slice(0, 200),
        }));

        if (relevant.length > 0) {
          contextText = relevant
            .map((c, i) => `[${i + 1}] ${c.original_name}:\n${c.content}`)
            .join('\n\n---\n\n');
        }
      } catch (_) {
        // embeddings not available — respond without context
      }

      // Build messages for LLM
      const systemPrompt = contextText
        ? `Ты помощник по работе с базой знаний. Отвечай ТОЛЬКО на основе предоставленных документов. Если ответа нет в документах — скажи об этом. Ссылайся на источник для каждого утверждения.\n\nДокументы:\n\n${contextText}`
        : `Ты помощник по работе с базой знаний. Документы для поиска пока не найдены или не обработаны. Отвечай на основе своих знаний, но предупреди пользователя об отсутствии контекста из документов.`;

      // SSE setup
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.flushHeaders();

      // Send chat_id immediately so frontend can track it
      res.write(`data: ${JSON.stringify({ type: 'chat_id', chat_id: chatId })}\n\n`);

      // Send sources
      if (sourcesData.length > 0) {
        res.write(`data: ${JSON.stringify({ type: 'sources', sources: sourcesData })}\n\n`);
      }

      // Call Claude API with streaming
      const apiKey = process.env.ANTHROPIC_API_KEY;
      if (!apiKey) {
        const fallback = contextText
          ? `На основе найденных документов: ${sourcesData.map(s => s.snippet).join(' / ')}`
          : 'ANTHROPIC_API_KEY не настроен. Чат-бот работает в демо-режиме.';
        res.write(`data: ${JSON.stringify({ type: 'delta', text: fallback })}\n\n`);
        await query(
          'INSERT INTO kb_messages (chat_id, role, content, sources) VALUES ($1, $2, $3, $4)',
          [chatId, 'assistant', fallback, JSON.stringify(sourcesData)]
        );
        await query('UPDATE kb_chats SET updated_at = NOW() WHERE id = $1', [chatId]);
        res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
        return res.end();
      }

      const Anthropic = (await import('@anthropic-ai/sdk')).default;
      const client = new Anthropic({ apiKey });

      let fullText = '';
      const stream = await client.messages.stream({
        model: process.env.KB_LLM_MODEL || 'claude-haiku-4-5-20251001',
        max_tokens: 1024,
        system: systemPrompt,
        messages: [{ role: 'user', content: message }],
      });

      for await (const chunk of stream) {
        if (chunk.type === 'content_block_delta' && chunk.delta?.type === 'text_delta') {
          fullText += chunk.delta.text;
          res.write(`data: ${JSON.stringify({ type: 'delta', text: chunk.delta.text })}\n\n`);
        }
      }

      await query(
        'INSERT INTO kb_messages (chat_id, role, content, sources) VALUES ($1, $2, $3, $4)',
        [chatId, 'assistant', fullText, JSON.stringify(sourcesData)]
      );
      await query('UPDATE kb_chats SET updated_at = NOW() WHERE id = $1', [chatId]);

      res.write(`data: ${JSON.stringify({ type: 'done', chat_id: chatId })}\n\n`);
      res.end();
    } catch (e) {
      try {
        res.write(`data: ${JSON.stringify({ type: 'error', error: String(e.message) })}\n\n`);
        res.end();
      } catch (_) {}
    }
  });

  // ── Admin ──────────────────────────────────────────────────────────────────

  /** GET /api/kb/admin/files — all files (admin only) */
  app.get('/api/kb/admin/files', requireAdmin(), async (req, res) => {
    try {
      const { rows } = await query(
        `SELECT f.*, u.full_name AS owner_name FROM kb_files f
         LEFT JOIN users u ON u.id = f.owner_id ORDER BY f.created_at DESC`
      );
      res.json(rows);
    } catch (e) {
      res.status(500).json({ error: String(e.message) });
    }
  });

  /** POST /api/kb/admin/reindex/:id — force re-OCR + re-embed */
  app.post('/api/kb/admin/reindex/:id', requireAdmin(), async (req, res) => {
    try {
      const fileId = parseInt(req.params.id);
      const { rows } = await query('SELECT id FROM kb_files WHERE id = $1', [fileId]);
      if (!rows[0]) return res.status(404).json({ error: 'Файл не найден' });
      // Delete existing chunks and reset status
      await query('DELETE FROM kb_chunks WHERE file_id = $1', [fileId]);
      await query(`UPDATE kb_files SET ocr_status = 'pending', ocr_error = NULL, updated_at = NOW() WHERE id = $1`, [fileId]);
      res.json({ ok: true, message: 'Файл поставлен в очередь на переиндексацию' });
    } catch (e) {
      res.status(500).json({ error: String(e.message) });
    }
  });
}
