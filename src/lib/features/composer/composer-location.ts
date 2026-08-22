function round(value: number): string {
  return String(Number(value.toFixed(6)));
}

export function geoUriFor(latitude: number, longitude: number): string | null {
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  if (latitude < -90 || latitude > 90) return null;
  if (longitude < -180 || longitude > 180) return null;

  return `geo:${round(latitude)},${round(longitude)}`;
}

export function coordinate(value: string): number {
  const trimmed = value.trim();
  return trimmed === '' ? Number.NaN : Number(trimmed);
}
