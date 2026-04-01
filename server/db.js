import pg from 'pg';

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  console.error('ERROR: DATABASE_URL environment variable is not set.');
  console.error('Create a .env file with DATABASE_URL=postgresql://user:pass@host:5432/dbname');
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL.includes('localhost') ? false : { rejectUnauthorized: false }
});

export function getDb() {
  return pool;
}

export async function query(sql, params = []) {
  const client = await pool.connect();
  try {
    const result = await client.query(sql, params);
    return result;
  } finally {
    client.release();
  }
}

export async function initSchema() {
  // Enable pgvector extension for RAG embeddings
  try {
    await query(`CREATE EXTENSION IF NOT EXISTS vector`);
  } catch (e) {
    // Extension may not be available in local dev without pgvector — skip gracefully
    console.warn('pgvector extension not available, embeddings will be disabled:', e.message);
  }

  await query(`
    CREATE TABLE IF NOT EXISTS departments (
      id SERIAL PRIMARY KEY,
      name TEXT UNIQUE NOT NULL
    );
    CREATE TABLE IF NOT EXISTS case_task_categories (
      id SERIAL PRIMARY KEY,
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
      id SERIAL PRIMARY KEY,
      timestamp TEXT NOT NULL,
      event_type TEXT,
      payload TEXT
    );
    CREATE TABLE IF NOT EXISTS kv (
      key TEXT PRIMARY KEY,
      value TEXT
    );
    CREATE TABLE IF NOT EXISTS instructions (
      id TEXT PRIMARY KEY,
      data TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS videos (
      id TEXT PRIMARY KEY,
      data TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS video_categories (
      id SERIAL PRIMARY KEY,
      name TEXT UNIQUE NOT NULL,
      color TEXT NOT NULL DEFAULT '#6B9FFF'
    );
    CREATE INDEX IF NOT EXISTS idx_ui_events_ts ON ui_events(timestamp);
    CREATE INDEX IF NOT EXISTS idx_ui_events_type ON ui_events(event_type);
  `);

  // Knowledge Base tables
  await query(`
    CREATE TABLE IF NOT EXISTS kb_folders (
      id        SERIAL PRIMARY KEY,
      name      TEXT NOT NULL,
      parent_id INTEGER REFERENCES kb_folders(id) ON DELETE CASCADE,
      owner_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_kb_folders_owner  ON kb_folders(owner_id);
    CREATE INDEX IF NOT EXISTS idx_kb_folders_parent ON kb_folders(parent_id);

    CREATE TABLE IF NOT EXISTS kb_files (
      id            SERIAL PRIMARY KEY,
      original_name TEXT NOT NULL,
      stored_name   TEXT NOT NULL UNIQUE,
      mime_type     TEXT NOT NULL,
      size_bytes    BIGINT NOT NULL DEFAULT 0,
      folder_id     INTEGER REFERENCES kb_folders(id) ON DELETE SET NULL,
      owner_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      ocr_status    TEXT NOT NULL DEFAULT 'pending',
      ocr_error     TEXT,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_kb_files_owner  ON kb_files(owner_id);
    CREATE INDEX IF NOT EXISTS idx_kb_files_folder ON kb_files(folder_id);
    CREATE INDEX IF NOT EXISTS idx_kb_files_status ON kb_files(ocr_status);

    CREATE TABLE IF NOT EXISTS kb_file_permissions (
      id            SERIAL PRIMARY KEY,
      file_id       INTEGER NOT NULL REFERENCES kb_files(id) ON DELETE CASCADE,
      user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      permission    TEXT NOT NULL DEFAULT 'view',
      granted_by_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(file_id, user_id)
    );
    CREATE INDEX IF NOT EXISTS idx_kb_perm_file ON kb_file_permissions(file_id);
    CREATE INDEX IF NOT EXISTS idx_kb_perm_user ON kb_file_permissions(user_id);

    CREATE TABLE IF NOT EXISTS kb_chats (
      id         SERIAL PRIMARY KEY,
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      title      TEXT NOT NULL DEFAULT 'Новый запрос',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_kb_chats_user ON kb_chats(user_id);

    CREATE TABLE IF NOT EXISTS kb_messages (
      id         SERIAL PRIMARY KEY,
      chat_id    INTEGER NOT NULL REFERENCES kb_chats(id) ON DELETE CASCADE,
      role       TEXT NOT NULL,
      content    TEXT NOT NULL,
      sources    TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_kb_messages_chat ON kb_messages(chat_id);
  `);

  // kb_chunks needs vector type — only create if pgvector is available
  try {
    await query(`
      CREATE TABLE IF NOT EXISTS kb_chunks (
        id          SERIAL PRIMARY KEY,
        file_id     INTEGER NOT NULL REFERENCES kb_files(id) ON DELETE CASCADE,
        chunk_index INTEGER NOT NULL,
        content     TEXT NOT NULL,
        token_count INTEGER,
        embedding   vector(1536),
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_kb_chunks_file ON kb_chunks(file_id);
    `);
    // HNSW index (pgvector 0.5+) — skip if already exists or not supported
    await query(`
      CREATE INDEX IF NOT EXISTS idx_kb_chunks_embedding
        ON kb_chunks USING hnsw (embedding vector_cosine_ops)
        WITH (m = 16, ef_construction = 64)
    `);
  } catch (e) {
    console.warn('kb_chunks vector index not created (pgvector may be unavailable):', e.message);
  }
}
