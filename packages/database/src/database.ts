import { createRequire } from "node:module";

import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";

import { migrations } from "./schema.js";

interface DatabaseSyncConstructor {
  new (filename: string): DatabaseSyncType;
}

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as { DatabaseSync: DatabaseSyncConstructor };

export type CareTvDatabase = DatabaseSyncType;

export function openDatabase(filename: string): CareTvDatabase {
  const db = new DatabaseSync(filename);
  db.exec("PRAGMA foreign_keys = ON;");
  return db;
}

export function migrate(db: CareTvDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
  `);

  const hasMigration = db.prepare("SELECT 1 FROM schema_migrations WHERE id = ?");
  const insertMigration = db.prepare(
    "INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)"
  );

  for (const migration of migrations) {
    if (hasMigration.get(migration.id)) {
      continue;
    }

    db.exec("BEGIN IMMEDIATE;");
    try {
      db.exec(migration.sql);
      insertMigration.run(migration.id, new Date().toISOString());
      db.exec("COMMIT;");
    } catch (error) {
      db.exec("ROLLBACK;");
      throw error;
    }
  }
}
