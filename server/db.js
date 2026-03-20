import pg from 'pg';
import { createRequire } from 'module';
import { mkdirSync } from 'fs';
import { dirname } from 'path';

const { Pool } = pg;

// ─── SQLite mode ─────────────────────────────────────────────────────────────
function useSqlite() {
  const require = createRequire(import.meta.url);
  const Database = require('better-sqlite3');
  const dbPath = process.env.DATABASE_PATH || './data/platform.db';
  mkdirSync(dirname(dbPath === './data/platform.db' ? 'data/x' : dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');

  // Convert pg-style SQL to SQLite
  function pgToSqlite(sql) {
    return sql
      .replace(/\$\d+/g, '?')
      .replace(/\bSERIAL\b/gi, 'INTEGER')
      .replace(/\bBIGSERIAL\b/gi, 'INTEGER');
  }

  // Count statements (rough: split on ; and filter blanks)
  function isMultiStatement(sql) {
    return sql.split(';').filter(s => s.trim()).length > 1;
  }

  return {
    getDb: () => db,
    query: async (sql, params = []) => {
      const converted = pgToSqlite(sql);
      const trimmed = converted.trim().toUpperCase();

      // DDL with multiple statements — use exec()
      if (isMultiStatement(converted)) {
        db.exec(converted);
        return { rows: [], rowCount: 0 };
      }

      if (trimmed.startsWith('SELECT') || trimmed.startsWith('WITH')) {
        const rows = db.prepare(converted).all(...params);
        return { rows };
      } else {
        const info = db.prepare(converted).run(...params);
        return { rows: [], rowCount: info.changes };
      }
    },
    initSchema: async () => {
      db.exec(`
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
      `);
    },
  };
}

// ─── PostgreSQL mode ──────────────────────────────────────────────────────────
function usePostgres() {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL.includes('localhost') ? false : { rejectUnauthorized: false },
  });

  return {
    getDb: () => pool,
    query: async (sql, params = []) => {
      const client = await pool.connect();
      try {
        return await client.query(sql, params);
      } finally {
        client.release();
      }
    },
    initSchema: async () => {
      const client = await pool.connect();
      try {
        await client.query(`
          CREATE TABLE IF NOT EXISTS departments (
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
          CREATE INDEX IF NOT EXISTS idx_ui_events_ts ON ui_events(timestamp);
          CREATE INDEX IF NOT EXISTS idx_ui_events_type ON ui_events(event_type);
        `);
      } finally {
        client.release();
      }
    },
  };
}

// ─── Select driver ────────────────────────────────────────────────────────────
const driver = process.env.DATABASE_URL ? usePostgres() : useSqlite();

export const getDb = driver.getDb;
export const query = driver.query;
export const initSchema = driver.initSchema;
