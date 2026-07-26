import type { CareTvDatabase } from "./database.js";

export interface MediaDownload {
  id: string;
  mediaItemId: string;
  filename: string;
  sourcePath: string;
  status: "pending" | "completed" | "failed";
  createdAt: string;
  completedAt?: string;
  errorMessage?: string;
}

interface MediaDownloadRow {
  id: string;
  media_item_id: string;
  filename: string;
  source_path: string;
  status: MediaDownload["status"];
  created_at: string;
  completed_at: string | null;
  error_message: string | null;
}

export class MediaDownloadRepository {
  public constructor(private readonly db: CareTvDatabase) {}

  public create(download: MediaDownload): void {
    this.db
      .prepare(
        `
          INSERT INTO media_downloads (
            id, media_item_id, filename, source_path, status, created_at, completed_at, error_message
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `
      )
      .run(
        download.id,
        download.mediaItemId,
        download.filename,
        download.sourcePath,
        download.status,
        download.createdAt,
        download.completedAt ?? null,
        download.errorMessage ?? null
      );
  }

  public get(id: string): MediaDownload | undefined {
    const row = this.db.prepare("SELECT * FROM media_downloads WHERE id = ?").get(id) as unknown as
      MediaDownloadRow | undefined;

    return row ? mapRow(row) : undefined;
  }

  public listPending(): MediaDownload[] {
    const rows = this.db
      .prepare("SELECT * FROM media_downloads WHERE status = 'pending' ORDER BY created_at ASC")
      .all() as unknown as MediaDownloadRow[];

    return rows.map(mapRow);
  }

  public complete(id: string, completedAt: string): boolean {
    const result = this.db
      .prepare("UPDATE media_downloads SET status = 'completed', completed_at = ? WHERE id = ?")
      .run(completedAt, id);

    return Number(result.changes) > 0;
  }

  public fail(id: string, message: string, completedAt: string): boolean {
    const result = this.db
      .prepare(
        "UPDATE media_downloads SET status = 'failed', error_message = ?, completed_at = ? WHERE id = ?"
      )
      .run(message, completedAt, id);

    return Number(result.changes) > 0;
  }
}

function mapRow(row: MediaDownloadRow): MediaDownload {
  return {
    id: row.id,
    mediaItemId: row.media_item_id,
    filename: row.filename,
    sourcePath: row.source_path,
    status: row.status,
    createdAt: row.created_at,
    ...(row.completed_at ? { completedAt: row.completed_at } : {}),
    ...(row.error_message ? { errorMessage: row.error_message } : {})
  };
}
