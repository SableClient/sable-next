export const CATALOG_EVENT = 'fi.mau.msc4461.per_message_profiles.v3';

export function backupJson(content: unknown): string {
  return JSON.stringify({ [CATALOG_EVENT]: content }, null, 2);
}

export function backupFileName(now = new Date()): string {
  return `sable-profiles-${now.toISOString().slice(0, 10)}.json`;
}

export function parseBackup(text: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(text);
  const content: unknown =
    typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, unknown>)[CATALOG_EVENT]
      : undefined;
  if (
    typeof content !== 'object' ||
    content === null ||
    Array.isArray(content) ||
    !Array.isArray((content as { profiles?: unknown }).profiles)
  ) {
    throw new Error(`the file has no ${CATALOG_EVENT} catalog`);
  }
  return content as Record<string, unknown>;
}
