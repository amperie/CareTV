import type { PlaybackEvent } from "@caretv/core";

import type { CareTvDatabase } from "./database.js";
import { parseJsonObject, stringifyJson } from "./json.js";

interface EventRow {
  id: string;
  queue_entry_id: string | null;
  media_item_id: string | null;
  type: string;
  message: string | null;
  details_json: string;
  created_at: string;
}

export class PlaybackEventRepository {
  public constructor(private readonly db: CareTvDatabase) {}

  public append(event: PlaybackEvent): void {
    this.db
      .prepare(
        `
          INSERT INTO playback_events (
            id, queue_entry_id, media_item_id, type, message, details_json, created_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `
      )
      .run(
        event.id,
        event.queueEntryId ?? null,
        event.mediaItemId ?? null,
        event.type,
        event.message ?? null,
        stringifyJson(event.details),
        event.createdAt
      );
  }

  public listRecent(limit: number): PlaybackEvent[] {
    const rows = this.db
      .prepare("SELECT * FROM playback_events ORDER BY created_at DESC LIMIT ?")
      .all(limit) as unknown as EventRow[];

    return rows.map(mapEventRow);
  }

  public listSince(since: string): PlaybackEvent[] {
    const rows = this.db
      .prepare("SELECT * FROM playback_events WHERE created_at >= ? ORDER BY created_at DESC")
      .all(since) as unknown as EventRow[];

    return rows.map(mapEventRow);
  }
}

function mapEventRow(row: EventRow): PlaybackEvent {
  return {
    id: row.id,
    ...(row.queue_entry_id ? { queueEntryId: row.queue_entry_id } : {}),
    ...(row.media_item_id ? { mediaItemId: row.media_item_id } : {}),
    type: row.type,
    ...(row.message ? { message: row.message } : {}),
    details: parseJsonObject(row.details_json),
    createdAt: row.created_at
  };
}
