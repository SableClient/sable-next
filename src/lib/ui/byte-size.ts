const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'] as const;

export function formatByteSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '';
  if (bytes < 1000) return `${Math.round(bytes)} B`;

  let value = bytes;
  let unitIndex = 0;
  while (value >= 1000 && unitIndex < UNITS.length - 1) {
    value /= 1000;
    unitIndex += 1;
  }

  return `${value.toFixed(value < 10 ? 1 : 0)} ${UNITS[unitIndex]}`;
}
