import type { PlaybackCommand, PlaybackCommandStatus } from "@caretv/core";

import type { CareTvDatabase } from "./database.js";

interface CommandRow {
  id: string;
  type: PlaybackCommand["type"];
  media_item_id: string | null;
  issued_at: string;
  issued_by: string;
  status: PlaybackCommandStatus;
}

export class CommandRepository {
  public constructor(private readonly db: CareTvDatabase) {}

  public create(command: PlaybackCommand): void {
    this.db
      .prepare(
        `
          INSERT INTO playback_commands (id, type, media_item_id, issued_at, issued_by, status)
          VALUES (?, ?, ?, ?, ?, ?)
        `
      )
      .run(
        command.id,
        command.type,
        command.mediaItemId ?? null,
        command.issuedAt,
        command.issuedBy,
        command.status
      );
  }

  public listPending(): PlaybackCommand[] {
    const rows = this.db
      .prepare("SELECT * FROM playback_commands WHERE status = 'pending' ORDER BY issued_at")
      .all() as unknown as CommandRow[];

    return rows.map(mapCommandRow);
  }

  public updateStatus(id: string, status: PlaybackCommandStatus): void {
    this.db.prepare("UPDATE playback_commands SET status = ? WHERE id = ?").run(status, id);
  }
}

function mapCommandRow(row: CommandRow): PlaybackCommand {
  return {
    id: row.id,
    type: row.type,
    ...(row.media_item_id ? { mediaItemId: row.media_item_id } : {}),
    issuedAt: row.issued_at,
    issuedBy: row.issued_by,
    status: row.status
  };
}
