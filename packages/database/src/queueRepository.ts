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
  ): void {
    if (isActiveStatus(status) && this.get(id)) {
      this.reconcileOtherActive(id, "failed", "superseded-by-active-playback");
    }

    this.db
      .prepare(
        `
          UPDATE queue_entries
          SET status = ?, completed_at = COALESCE(?, completed_at),
              last_error_code = COALESCE(?, last_error_code),
              last_error_message = COALESCE(?, last_error_message)
          WHERE id = ?
        `
      )
      .run(
        status,
        fields.completedAt ?? null,
        fields.lastErrorCode ?? null,
        fields.lastErrorMessage ?? null,
        id
      );
  }

  public remove(id: string): boolean {
    const result = this.db
      .prepare("UPDATE queue_entries SET status = 'cancelled' WHERE id = ? AND status = 'queued'")
      .run(id);

    return Number(result.changes) > 0;
  }

  public clearCompleted(): number {
    const result = this.db
      .prepare(
        "DELETE FROM queue_entries WHERE status IN ('completed', 'failed', 'skipped', 'cancelled')"
      )
      .run();

    return Number(result.changes);
  }

  private reconcileOtherActive(id: string, status: QueueEntryStatus, errorCode: string): number {
    const result = this.db
      .prepare(
        `
          UPDATE queue_entries
          SET status = ?, last_error_code = ?
          WHERE id != ? AND status IN ('starting', 'playing', 'paused')
        `
      )
      .run(status, errorCode, id);

    return Number(result.changes);
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

  public reconcileStaleActive(status: QueueEntryStatus, errorCode: string): number {
    const result = this.db
      .prepare(
        `
          UPDATE queue_entries
          SET status = ?, last_error_code = ?
          WHERE status IN ('starting', 'playing', 'paused')
        `
      )
      .run(status, errorCode);

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
}

function isActiveStatus(status: QueueEntryStatus): boolean {
  return status === "starting" || status === "playing" || status === "paused";
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
