export function backupFileName(now = new Date()): string {
  return `sable-profiles-${now.toISOString().slice(0, 10)}.json`;
}
