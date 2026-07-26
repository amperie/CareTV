import type { CareTvDatabase } from "./database.js";

export interface MediaDeletion {
  id: string;
  localPath: string;
  status: "pending" | "completed" | "failed";
  createdAt: string;
  completedAt?: string;
  errorMessage?: string;
}

interface MediaDeletionRow {
  id: string;
  local_path: string;
  status: MediaDeletion["status"];
  created_at: string;
  completed_at: string | null;
  error_message: string | null;
}

export class MediaDeletionRepository {
  public constructor(private readonly db: CareTvDatabase) {}

  public create(deletion: MediaDeletion): void {
    this.db
      .prepare(
        `
          INSERT INTO media_deletions (id, local_path, status, created_at, completed_at, error_message)
          VALUES (?, ?, ?, ?, ?, ?)
        `
      )
      .run(
        deletion.id,
        deletion.localPath,
        deletion.status,
        deletion.createdAt,
        deletion.completedAt ?? null,
        deletion.errorMessage ?? null
      );
  }

  public get(id: string): MediaDeletion | undefined {
    const row = this.db.prepare("SELECT * FROM media_deletions WHERE id = ?").get(id) as unknown as
      MediaDeletionRow | undefined;

    return row ? mapRow(row) : undefined;
  }

  public listPending(): MediaDeletion[] {
    const rows = this.db
      .prepare("SELECT * FROM media_deletions WHERE status = 'pending' ORDER BY created_at ASC")
      .all() as unknown as MediaDeletionRow[];

    return rows.map(mapRow);
  }

  public complete(id: string, completedAt: string): boolean {
    const result = this.db
      .prepare("UPDATE media_deletions SET status = 'completed', completed_at = ? WHERE id = ?")
      .run(completedAt, id);

    return Number(result.changes) > 0;
  }

  public fail(id: string, message: string, completedAt: string): boolean {
    const result = this.db
      .prepare(
        "UPDATE media_deletions SET status = 'failed', error_message = ?, completed_at = ? WHERE id = ?"
      )
      .run(message, completedAt, id);

    return Number(result.changes) > 0;
  }
}

function mapRow(row: MediaDeletionRow): MediaDeletion {
  return {
    id: row.id,
    localPath: row.local_path,
    status: row.status,
    createdAt: row.created_at,
    ...(row.completed_at ? { completedAt: row.completed_at } : {}),
    ...(row.error_message ? { errorMessage: row.error_message } : {})
  };
}
