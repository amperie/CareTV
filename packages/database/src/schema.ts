export const migrations = [
  {
    id: 1,
    sql: `
      PRAGMA foreign_keys = ON;

      CREATE TABLE IF NOT EXISTS media_items (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        service TEXT NOT NULL,
        media_type TEXT NOT NULL,
        url TEXT,
        local_path TEXT,
        expected_duration_seconds INTEGER,
        profile_name TEXT,
        enabled INTEGER NOT NULL,
        repeatable INTEGER NOT NULL,
        metadata_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        deleted_at TEXT
      );

      CREATE TABLE IF NOT EXISTS queue_entries (
        id TEXT PRIMARY KEY,
        media_item_id TEXT NOT NULL REFERENCES media_items(id),
        position INTEGER NOT NULL,
        status TEXT NOT NULL,
        priority INTEGER NOT NULL DEFAULT 0,
        scheduled_start_at TEXT,
        started_at TEXT,
        completed_at TEXT,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        last_error_code TEXT,
        last_error_message TEXT
      );

      CREATE UNIQUE INDEX IF NOT EXISTS queue_entries_active_position_idx
        ON queue_entries(position)
        WHERE status = 'queued';

      CREATE UNIQUE INDEX IF NOT EXISTS queue_entries_single_active_idx
        ON queue_entries(status)
        WHERE status IN ('starting', 'playing', 'paused');

      CREATE TABLE IF NOT EXISTS playback_commands (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        media_item_id TEXT REFERENCES media_items(id),
        issued_at TEXT NOT NULL,
        issued_by TEXT NOT NULL,
        status TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS playback_sessions (
        id TEXT PRIMARY KEY,
        queue_entry_id TEXT REFERENCES queue_entries(id),
        started_at TEXT NOT NULL,
        ended_at TEXT,
        result TEXT
      );

      CREATE TABLE IF NOT EXISTS playback_events (
        id TEXT PRIMARY KEY,
        queue_entry_id TEXT REFERENCES queue_entries(id),
        media_item_id TEXT REFERENCES media_items(id),
        type TEXT NOT NULL,
        message TEXT,
        details_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `
  },
  {
    id: 2,
    sql: `
      CREATE TABLE IF NOT EXISTS appliances (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        playback_state_json TEXT
      );
    `
  },
  {
    id: 3,
    sql: `
      CREATE TABLE IF NOT EXISTS media_downloads (
        id TEXT PRIMARY KEY,
        media_item_id TEXT NOT NULL REFERENCES media_items(id),
        filename TEXT NOT NULL,
        source_path TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        completed_at TEXT,
        error_message TEXT
      );
    `
  },
  {
    id: 4,
    sql: `
      CREATE TABLE IF NOT EXISTS media_deletions (
        id TEXT PRIMARY KEY,
        local_path TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        completed_at TEXT,
        error_message TEXT
      );
    `
  }
] as const;
