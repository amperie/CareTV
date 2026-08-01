import type { QueueEntry, QueueEntryStatus } from "@caretv/core";

import type { CareTvDatabase } from "./database.js";

interface QueueRow {
  id: string;
  media_item_id: string;
  position: number;
  status: QueueEntryStatus;
  priority: number;
  scheduled_start_at: string | null;
  started_at: string | null;
  completed_at: string | null;
  attempt_count: number;
  last_error_code: string | null;
  last_error_message: string | null;
}

export class QueueRepository {
  public constructor(private readonly db: CareTvDatabase) {}

  public enqueue(entry: QueueEntry): void {
    this.db
      .prepare(
        `
          INSERT INTO queue_entries (
            id, media_item_id, position, status, priority, scheduled_start_at,
            started_at, completed_at, attempt_count, last_error_code, last_error_message
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `
      )
      .run(
        entry.id,
        entry.mediaItemId,
        entry.position,
        entry.status,
        entry.priority,
        entry.scheduledStartAt ?? null,
        entry.startedAt ?? null,
        entry.completedAt ?? null,
        entry.attemptCount,
        entry.lastErrorCode ?? null,
        entry.lastErrorMessage ?? null
      );
  }

  public selectNextQueued(now: string): QueueEntry | undefined {
    this.db.exec("BEGIN IMMEDIATE;");
    try {
      if (this.activeCount() > 0) {
        this.db.exec("COMMIT;");
        return undefined;
      }

      const row = this.db
        .prepare(
          `
            SELECT * FROM queue_entries
            WHERE status = 'queued'
            ORDER BY priority DESC, position ASC
            LIMIT 1
          `
        )
        .get() as unknown as QueueRow | undefined;

      if (!row) {
        this.db.exec("COMMIT;");
        return undefined;
      }

      this.db
        .prepare("UPDATE queue_entries SET status = 'starting', started_at = ? WHERE id = ?")
        .run(now, row.id);

      this.db.exec("COMMIT;");
      return { ...mapQueueRow(row), status: "starting", startedAt: now };
    } catch (error) {
      this.db.exec("ROLLBACK;");
      throw error;
    }
  }

  public updateStatus(
    id: string,
    status: QueueEntryStatus,
    fields: {
      completedAt?: string;
      lastErrorCode?: string;
      lastErrorMessage?: string;
    } = {}
  ): boolean {
    const current = this.get(id);

    if (!current || isTerminalStatus(current.status)) {
      return false;
    }

    if (isActiveStatus(status) && this.otherActiveCount(id) > 0) {
      return false;
    }

    const result = this.db
      .prepare(
        `
          UPDATE queue_entries
          SET status = ?,
              completed_at = COALESCE(?, completed_at),
              last_error_code = CASE
                WHEN ? IN ('completed', 'skipped') THEN NULL
                ELSE COALESCE(?, last_error_code)
              END,
              last_error_message = CASE
                WHEN ? IN ('completed', 'skipped') THEN NULL
                ELSE COALESCE(?, last_error_message)
              END
          WHERE id = ?
        `
      )
      .run(
        status,
        fields.completedAt ?? null,
        status,
        fields.lastErrorCode ?? null,
        status,
        fields.lastErrorMessage ?? null,
        id
      );

    return Number(result.changes) > 0;
  }

  public remove(id: string): boolean {
    const current = this.get(id);

    if (!current) {
      return false;
    }

    if (isTerminalStatus(current.status)) {
      return this.deleteTerminal(id) > 0;
    }

    const result = this.db
      .prepare("UPDATE queue_entries SET status = 'cancelled' WHERE id = ? AND status = 'queued'")
      .run(id);

    return Number(result.changes) > 0;
  }

  public cancelQueuedForMedia(mediaItemIds: string[]): number {
    if (mediaItemIds.length === 0) {
      return 0;
    }

    const placeholders = mediaItemIds.map(() => "?").join(", ");
    const result = this.db
      .prepare(
        `UPDATE queue_entries
         SET status = 'cancelled'
         WHERE status = 'queued' AND media_item_id IN (${placeholders})`
      )
      .run(...mediaItemIds);

    return Number(result.changes);
  }

  public hasActiveForMedia(mediaItemIds: string[]): boolean {
    if (mediaItemIds.length === 0) {
      return false;
    }

    const placeholders = mediaItemIds.map(() => "?").join(", ");
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS count
         FROM queue_entries
         WHERE status IN ('starting', 'playing', 'paused') AND media_item_id IN (${placeholders})`
      )
      .get(...mediaItemIds) as { count: number } | undefined;

    return (row?.count ?? 0) > 0;
  }

  public requeueCompleted(id: string): boolean {
    const result = this.db
      .prepare(
        `
          UPDATE queue_entries
          SET status = 'queued',
              started_at = NULL,
              completed_at = NULL,
              last_error_code = NULL,
              last_error_message = NULL
          WHERE id = ? AND status IN ('completed', 'failed', 'skipped')
        `
      )
      .run(id);

    return Number(result.changes) > 0;
  }

  public requeueCompletedEntries(): number {
    const result = this.db
      .prepare(
        `
          UPDATE queue_entries
          SET status = 'queued',
              started_at = NULL,
              completed_at = NULL,
              last_error_code = NULL,
              last_error_message = NULL
          WHERE status IN ('completed', 'failed', 'skipped')
        `
      )
      .run();

    return Number(result.changes);
  }

  public clearCompleted(): number {
    const ids = this.db
      .prepare(
        "SELECT id FROM queue_entries WHERE status IN ('completed', 'failed', 'skipped', 'cancelled')"
      )
      .all() as { id: string }[];

    return ids.reduce((count, row) => count + this.deleteTerminal(row.id), 0);
  }

  public clearFailed(): number {
    const ids = this.db
      .prepare("SELECT id FROM queue_entries WHERE status = 'failed'")
      .all() as { id: string }[];

    return ids.reduce((count, row) => count + this.deleteTerminal(row.id), 0);
  }

  public move(id: string, direction: "up" | "down"): boolean {
    const current = this.get(id);

    if (!current || current.status !== "queued") {
      return false;
    }

    const comparator = direction === "up" ? "<" : ">";
    const ordering = direction === "up" ? "DESC" : "ASC";
    const neighbor = this.db
      .prepare(
        `
          SELECT * FROM queue_entries
          WHERE status = 'queued' AND position ${comparator} ?
          ORDER BY position ${ordering}
          LIMIT 1
        `
      )
      .get(current.position) as unknown as QueueRow | undefined;

    if (!neighbor) {
      return false;
    }

    this.db.exec("BEGIN IMMEDIATE;");
    try {
      this.db.prepare("UPDATE queue_entries SET position = -1 WHERE id = ?").run(current.id);
      this.db
        .prepare("UPDATE queue_entries SET position = ? WHERE id = ?")
        .run(current.position, neighbor.id);
      this.db
        .prepare("UPDATE queue_entries SET position = ? WHERE id = ?")
        .run(neighbor.position, current.id);
      this.db.exec("COMMIT;");
      return true;
    } catch (error) {
      this.db.exec("ROLLBACK;");
      throw error;
    }
  }

  public promoteToNext(id: string): boolean {
    const current = this.get(id);

    if (!current || isActiveStatus(current.status) || current.status === "cancelled") {
      return false;
    }

    const row = this.db
      .prepare("SELECT COALESCE(MAX(priority), 0) + 1 AS priority FROM queue_entries")
      .get() as { priority: number } | undefined;
    const result = this.db
      .prepare(
        `
          UPDATE queue_entries
          SET status = 'queued',
              priority = ?,
              started_at = NULL,
              completed_at = NULL,
              last_error_code = NULL,
              last_error_message = NULL
          WHERE id = ?
        `
      )
      .run(row?.priority ?? 1, id);

    return Number(result.changes) > 0;
  }

  public reconcileStaleActive(
    status: QueueEntryStatus,
    errorCode: string,
    startedBefore?: string
  ): number {
    const result = this.db
      .prepare(
        `
          UPDATE queue_entries
          SET status = ?, last_error_code = ?
          WHERE status IN ('starting', 'playing', 'paused')
            AND (? IS NULL OR started_at IS NULL OR started_at < ?)
        `
      )
      .run(status, errorCode, startedBefore ?? null, startedBefore ?? null);

    return Number(result.changes);
  }

  public get(id: string): QueueEntry | undefined {
    const row = this.db.prepare("SELECT * FROM queue_entries WHERE id = ?").get(id) as unknown as
      QueueRow | undefined;

    return row ? mapQueueRow(row) : undefined;
  }

  public list(): QueueEntry[] {
    const rows = this.db
      .prepare("SELECT * FROM queue_entries ORDER BY position ASC, started_at ASC")
      .all() as unknown as QueueRow[];

    return rows.map(mapQueueRow);
  }

  public nextPosition(): number {
    const row = this.db
      .prepare("SELECT COALESCE(MAX(position), 0) + 1 AS position FROM queue_entries")
      .get() as { position: number } | undefined;

    return row?.position ?? 1;
  }

  public runnableCount(): number {
    const row = this.db
      .prepare(
        "SELECT COUNT(*) AS count FROM queue_entries WHERE status IN ('queued', 'starting', 'playing', 'paused')"
      )
      .get() as { count: number } | undefined;

    return row?.count ?? 0;
  }

  public hasActive(): boolean {
    return this.activeCount() > 0;
  }

  public active(): QueueEntry | undefined {
    const row = this.db
      .prepare(
        "SELECT * FROM queue_entries WHERE status IN ('starting', 'playing', 'paused') ORDER BY started_at DESC LIMIT 1"
      )
      .get() as unknown as QueueRow | undefined;

    return row ? mapQueueRow(row) : undefined;
  }

  private activeCount(): number {
    const row = this.db
      .prepare(
        "SELECT COUNT(*) AS count FROM queue_entries WHERE status IN ('starting', 'playing', 'paused')"
      )
      .get() as { count: number } | undefined;

    return row?.count ?? 0;
  }

  private otherActiveCount(id: string): number {
    const row = this.db
      .prepare(
        "SELECT COUNT(*) AS count FROM queue_entries WHERE id != ? AND status IN ('starting', 'playing', 'paused')"
      )
      .get(id) as { count: number } | undefined;

    return row?.count ?? 0;
  }

  private deleteTerminal(id: string): number {
    this.db.exec("BEGIN IMMEDIATE;");
    try {
      this.db
        .prepare("UPDATE playback_events SET queue_entry_id = NULL WHERE queue_entry_id = ?")
        .run(id);
      this.db
        .prepare("UPDATE playback_sessions SET queue_entry_id = NULL WHERE queue_entry_id = ?")
        .run(id);
      const result = this.db
        .prepare(
          "DELETE FROM queue_entries WHERE id = ? AND status IN ('completed', 'failed', 'skipped', 'cancelled')"
        )
        .run(id);
      this.db.exec("COMMIT;");
      return Number(result.changes);
    } catch (error) {
      this.db.exec("ROLLBACK;");
      throw error;
    }
  }
}

function isActiveStatus(status: QueueEntryStatus): boolean {
  return status === "starting" || status === "playing" || status === "paused";
}

function isTerminalStatus(status: QueueEntryStatus): boolean {
  return (
    status === "completed" || status === "failed" || status === "skipped" || status === "cancelled"
  );
}

function mapQueueRow(row: QueueRow): QueueEntry {
  return {
    id: row.id,
    mediaItemId: row.media_item_id,
    position: row.position,
    status: row.status,
    priority: row.priority,
    ...(row.scheduled_start_at ? { scheduledStartAt: row.scheduled_start_at } : {}),
    ...(row.started_at ? { startedAt: row.started_at } : {}),
    ...(row.completed_at ? { completedAt: row.completed_at } : {}),
    attemptCount: row.attempt_count,
    ...(row.last_error_code ? { lastErrorCode: row.last_error_code } : {}),
    ...(row.last_error_message ? { lastErrorMessage: row.last_error_message } : {})
  };
}
