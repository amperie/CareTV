import type { ApplianceStatus, PlaybackState } from "@caretv/core";

import type { CareTvDatabase } from "./database.js";
import { parseJsonObject } from "./json.js";

interface ApplianceRow {
  id: string;
  name: string;
  last_seen_at: string;
  playback_state_json: string | null;
}

export class ApplianceRepository {
  public constructor(private readonly db: CareTvDatabase) {}

  public heartbeat(
    applianceId: string,
    name: string,
    lastSeenAt: string,
    playbackState?: PlaybackState
  ): void {
    this.db
      .prepare(
        `
          INSERT INTO appliances (id, name, last_seen_at, playback_state_json)
          VALUES (?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET name = excluded.name,
                                        last_seen_at = excluded.last_seen_at,
                                        playback_state_json = excluded.playback_state_json
        `
      )
      .run(applianceId, name, lastSeenAt, playbackState ? JSON.stringify(playbackState) : null);
  }

  public list(now: Date, staleAfterMs = 15_000): ApplianceStatus[] {
    const rows = this.db
      .prepare("SELECT * FROM appliances ORDER BY name")
      .all() as unknown as ApplianceRow[];

    return rows.map((row) => mapRow(row, now, staleAfterMs));
  }

  public latest(now: Date, staleAfterMs = 15_000): ApplianceStatus | undefined {
    const row = this.db
      .prepare("SELECT * FROM appliances ORDER BY last_seen_at DESC LIMIT 1")
      .get() as unknown as ApplianceRow | undefined;

    return row ? mapRow(row, now, staleAfterMs) : undefined;
  }
}

function mapRow(row: ApplianceRow, now: Date, staleAfterMs: number): ApplianceStatus {
  const state = row.playback_state_json
    ? (parseJsonObject(row.playback_state_json) as unknown as PlaybackState)
    : undefined;

  return {
    applianceId: row.id,
    name: row.name,
    connected: now.getTime() - Date.parse(row.last_seen_at) <= staleAfterMs,
    lastSeenAt: row.last_seen_at,
    ...(state ? { playbackState: state } : {})
  };
}
