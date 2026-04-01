// server/kb-pipeline.js
// Background worker: OCR → chunking → embedding → pgvector storage

import { readFile } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { query, getDb } from './db.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const UPLOADS_DIR = join(__dirname, '..', 'data', 'uploads');
const TESSDATA_DIR = join(__dirname, '..', 'data', 'tessdata');

// ── Text extraction ────────────────────────────────────────────────────────────

async function extractText(file) {
  const filePath = join(UPLOADS_DIR, file.stored_name);
  const mime = file.mime_type;

  if (mime === 'application/pdf') {
    const pdfParse = (await import('pdf-parse/lib/pdf-parse.js')).default;
    const buffer = await readFile(filePath);
    const data = await pdfParse(buffer);
    return data.text;
  }

  if (mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
    const mammoth = (await import('mammoth')).default;
    const result = await mammoth.extractRawText({ path: filePath });
    return result.value;
  }

  if (mime === 'text/plain') {
    const buf = await readFile(filePath, 'utf-8');
    return buf;
  }

  if (mime.startsWith('image/')) {
    const Tesseract = await import('tesseract.js');
    const { data: { text } } = await Tesseract.recognize(filePath, 'rus+eng', {
      cachePath: TESSDATA_DIR,
      logger: () => {},
    });
    return text;
  }

  throw new Error(`Неподдерживаемый тип файла: ${mime}`);
}

// ── Chunking ───────────────────────────────────────────────────────────────────

function approxTokens(text) {
  // ~4 chars per token (rough English estimate; works for Russian too)
  return Math.ceil(text.length / 4);
}

export function chunkText(text, { chunkSize = 512, overlap = 64 } = {}) {
  if (!text || !text.trim()) return [];

  const chunks = [];
  let index = 0;

  // Split by paragraph first
  const paragraphs = text.split(/\n{2,}/).map(p => p.trim()).filter(Boolean);

  let current = '';
  let currentTokens = 0;

  const flushChunk = (extra = '') => {
    const full = (current + (extra ? '\n' + extra : '')).trim();
    if (!full) return;
    chunks.push({ content: full, index: index++ });
    // Keep overlap: last `overlap` tokens worth of text
    const overlapChars = overlap * 4;
    current = full.length > overlapChars ? full.slice(-overlapChars) : full;
    currentTokens = approxTokens(current);
  };

  for (const para of paragraphs) {
    const paraTokens = approxTokens(para);

    if (paraTokens > chunkSize) {
      // Large paragraph: split by sentence
      const sentences = para.match(/[^.!?]+[.!?]+[\s]*/g) || [para];
      for (const sent of sentences) {
        const sentTokens = approxTokens(sent);
        if (currentTokens + sentTokens > chunkSize) {
          flushChunk();
        }
        current += (current ? ' ' : '') + sent.trim();
        currentTokens += sentTokens;
      }
    } else if (currentTokens + paraTokens > chunkSize) {
      flushChunk(para);
    } else {
      current += (current ? '\n\n' : '') + para;
      currentTokens += paraTokens;
    }
  }

  if (current.trim()) {
    chunks.push({ content: current.trim(), index: index++ });
  }

  return chunks;
}

// ── Embeddings ─────────────────────────────────────────────────────────────────

let openaiClient = null;
function getOpenAI() {
  if (!openaiClient) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error('OPENAI_API_KEY не настроен');
    const { OpenAI } = require('openai') || (() => { throw new Error('openai package not found'); })();
    openaiClient = new (require('openai').OpenAI)({ apiKey });
  }
  return openaiClient;
}

async function loadOpenAI() {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY не настроен');
  const { OpenAI } = await import('openai');
  return new OpenAI({ apiKey });
}

/** Get single embedding vector for a text string */
export async function getEmbedding(text) {
  const client = await loadOpenAI();
  const response = await client.embeddings.create({
    model: 'text-embedding-3-small',
    input: text.slice(0, 8000), // safety limit
  });
  return response.data[0].embedding;
}

/** Get embeddings for a batch of texts (up to 100 per request) */
async function getBatchEmbeddings(texts) {
  const client = await loadOpenAI();
  const BATCH = 100;
  const results = [];
  for (let i = 0; i < texts.length; i += BATCH) {
    const batch = texts.slice(i, i + BATCH);
    const response = await client.embeddings.create({
      model: 'text-embedding-3-small',
      input: batch,
    });
    results.push(...response.data.map(d => d.embedding));
  }
  return results;
}

// ── Main pipeline ──────────────────────────────────────────────────────────────

async function processFile(fileId) {
  await query(`UPDATE kb_files SET ocr_status = 'processing', updated_at = NOW() WHERE id = $1`, [fileId]);
  try {
    const { rows } = await query('SELECT * FROM kb_files WHERE id = $1', [fileId]);
    if (!rows[0]) throw new Error('Файл не найден в БД');
    const file = rows[0];

    // Step 1: Extract text
    let rawText;
    try {
      rawText = await extractText(file);
    } catch (e) {
      throw new Error(`Ошибка извлечения текста: ${e.message}`);
    }

    if (!rawText || !rawText.trim()) {
      // No text found — still mark done (might be a blank image)
      await query(`UPDATE kb_files SET ocr_status = 'done', updated_at = NOW() WHERE id = $1`, [fileId]);
      return;
    }

    // Step 2: Chunk text
    const chunks = chunkText(rawText);
    if (chunks.length === 0) {
      await query(`UPDATE kb_files SET ocr_status = 'done', updated_at = NOW() WHERE id = $1`, [fileId]);
      return;
    }

    // Step 3: Generate embeddings (skip if OpenAI not configured)
    let embeddings = null;
    try {
      embeddings = await getBatchEmbeddings(chunks.map(c => c.content));
    } catch (e) {
      console.warn(`[KB Pipeline] Embeddings skipped for file ${fileId}: ${e.message}`);
    }

    // Step 4: Delete old chunks and insert new ones
    await query('DELETE FROM kb_chunks WHERE file_id = $1', [fileId]);

    const db = getDb();
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      for (let i = 0; i < chunks.length; i++) {
        const emb = embeddings ? embeddings[i] : null;
        const embStr = emb ? `[${emb.join(',')}]` : null;
        await client.query(
          `INSERT INTO kb_chunks (file_id, chunk_index, content, token_count, embedding)
           VALUES ($1, $2, $3, $4, $5::vector)`,
          [fileId, chunks[i].index, chunks[i].content, approxTokens(chunks[i].content), embStr]
        );
      }
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }

    await query(`UPDATE kb_files SET ocr_status = 'done', updated_at = NOW() WHERE id = $1`, [fileId]);
    console.log(`[KB Pipeline] Processed file ${fileId}: ${chunks.length} chunks`);
  } catch (e) {
    const msg = String(e.message).slice(0, 500);
    await query(`UPDATE kb_files SET ocr_status = 'failed', ocr_error = $1, updated_at = NOW() WHERE id = $2`, [msg, fileId]);
    console.error(`[KB Pipeline] Error processing file ${fileId}:`, e.message);
  }
}

let workerRunning = false;

async function processNextPending() {
  if (workerRunning) return;
  workerRunning = true;
  try {
    // Use SKIP LOCKED to be safe if multiple instances run
    const { rows } = await query(`
      SELECT id FROM kb_files
      WHERE ocr_status = 'pending'
      ORDER BY created_at
      LIMIT 1
    `);
    if (rows[0]) {
      await processFile(rows[0].id);
    }
  } catch (e) {
    console.error('[KB Pipeline] Worker error:', e.message);
  } finally {
    workerRunning = false;
  }
}

/** Start the background pipeline worker. Call once from server/index.js. */
export function startPipelineWorker() {
  setInterval(processNextPending, 3000);
  console.log('[KB Pipeline] Worker started (polling every 3s)');
}
