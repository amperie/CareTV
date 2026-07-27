import type { Playlist, PlaylistItem } from "@caretv/core";

import type { CareTvDatabase } from "./database.js";

interface PlaylistRow {
  id: string;
  name: string;
  created_at: string;
  updated_at: string;
}

interface PlaylistItemRow {
  playlist_id: string;
  media_item_id: string;
  position: number;
}

export class PlaylistRepository {
  public constructor(private readonly db: CareTvDatabase) {}

  public create(playlist: Playlist): void {
    this.db.exec("BEGIN IMMEDIATE;");
    try {
      this.db
        .prepare("INSERT INTO playlists (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)")
        .run(playlist.id, playlist.name, playlist.createdAt, playlist.updatedAt);
      this.replaceItems(playlist.id, playlist.items);
      this.db.exec("COMMIT;");
    } catch (error) {
      this.db.exec("ROLLBACK;");
      throw error;
    }
  }

  public update(id: string, name: string, mediaItemIds: string[], updatedAt: string): boolean {
    this.db.exec("BEGIN IMMEDIATE;");
    try {
      const result = this.db
        .prepare("UPDATE playlists SET name = ?, updated_at = ? WHERE id = ?")
        .run(name, updatedAt, id);

      if (Number(result.changes) === 0) {
        this.db.exec("COMMIT;");
        return false;
      }

      this.replaceItems(id, playlistItems(id, mediaItemIds));
      this.db.exec("COMMIT;");
      return true;
    } catch (error) {
      this.db.exec("ROLLBACK;");
      throw error;
    }
  }

  public delete(id: string): boolean {
    const result = this.db.prepare("DELETE FROM playlists WHERE id = ?").run(id);
    return Number(result.changes) > 0;
  }

  public get(id: string): Playlist | undefined {
    const row = this.db.prepare("SELECT * FROM playlists WHERE id = ?").get(id) as unknown as
      PlaylistRow | undefined;

    return row ? mapPlaylist(row, this.items(id)) : undefined;
  }

  public list(): Playlist[] {
    const rows = this.db
      .prepare("SELECT * FROM playlists ORDER BY updated_at DESC")
      .all() as unknown as PlaylistRow[];

    return rows.map((row) => mapPlaylist(row, this.items(row.id)));
  }

  private items(playlistId: string): PlaylistItem[] {
    const rows = this.db
      .prepare("SELECT * FROM playlist_items WHERE playlist_id = ? ORDER BY position ASC")
      .all(playlistId) as unknown as PlaylistItemRow[];

    return rows.map(mapPlaylistItem);
  }

  private replaceItems(playlistId: string, items: PlaylistItem[]): void {
    this.db.prepare("DELETE FROM playlist_items WHERE playlist_id = ?").run(playlistId);

    const insert = this.db.prepare(
      "INSERT INTO playlist_items (playlist_id, media_item_id, position) VALUES (?, ?, ?)"
    );

    for (const item of items) {
      insert.run(playlistId, item.mediaItemId, item.position);
    }
  }
}

export function playlistItems(playlistId: string, mediaItemIds: string[]): PlaylistItem[] {
  return mediaItemIds.map((mediaItemId, index) => ({
    playlistId,
    mediaItemId,
    position: index + 1
  }));
}

function mapPlaylist(row: PlaylistRow, items: PlaylistItem[]): Playlist {
  return {
    id: row.id,
    name: row.name,
    items,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function mapPlaylistItem(row: PlaylistItemRow): PlaylistItem {
  return {
    playlistId: row.playlist_id,
    mediaItemId: row.media_item_id,
    position: row.position
  };
}
