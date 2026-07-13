import type { CareTvDatabase } from "./database.js";

export class SettingsRepository {
  public constructor(private readonly db: CareTvDatabase) {}

  public set(key: string, value: Record<string, unknown>, updatedAt: string): void {
    this.db
      .prepare(
        `
          INSERT INTO settings (key, value_json, updated_at)
          VALUES (?, ?, ?)
          ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json,
                                        updated_at = excluded.updated_at
        `
      )
      .run(key, JSON.stringify(value), updatedAt);
  }

  public get(key: string): Record<string, unknown> | undefined {
    const row = this.db.prepare("SELECT value_json FROM settings WHERE key = ?").get(key) as
      { value_json: string } | undefined;

    if (!row) {
      return undefined;
    }

    const parsed: unknown = JSON.parse(row.value_json);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  }
}
