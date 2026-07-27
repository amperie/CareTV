import type { CareTvDatabase } from "./database.js";
import { parseJsonObject, stringifyJson } from "./json.js";

import type { MediaItem } from "@caretv/core";

interface MediaRow {
  id: string;
  title: string;
  service: MediaItem["service"];
  media_type: MediaItem["mediaType"];
  url: string | null;
  local_path: string | null;
  expected_duration_seconds: number | null;
  profile_name: string | null;
  enabled: number;
  repeatable: number;
  metadata_json: string;
  created_at: string;
  updated_at: string;
}

export class MediaRepository {
  public constructor(private readonly db: CareTvDatabase) {}

  public create(item: MediaItem): void {
    this.db
      .prepare(
        `
          INSERT INTO media_items (
            id, title, service, media_type, url, local_path, expected_duration_seconds,
            profile_name, enabled, repeatable, metadata_json, created_at, updated_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `
      )
      .run(
        item.id,
        item.title,
        item.service,
        item.mediaType,
        item.url ?? null,
        item.localPath ?? null,
        item.expectedDurationSeconds ?? null,
        item.profileName ?? null,
        item.enabled ? 1 : 0,
        item.repeatable ? 1 : 0,
        stringifyJson(item.metadata),
        item.createdAt,
        item.updatedAt
      );
  }

  public upsert(item: MediaItem): void {
    this.db
      .prepare(
        `
          INSERT INTO media_items (
            id, title, service, media_type, url, local_path, expected_duration_seconds,
            profile_name, enabled, repeatable, metadata_json, created_at, updated_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            title = excluded.title,
            service = excluded.service,
            media_type = excluded.media_type,
            url = excluded.url,
            local_path = excluded.local_path,
            expected_duration_seconds = excluded.expected_duration_seconds,
            profile_name = excluded.profile_name,
            enabled = excluded.enabled,
            repeatable = excluded.repeatable,
            metadata_json = excluded.metadata_json,
            updated_at = excluded.updated_at,
            deleted_at = NULL
        `
      )
      .run(
        item.id,
        item.title,
        item.service,
        item.mediaType,
        item.url ?? null,
        item.localPath ?? null,
        item.expectedDurationSeconds ?? null,
        item.profileName ?? null,
        item.enabled ? 1 : 0,
        item.repeatable ? 1 : 0,
        stringifyJson(item.metadata),
        item.createdAt,
        item.updatedAt
      );
  }

  public updateLocalPath(id: string, localPath: string, updatedAt: string): boolean {
    const result = this.db
      .prepare(
        `
          UPDATE media_items
          SET local_path = ?, updated_at = ?, metadata_json = json_set(metadata_json, '$.upload.status', 'complete')
          WHERE id = ? AND deleted_at IS NULL
        `
      )
      .run(localPath, updatedAt, id);

    return Number(result.changes) > 0;
  }

  public get(id: string): MediaItem | undefined {
    const row = this.db
      .prepare("SELECT * FROM media_items WHERE id = ? AND deleted_at IS NULL")
      .get(id) as unknown as MediaRow | undefined;

    return row ? mapMediaRow(row) : undefined;
  }

  public getByLocalPath(localPath: string): MediaItem | undefined {
    const row = this.db
      .prepare("SELECT * FROM media_items WHERE local_path = ? AND deleted_at IS NULL LIMIT 1")
      .get(localPath) as unknown as MediaRow | undefined;

    return row ? mapMediaRow(row) : undefined;
  }

  public getByServiceUrl(service: MediaItem["service"], url: string): MediaItem | undefined {
    const row = this.db
      .prepare(
        "SELECT * FROM media_items WHERE service = ? AND url = ? AND deleted_at IS NULL LIMIT 1"
      )
      .get(service, url) as unknown as MediaRow | undefined;

    return row ? mapMediaRow(row) : undefined;
  }

  public deletedLocalPathExists(localPath: string): boolean {
    const row = this.db
      .prepare(
        "SELECT COUNT(*) AS count FROM media_items WHERE local_path = ? AND deleted_at IS NOT NULL"
      )
      .get(localPath) as { count: number } | undefined;

    return (row?.count ?? 0) > 0;
  }

  public listEnabled(): MediaItem[] {
    const rows = this.db
      .prepare("SELECT * FROM media_items WHERE enabled = 1 AND deleted_at IS NULL ORDER BY title")
      .all() as unknown as MediaRow[];

    return rows.map(mapMediaRow);
  }

  public list(): MediaItem[] {
    const rows = this.db
      .prepare("SELECT * FROM media_items WHERE deleted_at IS NULL ORDER BY created_at DESC")
      .all() as unknown as MediaRow[];

    return rows.map(mapMediaRow);
  }

  public softDelete(id: string, deletedAt: string): void {
    this.db
      .prepare("UPDATE media_items SET deleted_at = ?, updated_at = ? WHERE id = ?")
      .run(deletedAt, deletedAt, id);
  }

  public softDeleteLocalPath(localPath: string, deletedAt: string): number {
    const result = this.db
      .prepare("UPDATE media_items SET deleted_at = ?, updated_at = ? WHERE local_path = ?")
      .run(deletedAt, deletedAt, localPath);

    return Number(result.changes);
  }
}

function mapMediaRow(row: MediaRow): MediaItem {
  return {
    id: row.id,
    title: row.title,
    service: row.service,
    mediaType: row.media_type,
    ...(row.url ? { url: row.url } : {}),
    ...(row.local_path ? { localPath: row.local_path } : {}),
    ...(row.expected_duration_seconds !== null
      ? { expectedDurationSeconds: row.expected_duration_seconds }
      : {}),
    ...(row.profile_name ? { profileName: row.profile_name } : {}),
    enabled: row.enabled === 1,
    repeatable: row.repeatable === 1,
    metadata: parseJsonObject(row.metadata_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}
