export function parseJsonObject(input: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(input);
  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : {};
}

export function stringifyJson(input: Record<string, unknown>): string {
  return JSON.stringify(input);
}
