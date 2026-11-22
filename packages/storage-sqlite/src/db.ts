import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { MIGRATIONS } from './migrations.js';

export type SqliteDb = DatabaseSync;

export function openDatabase(dbPath: string): SqliteDb {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  try {
    // `octet_length` and the size limits are measured in UTF-8 bytes: a database in another text encoding is refused.
    const encoding = (db.prepare('PRAGMA encoding').get() as { encoding: string }).encoding;
    if (encoding !== 'UTF-8') throw new Error(`the database ${dbPath} uses the ${encoding} text encoding; only UTF-8 is supported`);
    db.exec('PRAGMA journal_mode = WAL;');
    db.exec('PRAGMA foreign_keys = ON;');
    migrate(db);
    return db;
  } catch (e) {
    try {
      db.close();
    } catch {
      /* already closed or unusable */
    }
    throw e;
  }
}

function migrate(db: SqliteDb): void {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL
  )`);
  const applied = new Set(
    (db.prepare('SELECT version FROM schema_migrations').all() as Array<{ version: number }>).map(
      (r) => r.version,
    ),
  );
  for (const m of MIGRATIONS) {
    if (applied.has(m.version)) continue;
    db.exec('BEGIN');
    try {
      db.exec(m.sql);
      db.prepare('INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)').run(
        m.version,
        new Date().toISOString(),
      );
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }
}
